import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { expect, it, vi } from "vitest";
import { createAgentRuntime, type AgentRuntime } from "@bb/agent-runtime";
import { createConnection, getLatestThreadSequence, getThread, listEvents, listQueuedThreadMessages } from "@bb/db";
import { clientTurnRequestIdSchema, executionContextSnapshotSchema } from "@bb/domain";
import type { AgentRuntimeBridgeLaunch } from "@bb/agent-runtime";
import { spawnManagedProcess } from "@bb/process-utils";
import { createDeferredPromise } from "@bb/test-helpers";
import { RuntimeManager } from "../../../apps/host-daemon/src/runtime-manager.js";
import { createFakeWorkspace } from "../../../apps/host-daemon/src/test/runtime-manager-workspace.js";
import { MemoryBridge } from "@bb/agent-runtime/test";
import { applyLoggedThreadLifecycleEvent } from "../../../apps/server/src/services/threads/lifecycle-outcome.js";
import { retryFailedTurn } from "../../../apps/server/src/services/threads/turn-retry.js";
import { toThreadQueuedMessage } from "../../../apps/server/src/services/threads/thread-queued-messages.js";
import { seedEnvironment, seedHostSession, seedProjectWithSource, seedStoredEvent, seedThread, seedThreadRuntimeState } from "../../../apps/server/test/helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../../../apps/server/test/helpers/test-app.js";

vi.mock("@bb/process-utils", async (importOriginal) => ({
  ...await importOriginal<typeof import("@bb/process-utils")>(),
  spawnManagedProcess: vi.fn(),
}));

const requestDataSchema = z.object({ requestId: clientTurnRequestIdSchema });
const removals = ["idle eviction", "shell replacement", "skill replacement", "forget"] as const;
const terminations = ["confirmed", "unverified", "rejected"] as const;
const scenarios = removals.flatMap((removal) => terminations.map((termination) => ({ removal, termination })));

function observe<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
}

