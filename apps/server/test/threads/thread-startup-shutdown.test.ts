import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { expect, it, vi } from "vitest";
import { createAgentRuntime, type AgentRuntime } from "@bb/agent-runtime";
import { getLatestThreadSequence, getThread, listEvents, listQueuedThreadMessages } from "@bb/db";
import { clientTurnRequestIdSchema, executionContextSnapshotSchema } from "@bb/domain";
import type { AgentRuntimeBridgeLaunch } from "@bb/agent-runtime";
import { spawnManagedProcess } from "@bb/process-utils";
import { createDeferredPromise } from "@bb/test-helpers";
import { RuntimeManager } from "../../../host-daemon/src/runtime-manager.js";
import { createFakeWorkspace } from "../../../host-daemon/src/test/runtime-manager-workspace.js";
import { MemoryBridge } from "../../../../packages/agent-runtime/src/test/memory-startup-bridge.js";
import { applyLoggedThreadLifecycleEvent } from "../../src/services/threads/lifecycle-outcome.js";
import { retryFailedTurn } from "../../src/services/threads/turn-retry.js";
import { toThreadQueuedMessage } from "../../src/services/threads/thread-queued-messages.js";
import { seedEnvironment, seedHostSession, seedProjectWithSource, seedStoredEvent, seedThread, seedThreadRuntimeState } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

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