it.each(scenarios)("retains ownership and durable retry safety through $removal with $termination cleanup", async ({ removal, termination }) => {
  await withTestHarness(async (harness) => {
    const { host } = seedHostSession(harness.deps);
    const workspacePath = join(harness.config.dataDir, "owned-shutdown-workspace");
    const { project } = seedProjectWithSource(harness.deps, { hostId: host.id, path: workspacePath });
    const environment = seedEnvironment(harness.deps, { hostId: host.id, projectId: project.id, path: workspacePath });
    const thread = seedThread(harness.deps, { environmentId: environment.id, projectId: project.id, providerId: "codex", status: "active" });
    const workspace = createFakeWorkspace(workspacePath, false);
    const skillPath = join(harness.config.dataDir, "owned-shutdown-skill");
    mkdirSync(skillPath);
    writeFileSync(join(skillPath, "SKILL.md"), "---\nname: shutdown-fixture\ndescription: Owned shutdown regression fixture\n---\n\nSynthetic fixture instructions.\n");
    const skill = {
      kind: "workspace-path" as const, sourceType: "project" as const,
      name: "shutdown-fixture", description: "Owned shutdown regression fixture",
      sourceRootPath: skillPath, skillFilePath: join(skillPath, "SKILL.md"),
    };
    const args = {
      environmentId: environment.id, workspacePath,
      ...(removal === "skill replacement" ? { injectedSkillSources: [skill] } : {}),
    };
    const ensureArgs = removal === "skill replacement" ? { ...args, injectedSkillSources: [] } : args;
    const createdRuntimes: AgentRuntime[] = [];
    const bridge = new MemoryBridge();
    bridge.readyOnConstruction = false;
    const cleanup = createDeferredPromise<void>();
    const launch: AgentRuntimeBridgeLaunch = {
      pluginId: "memory-startup-fixture", dataDir: join(harness.config.dataDir, "bridge-data"),
      source: { kind: "artifact", digest: "memory-startup-fixture", artifactPath: "/memory-fixture/bridge.mjs" },
      capabilities: { providerInstallation: false, supportsServiceTier: false, permissionModes: ["full"], supportsThreadArchive: false, supportsThreadRename: false, fork: "checkpoint" },
      providerOptions: {}, envPassthrough: [],
    };
    const options: Parameters<AgentRuntime["startThread"]>[0]["options"] = {
      model: "fixture", serviceTier: "default", reasoningLevel: "medium",
      permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null,
      providerOptions: { executionContext: executionContextSnapshotSchema.parse({
        id: "owned-shutdown-context", name: "Fixture", createdAt: 1, updatedAt: 1,
        startupPolicy: { deadlineMs: 1_000, optionalMcpServers: [] },
      }) },
    };
    const manager = new RuntimeManager({
      dataDir: harness.config.dataDir,
      shellEnv: { PATH: "/fixture/original" },
      bridgeBundleDir: "/memory-fixture",
      provisionWorkspace: async () => workspace,
      createRuntime: (runtimeOptions) => {
        const runtime = createAgentRuntime(runtimeOptions);
        createdRuntimes.push(runtime);
        return runtime;
      },
      onEvent: ({ event }) => {
        if (event.threadId !== thread.id || event.type !== "system/operation" || event.operation !== "provider_startup") return;
        seedStoredEvent(harness.deps, {
          threadId: thread.id, environmentId: environment.id,
          sequence: getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
          type: event.type, scope: event.scope,
          data: { operation: event.operation, operationId: event.operationId, status: event.status, message: event.message, metadata: event.metadata },
        });
      },
    });
    const signal = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("Whole-runtime shutdown regressions must never signal processes");
    });
    vi.mocked(spawnManagedProcess).mockReturnValue({ child: bridge, stop: bridge.stop });
    vi.useFakeTimers();
    try {
      const original = await manager.ensureEnvironment(args);
      const construction = observe(original.runtime.startThread({
        environmentId: environment.id, projectId: project.id, threadId: thread.id,
        providerId: "codex", bridgeLaunch: launch, options,
      }));
      await vi.advanceTimersByTimeAsync(0);
      const constructed = await construction;
      if (constructed.status !== "fulfilled") throw constructed.error;
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id, threadId: thread.id, providerThreadId: constructed.value.providerThreadId,
        sequenceStart: getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
      });
      const requestEvent = listEvents(harness.db, { threadId: thread.id }).find((event) => event.type === "client/turn/requested");
      if (!requestEvent) throw new Error("Fixture has no original request");
      const { requestId } = requestDataSchema.parse(JSON.parse(requestEvent.data));
      const turn = observe(original.runtime.runTurn({
        threadId: thread.id, clientRequestId: requestId, options,
        input: [{ type: "text", text: "Owned synthetic request", mentions: [] }],
      }));
      await vi.advanceTimersByTimeAsync(0);
      expect(await turn).toMatchObject({ status: "fulfilled" });
      bridge.completeTurn(thread.id);
      await vi.advanceTimersByTimeAsync(0);
      expect(original.runtime.getActiveTurnId(thread.id)).toBeNull();
      expect(original.runtime.hasOpenBackgroundWork()).toBe(false);
      const ready = listEvents(harness.db, { threadId: thread.id }).filter((event) => event.type === "system/operation").at(-1);
      expect(JSON.parse(ready?.data ?? "null")).toMatchObject({
        operation: "provider_startup", status: "completed", metadata: { phase: "ready", retryBlocked: false },
      });
      applyLoggedThreadLifecycleEvent(harness.deps, { event: { type: "run.failed" }, threadId: thread.id });

      if (removal === "shell replacement") {
        manager.markTerminalActive(environment.id, "owned-fixture-terminal");
        await manager.replaceBaseShellEnv({ PATH: "/fixture/replacement" });
        manager.markTerminalInactive(environment.id, "owned-fixture-terminal");
      }
      bridge.stopGate = cleanup.promise;
      bridge.treeTermination = termination === "unverified" ? "unverified" : "confirmed";
      const retiring = observe((async () => {
        if (removal === "idle eviction") await manager.replaceBaseShellEnv({ PATH: "/fixture/replacement" });
        else if (removal === "forget") await manager.forgetEnvironment(environment.id);
        else await manager.ensureEnvironment(ensureArgs);
      })());
      await vi.advanceTimersByTimeAsync(0);
      expect(bridge.stopRequested).toBe(true);
      if (termination !== "confirmed") {
        expect.soft(manager.get(environment.id)).toBe(original);
        expect.soft(original.runtime.hasThread(thread.id)).toBe(true);
        expect.soft(original.runtime.hasOpenBackgroundWork()).toBe(true);
      }
      if (termination === "rejected") cleanup.reject(new Error("Synthetic owned cleanup failure"));
      else cleanup.resolve();
      await vi.advanceTimersByTimeAsync(0);
      const retired = await retiring;
      if (termination === "confirmed") {
        expect(retired).toMatchObject({ status: "fulfilled" });
        const replacement = await manager.ensureEnvironment(ensureArgs);
        expect(replacement.runtime).not.toBe(original.runtime);
        expect(original.runtime.hasThread(thread.id)).toBe(false);
      } else {
        expect(retired).toMatchObject({ status: "rejected" });
        expect.soft(manager.get(environment.id)).toBe(original);
        expect.soft(original.runtime.hasThread(thread.id)).toBe(true);
        expect.soft(original.runtime.hasOpenBackgroundWork()).toBe(true);
        const ensured = await observe(manager.ensureEnvironment(ensureArgs));
        expect.soft(ensured.status === "rejected" || ensured.value.runtime === original.runtime).toBe(true);
        expect.soft(createdRuntimes).toEqual([original.runtime]);
      }
      const failedThread = getThread(harness.db, thread.id);
      if (!failedThread) throw new Error("Fixture thread disappeared");
      const retry = retryFailedTurn(harness.deps, {
        thread: failedThread,
        request: { turnRequestId: requestId, sendAt: Date.now() + 60_000, reason: "Retry after runtime retirement" },
      });
      if (termination === "confirmed") {
        await expect(retry).resolves.toMatchObject({ delivery: "queued", turnRequestId: requestId });
        expect(listQueuedThreadMessages(harness.db, thread.id).map((row) => toThreadQueuedMessage(row).payload)).toEqual([
          expect.objectContaining({ kind: "retry", retryOfTurnRequestId: requestId }),
        ]);
      } else {
        await expect.soft(retry).rejects.toMatchObject({ status: 409, body: { code: "provider_startup_stop_unverified" } });
        expect.soft(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
      }
      expect(listEvents(harness.db, { threadId: thread.id }).filter((event) => event.type === "client/turn/requested").map((event) => requestDataSchema.parse(JSON.parse(event.data)).requestId)).toEqual([requestId]);
    } finally {
      cleanup.resolve();
      bridge.treeTermination = "confirmed";
      for (const runtime of createdRuntimes) await runtime.shutdown().catch(() => undefined);
      bridge.finish();
      bridge.stdin.destroy();
      bridge.stdout.destroy();
      bridge.stderr.destroy();
      vi.clearAllTimers();
      vi.useRealTimers();
      signal.mockRestore();
      vi.restoreAllMocks();
      vi.mocked(spawnManagedProcess).mockReset();
    }
  });
});

function createOwnedLifecycleFixture(harness: TestAppHarness) {
  const { host } = seedHostSession(harness.deps);
  const workspacePath = join(harness.config.dataDir, "owned-lifecycle-workspace");
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id, path: workspacePath });
  const environment = seedEnvironment(harness.deps, { hostId: host.id, projectId: project.id, path: workspacePath });
  const thread = seedThread(harness.deps, { environmentId: environment.id, projectId: project.id, providerId: "codex", status: "active" });
  const workspace = createFakeWorkspace(workspacePath, false);
  const bridges: MemoryBridge[] = [];
  const runtimes: AgentRuntime[] = [];
  const releaseGates: Array<() => void> = [];
  const exits: { expected: boolean; threadIds: string[] }[] = [];
  const nextBridge = () => {
    const bridge = new MemoryBridge();
    bridge.readyOnConstruction = false;
    bridges.push(bridge);
    vi.mocked(spawnManagedProcess).mockReturnValue({ child: bridge, stop: bridge.stop });
    return bridge;
  };
  const first = nextBridge();
  const launch: AgentRuntimeBridgeLaunch = {
    pluginId: "memory-startup-fixture", dataDir: join(harness.config.dataDir, "lifecycle-bridge-data"),
    source: { kind: "artifact", digest: "memory-startup-fixture", artifactPath: "/memory-fixture/bridge.mjs" },
    capabilities: { providerInstallation: false, supportsServiceTier: false, permissionModes: ["full"], supportsThreadArchive: false, supportsThreadRename: false, fork: "checkpoint" },
    providerOptions: {}, envPassthrough: [],
  };
  const options: Parameters<AgentRuntime["startThread"]>[0]["options"] = {
    model: "fixture", serviceTier: "default", reasoningLevel: "medium",
    permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null,
    providerOptions: { executionContext: executionContextSnapshotSchema.parse({
      id: "owned-lifecycle-context", name: "Fixture", createdAt: 1, updatedAt: 1,
      startupPolicy: { deadlineMs: 1_000, optionalMcpServers: [] },
    }) },
  };
  const manager = new RuntimeManager({
    dataDir: harness.config.dataDir, shellEnv: { PATH: "/fixture/original" }, bridgeBundleDir: "/memory-fixture",
    provisionWorkspace: async () => workspace,
    createRuntime: (runtimeOptions) => {
      const runtime = createAgentRuntime({
        ...runtimeOptions,
        onProcessExit: (event) => {
          exits.push({ expected: event.expected, threadIds: event.threads.map((entry) => entry.threadId) });
          runtimeOptions.onProcessExit?.(event);
        },
      });
      runtimes.push(runtime);
      return runtime;
    },
    onEvent: ({ event }) => {
      if (event.type !== "system/operation" || event.operation !== "provider_startup") return;
      seedStoredEvent(harness.deps, {
        threadId: event.threadId, environmentId: environment.id,
        sequence: getLatestThreadSequence(harness.db, { threadId: event.threadId }) + 1,
        type: event.type, scope: event.scope,
        data: { operation: event.operation, operationId: event.operationId, status: event.status, message: event.message, metadata: event.metadata },
      });
    },
  });
  const args = { environmentId: environment.id, workspacePath };
  const input = [{ type: "text" as const, text: "Owned lifecycle request", mentions: [] }];
  const ready = async () => {
    const entry = await manager.ensureEnvironment(args);
    const construction = observe(entry.runtime.startThread({
      environmentId: environment.id, projectId: project.id, threadId: thread.id,
      providerId: "codex", bridgeLaunch: launch, options,
    }));
    await vi.advanceTimersByTimeAsync(0);
    const constructed = await construction;
    if (constructed.status !== "fulfilled") throw constructed.error;
    seedThreadRuntimeState(harness.deps, {
      environmentId: environment.id, threadId: thread.id, providerThreadId: constructed.value.providerThreadId,
      sequenceStart: getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
    });
    const requested = listEvents(harness.db, { threadId: thread.id }).find((event) => event.type === "client/turn/requested");
    if (!requested) throw new Error("Owned lifecycle fixture has no original request");
    const { requestId } = requestDataSchema.parse(JSON.parse(requested.data));
    const turn = observe(entry.runtime.runTurn({ threadId: thread.id, clientRequestId: requestId, options, input }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await turn).toMatchObject({ status: "fulfilled" });
    expect(entry.runtime.getProviderSession(thread.id)).toMatchObject({ providerThreadId: constructed.value.providerThreadId });
    const receipt = listEvents(harness.db, { threadId: thread.id }).filter((event) => event.type === "system/operation").at(-1);
    expect(JSON.parse(receipt?.data ?? "null")).toMatchObject({ status: "completed", metadata: { phase: "ready", retryBlocked: false } });
    return { entry, requestId, providerThreadId: constructed.value.providerThreadId };
  };
  return { harness, project, environment, thread, manager, args, launch, options, input, bridges, runtimes, releaseGates, exits, first, nextBridge, ready };
}

async function withOwnedLifecycleFixture(run: (fixture: ReturnType<typeof createOwnedLifecycleFixture>) => Promise<void>): Promise<void> {
  await withTestHarness(async (harness) => {
    const fixture = createOwnedLifecycleFixture(harness);
    vi.spyOn(process, "kill").mockImplementation(() => { throw new Error("Owned lifecycle fixtures must never signal processes"); });
    vi.useFakeTimers();
    try {
      await run(fixture);
    } finally {
      for (const release of fixture.releaseGates) release();
      for (const bridge of fixture.bridges) bridge.discardMode = "success";
      await vi.advanceTimersByTimeAsync(0);
      for (const runtime of fixture.runtimes) await runtime.shutdown().catch(() => undefined);
      for (const bridge of fixture.bridges) {
        bridge.finish();
        bridge.stdin.destroy();
        bridge.stdout.destroy();
        bridge.stderr.destroy();
      }
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.restoreAllMocks();
      vi.mocked(spawnManagedProcess).mockReset();
    }
  });
}

it.each(["confirmed", "unverified"] as const)("preserves durable retry policy after deferred restart expected exit and %s cleanup, including cold reopen", async (termination) => {
  await withOwnedLifecycleFixture(async (f) => {
    const { entry, requestId, providerThreadId } = await f.ready();
    f.first.recommendRestart(f.thread.id);
    await vi.advanceTimersByTimeAsync(0);
    f.first.completeTurn(f.thread.id);
    await vi.advanceTimersByTimeAsync(0);
    const resultGate = createDeferredPromise<void>();
    f.releaseGates.push(() => resultGate.resolve());
    f.first.stopResultGate = resultGate.promise;
    f.first.treeTermination = termination;
    const replacement = f.nextBridge();
    const nextRequestId = clientTurnRequestIdSchema.parse("creq_7777777777");
    let restartSettled = false;
    const restart = observe(entry.runtime.runTurn({ threadId: f.thread.id, options: f.options, input: f.input, clientRequestId: nextRequestId }))
      .then((result) => { restartSettled = true; return result; });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.exits).toContainEqual({ expected: true, threadIds: [f.thread.id] });
    expect(restartSettled).toBe(false);
    resultGate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(await restart).toMatchObject({ status: termination === "confirmed" ? "fulfilled" : "rejected" });
    expect(replacement.requests.filter((request) => request.method === "turn/start").map((request) => request.params?.clientRequestId))
      .toEqual(termination === "confirmed" ? [nextRequestId] : []);
    if (termination === "confirmed") expect(entry.runtime.getProviderSession(f.thread.id)).toMatchObject({ providerThreadId });
    applyLoggedThreadLifecycleEvent(f.harness.deps, { event: { type: "run.failed" }, threadId: f.thread.id });
    const databasePath = join(f.harness.config.dataDir, "cold-restart.sqlite");
    writeFileSync(databasePath, f.harness.db.$client.serialize());
    const reopened = createConnection(databasePath);
    try {
      const failed = getThread(reopened, f.thread.id);
      if (!failed) throw new Error("Cold reopen lost the original thread");
      const retry = retryFailedTurn({ ...f.harness.deps, db: reopened }, {
        thread: failed,
        request: { turnRequestId: requestId, sendAt: Date.now() + 60_000, reason: "Retry after cold restart cleanup" },
      });
      if (termination === "confirmed") {
        await expect(retry).resolves.toMatchObject({ delivery: "queued", turnRequestId: requestId });
        expect(listQueuedThreadMessages(reopened, f.thread.id).map((row) => toThreadQueuedMessage(row).payload)).toEqual([
          expect.objectContaining({ kind: "retry", retryOfTurnRequestId: requestId }),
        ]);
      } else {
        await expect.soft(retry).rejects.toMatchObject({ status: 409, body: { code: "provider_startup_stop_unverified" } });
        const receipt = listEvents(reopened, { threadId: f.thread.id }).filter((event) => event.type === "system/operation").at(-1);
        expect.soft(JSON.parse(receipt?.data ?? "null")).toMatchObject({ status: "failed", metadata: { code: "provider_startup_stop_unverified", retryBlocked: true } });
        expect.soft(listQueuedThreadMessages(reopened, f.thread.id)).toEqual([]);
      }
      expect(listEvents(reopened, { threadId: f.thread.id }).filter((event) => event.type === "client/turn/requested")
        .map((event) => requestDataSchema.parse(JSON.parse(event.data)).requestId)).toEqual([requestId]);
    } finally {
      reopened.$client.close();
    }
  });
});

it.each(["ensure", "command retention", "obtained handle"] as const)("serializes or refuses new work admitted through %s while runtime retirement owns its snapshot", async (admissionPath) => {
  await withOwnedLifecycleFixture(async (f) => {
    const { entry, requestId } = await f.ready();
    f.first.completeTurn(f.thread.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(entry.runtime.hasOpenBackgroundWork()).toBe(false);
    const cleanup = createDeferredPromise<void>();
    f.releaseGates.push(() => cleanup.resolve());
    f.first.stopGate = cleanup.promise;
    const retiring = observe(f.manager.replaceBaseShellEnv({ PATH: "/fixture/replacement" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.first.stopRequested).toBe(true);
    const nextThread = seedThread(f.harness.deps, {
      environmentId: f.environment.id, projectId: f.project.id, providerId: "codex", status: "active",
    });
    const next = f.nextBridge();
    const nextRequestId = clientTurnRequestIdSchema.parse("creq_8888888888");
    const startNext = async (runtime: AgentRuntime) => {
      const started = await runtime.startThread({
        environmentId: f.environment.id, projectId: f.project.id, threadId: nextThread.id,
        providerId: "codex", bridgeLaunch: f.launch, options: f.options, input: f.input, clientRequestId: nextRequestId,
      });
      return { runtime, providerThreadId: started.providerThreadId };
    };
    const admission = observe((async () => {
      if (admissionPath === "ensure") return startNext((await f.manager.ensureEnvironment(f.args)).runtime);
      if (admissionPath === "command retention") {
        const release = await f.manager.retainEnvironmentForThreadCommand(f.environment.id, nextThread.id);
        try {
          return await startNext(entry.runtime);
        } finally {
          release();
        }
      }
      return startNext(entry.runtime);
    })());
    await vi.advanceTimersByTimeAsync(0);
    expect.soft(next.requests.filter((request) => request.method === "thread/start" || request.method === "turn/start")).toEqual([]);
    cleanup.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(await retiring).toMatchObject({ status: "fulfilled" });
    let admitted = await admission;
    if (admitted.status === "rejected") {
      const fresh = await f.manager.ensureEnvironment(f.args);
      const retried = observe(startNext(fresh.runtime));
      await vi.advanceTimersByTimeAsync(0);
      admitted = await retried;
    }
    if (admitted.status !== "fulfilled") throw admitted.error;
    expect.soft(admitted.value.runtime).not.toBe(entry.runtime);
    expect.soft(next.stopped).toBe(false);
    expect.soft(admitted.value.runtime.getProviderSession(nextThread.id)).toMatchObject({ providerThreadId: admitted.value.providerThreadId });
    expect(next.requests.filter((request) => request.method === "turn/start").map((request) => request.params?.clientRequestId)).toEqual([nextRequestId]);
    expect(f.first.requests.filter((request) => request.method === "turn/start").map((request) => request.params?.clientRequestId)).toEqual([requestId]);
  });
});
