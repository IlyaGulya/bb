import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clientTurnRequestIdSchema, executionContextSnapshotSchema, type ThreadEvent } from "@bb/domain";
import { spawnManagedProcess } from "@bb/process-utils";
import { createAgentRuntime } from "./runtime.js";
import type { AgentRuntime, AgentRuntimeBridgeLaunch, AgentRuntimeExecutionOptions } from "./types.js";
import { MemoryBridge } from "./test/memory-startup-bridge.js";

vi.mock("@bb/process-utils", async (importOriginal) => ({
  ...await importOriginal<typeof import("@bb/process-utils")>(),
  spawnManagedProcess: vi.fn(),
}));


const launch: AgentRuntimeBridgeLaunch = {
  pluginId: "memory-startup-fixture", dataDir: "/memory-fixture/data",
  source: { kind: "artifact", digest: "memory-startup-fixture", artifactPath: "/memory-fixture/bridge.mjs" },
  capabilities: { providerInstallation: false, supportsServiceTier: false, permissionModes: ["accept-edits", "full"], supportsThreadArchive: false, supportsThreadRename: false, fork: "checkpoint" },
  providerOptions: {}, envPassthrough: [],
};
const options: AgentRuntimeExecutionOptions = {
  model: "fixture", serviceTier: "default", reasoningLevel: "medium",
  permissionMode: "accept-edits", permissionScope: "workspace", approvalReviewer: "user", permissionEscalation: "ask",
  providerOptions: { executionContext: executionContextSnapshotSchema.parse({
    id: "fixture-context", name: "Fixture", createdAt: 1, updatedAt: 1,
    startupPolicy: { deadlineMs: 1_000, optionalMcpServers: [] },
  }) },
};
const input = [{ type: "text" as const, text: "Synthetic request", mentions: [] }];
const runtimes: AgentRuntime[] = [];
const bridges: MemoryBridge[] = [];

function setup() {
  const events: ThreadEvent[] = [];
  const first = new MemoryBridge();
  bridges.push(first);
  vi.mocked(spawnManagedProcess).mockReturnValue({ child: first, stop: first.stop });
  const runtime = createAgentRuntime({
    workspacePath: "/memory-fixture", bridgeBundleDir: "/memory-fixture",
    onToolCall: async () => { throw new Error("The startup fixture must not invoke tools"); },
    rateLimitRetry: { delaysMs: [2_000] }, onEvent: (event) => events.push(event),
  });
  runtimes.push(runtime);
  const start = (withInput = false) => runtime.startThread({
    threadId: "same-thread", environmentId: "fixture-env", providerId: "fixture", bridgeLaunch: launch, options,
    projectId: "fixture-project",
    ...(withInput ? { input, clientRequestId: clientTurnRequestIdSchema.parse("creq_2222222222") } : {}),
  });
  return { first, runtime, events, start };
}

function prepareRewind(runtime: AgentRuntime, leaseId: string) {
  return runtime.prepareThreadRewind({
    environmentId: "fixture-env", threadId: "same-thread", leaseId,
    projectId: "fixture-project",
    providerId: "fixture", bridgeLaunch: launch, options,
    sourceProviderThreadId: "source-before-edit", retainThroughProviderCheckpoint: "checkpoint-before-edit",
  });
}

function observe<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw new Error("Startup boundary regressions must never signal processes");
  });
});

afterEach(async () => {
  try {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
  } finally {
    for (const bridge of bridges.splice(0)) {
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

describe("bounded startup consumer boundaries without subprocesses", () => {
  it.each(["cancel", "timeout"] as const)("does not replay a %sled rate-limit request into a same-thread replacement", async (interruption) => {
    const f = setup();
    f.first.readyOnConstruction = false;
    f.first.rateLimitedTurns = 1;
    const oldAttempt = observe(f.start(true));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.first.requests.filter((request) => request.method === "turn/start").map((request) => request.params?.clientRequestId)).toEqual(["creq_2222222222"]);
    if (interruption === "cancel") await f.runtime.stopThread({ threadId: "same-thread" });
    else await vi.advanceTimersByTimeAsync(1_000);
    expect(await oldAttempt).toMatchObject({ status: "rejected", error: {
      code: interruption === "cancel" ? "provider_startup_cancelled" : "provider_startup_timeout",
    } });
    expect(f.first.stopped).toBe(true);

    const replacement = new MemoryBridge();
    bridges.push(replacement);
    vi.mocked(spawnManagedProcess).mockReturnValue({ child: replacement, stop: replacement.stop });
    const retried = observe(f.runtime.startThread({
      threadId: "same-thread", environmentId: "fixture-env", providerId: "fixture", bridgeLaunch: launch, options,
      projectId: "fixture-project",
      input, clientRequestId: clientTurnRequestIdSchema.parse("creq_3333333333"),
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await retried).toMatchObject({ status: "fulfilled", value: { providerThreadId: "native-same-thread" } });
    const activeTurn = f.runtime.getActiveTurnId("same-thread");
    if (activeTurn === null) throw new Error("Replacement request did not establish an active turn");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(replacement.requests.filter((request) => request.method === "turn/start").map((request) => request.params?.clientRequestId)).toEqual(["creq_3333333333"]);
    expect(f.runtime.getActiveTurnId("same-thread")).toBe(activeTurn);
    expect(f.runtime.getProviderSession("same-thread")).toMatchObject({ providerThreadId: "native-same-thread" });
  });

  it.each(["start", "resume"] as const)("retains the original deadline after a %s construction receipt until native readiness", async (method) => {
    const f = setup();
    f.first.readyOnConstruction = false;
    const construction = observe(method === "start" ? f.start() : f.runtime.resumeThread({
      threadId: "same-thread", environmentId: "fixture-env", providerId: "fixture", bridgeLaunch: launch, options,
      projectId: "fixture-project",
      providerThreadId: "native-same-thread",
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.first.requests.some((request) => request.method === `thread/${method}`)).toBe(true);
    expect(f.events.filter((event) => event.type === "system/operation" && event.operation === "provider_startup" && event.status === "completed")).toEqual([]);
    await vi.advanceTimersByTimeAsync(600);
    f.first.deferTurn = true;
    const turn = observe(f.runtime.runTurn({ threadId: "same-thread", input, options,
      clientRequestId: clientTurnRequestIdSchema.parse("creq_4444444444"),
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.first.requests.some((request) => request.method === "turn/start")).toBe(true);
    await vi.advanceTimersByTimeAsync(400);
    expect(f.first.stopped).toBe(true);
    expect(f.events).toContainEqual(expect.objectContaining({
      type: "system/operation", status: "failed", metadata: expect.objectContaining({ code: "provider_startup_timeout" }),
    }));
    expect(await turn).toMatchObject({ status: "rejected" });
    await construction;
  });

  it("ends the deadline at native readiness without timing out subsequent model generation", async () => {
    const f = setup();
    f.first.readyOnConstruction = false;
    f.first.deferTurn = true;
    const started = observe(f.start(true));
    await vi.advanceTimersByTimeAsync(0);
    const turnRequest = f.first.requests.find((request) => request.method === "turn/start");
    if (!turnRequest) throw new Error("Fixture did not receive initial input");
    await vi.advanceTimersByTimeAsync(600);
    f.first.acceptTurn(turnRequest);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.first.stopped).toBe(false);
    expect(f.events).toContainEqual(expect.objectContaining({
      type: "system/operation", status: "completed", metadata: expect.objectContaining({ phase: "ready" }),
    }));
    expect(f.events.filter((event) => event.type === "system/operation" && event.status === "failed")).toEqual([]);
    expect(await started).toMatchObject({ status: "fulfilled", value: { providerThreadId: "native-same-thread" } });
  });

  it("bounds native replacement initiated by a permission-escalating steer and awaits owned cleanup", async () => {
    const f = setup();
    const started = observe(f.start(true));
    await vi.advanceTimersByTimeAsync(0);
    expect(await started).toMatchObject({ status: "fulfilled" });
    const activeTurnId = f.runtime.getActiveTurnId("same-thread");
    if (activeTurnId === null) throw new Error("Initial request did not establish an active turn before steering");
    f.first.replaceOnFullSteer = true;
    let releaseCleanup!: () => void;
    f.first.stopGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let steerSettled = false;
    try {
      const steered = observe(f.runtime.steerTurn({
        threadId: "same-thread", expectedTurnId: activeTurnId, input,
        clientRequestId: clientTurnRequestIdSchema.parse("creq_5555555555"),
        options: { ...options, permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null },
      })).then((result) => { steerSettled = true; return result; });
      await vi.advanceTimersByTimeAsync(0);
      expect(f.first.requests.find((request) => request.method === "turn/steer")?.params?.options).toMatchObject({ permissionMode: "full" });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.first.stopRequested).toBe(true);
      expect(f.first.stopped).toBe(false);
      expect(steerSettled).toBe(false);
      releaseCleanup();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.first.stopped).toBe(true);
      expect(await steered).toMatchObject({ status: "rejected", error: { code: "provider_startup_timeout" } });
      expect(f.events).toContainEqual(expect.objectContaining({
        type: "system/operation", status: "failed", metadata: expect.objectContaining({ phase: "stopped", retryBlocked: false }),
      }));
      expect(f.runtime.getProviderSession("same-thread")).toBeNull();
    } finally {
      releaseCleanup();
    }
  });

  it.each(["parent stop", "lease discard"] as const)("cancels owned staged startup through %s, drains cleanup, and preserves a sibling", async (action) => {
    const f = setup();
    const sibling = f.first;
    sibling.readyOnConstruction = false;
    const siblingStarted = observe(f.runtime.startThread({
      environmentId: "fixture-env", threadId: "unrelated-thread", providerId: "fixture", bridgeLaunch: launch, options, input,
      projectId: "fixture-project",
      clientRequestId: clientTurnRequestIdSchema.parse("creq_6666666666"),
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await siblingStarted).toMatchObject({ status: "fulfilled" });
    const siblingTurn = f.runtime.getActiveTurnId("unrelated-thread");
    if (siblingTurn === null) throw new Error("Fixture sibling has no active turn");

    const staged = new MemoryBridge();
    staged.readyOnConstruction = false;
    staged.deferConstruction = true;
    bridges.push(staged);
    vi.mocked(spawnManagedProcess).mockReturnValue({ child: staged, stop: staged.stop });
    let releaseCleanup!: () => void;
    staged.stopGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const prepared = observe(prepareRewind(f.runtime, "owned-cancellation-lease"));
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(staged.requests.some((request) => request.method === "thread/fork")).toBe(true);
      expect(f.runtime.getLiveThreadIds()).toContain("same-thread");
      expect(f.runtime.hasThread("same-thread")).toBe(true);
      let cancellationSettled = false;
      const cancellation = observe((async () => {
        if (action === "parent stop") await f.runtime.stopThread({ threadId: "same-thread" });
        else await f.runtime.discardThreadRewind({ leaseId: "owned-cancellation-lease" });
      })()).then((result) => { cancellationSettled = true; return result; });
      await vi.advanceTimersByTimeAsync(0);
      expect(staged.stopRequested).toBe(true);
      expect(staged.stopped).toBe(false);
      expect(cancellationSettled).toBe(false);
      expect(sibling.stopped).toBe(false);
      expect(f.runtime.getActiveTurnId("unrelated-thread")).toBe(siblingTurn);

      releaseCleanup();
      await vi.advanceTimersByTimeAsync(0);
      expect(await cancellation).toMatchObject({ status: "fulfilled" });
      expect(await prepared).toMatchObject({ status: "rejected", error: { code: "provider_startup_cancelled" } });
      expect(staged.stopped).toBe(true);
      expect(f.runtime.hasThread("same-thread")).toBe(false);
      expect(f.runtime.getLiveThreadIds()).not.toContain("same-thread");
      expect(staged.requests.filter((request) => request.method === "turn/start" || request.method === "turn/steer")).toEqual([]);

      const replacement = new MemoryBridge();
      replacement.readyOnConstruction = false;
      bridges.push(replacement);
      vi.mocked(spawnManagedProcess).mockReturnValue({ child: replacement, stop: replacement.stop });
      const retried = observe(f.start(true));
      await vi.advanceTimersByTimeAsync(0);
      const resumed = await retried;
      expect(resumed).toMatchObject({ status: "fulfilled" });
      if (resumed.status === "fulfilled") expect(f.runtime.getProviderSession("same-thread")).toMatchObject({ providerThreadId: resumed.value.providerThreadId });
      expect(replacement.requests.filter((request) => request.method === "turn/start").map((request) => request.params?.clientRequestId)).toEqual(["creq_2222222222"]);
      expect(sibling.stopped).toBe(false);
      expect(f.runtime.getActiveTurnId("unrelated-thread")).toBe(siblingTurn);
    } finally {
      releaseCleanup();
    }
  });

  it.each(["native-init", "session-created"] as const)("prepares a %s fork without a model turn or fabricated native readiness", async (readiness) => {
    const f = setup();
    f.first.readyOnConstruction = false;
    f.first.startupReadiness = readiness;
    let constructionPrepared = false;
    const prepared = observe(prepareRewind(f.runtime, "nonexecuting-fork-lease")).then((result) => {
      constructionPrepared = result.status === "fulfilled";
      return result;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.first.requests.some((request) => request.method === "thread/fork")).toBe(true);
    expect.soft(constructionPrepared).toBe(true);
    expect(f.first.requests.filter((request) => request.method === "turn/start" || request.method === "turn/steer")).toEqual([]);
    expect(f.events.filter((event) => event.type === "system/operation" && event.metadata?.phase === "ready")).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect.soft(f.first.stopped).toBe(false);
    expect(await prepared).toMatchObject({ status: "fulfilled" });
    await f.runtime.discardThreadRewind({ leaseId: "nonexecuting-fork-lease" });
    expect(f.first.stopped).toBe(true);
    expect(f.first.requests.filter((request) => request.method === "turn/start" || request.method === "turn/steer")).toEqual([]);
  });

  it.each(["bounded", "null", "omitted"] as const)("resumes a deferred native restart under the next turn with %s policy", async (policy) => {
    const f = setup();
    f.first.readyOnConstruction = false;
    const execOpts: AgentRuntimeExecutionOptions = {
      ...options,
      providerOptions: { executionContext: executionContextSnapshotSchema.parse({
        id: "restart-context", name: "Fixture", createdAt: 1, updatedAt: 1,
        ...(policy === "bounded" ? { startupPolicy: { deadlineMs: 1000, optionalMcpServers: [] } } : policy === "null" ? { startupPolicy: null } : {}),
      }) },
    };
    const first = observe(f.runtime.startThread({
      environmentId: "fixture-env", threadId: "same-thread", providerId: "fixture", bridgeLaunch: launch,
      projectId: "fixture-project",
      options: execOpts, input, clientRequestId: clientTurnRequestIdSchema.parse("creq_6666666666"),
    }));
    await vi.advanceTimersByTimeAsync(0);
    const firstResult = await first;
    if (firstResult.status !== "fulfilled") throw firstResult.error;
    const initialTurn = f.runtime.getActiveTurnId("same-thread");
    if (initialTurn === null) throw new Error("Fixture has no active turn for a deferred recommendation");
    f.first.recommendRestart("same-thread");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.first.stopped).toBe(false);
    expect(f.runtime.getActiveTurnId("same-thread")).toBe(initialTurn);
    f.first.completeTurn("same-thread");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.runtime.getActiveTurnId("same-thread")).toBeNull();
    expect(f.first.stopped).toBe(false);

    const replacement = new MemoryBridge();
    replacement.readyOnConstruction = false;
    bridges.push(replacement);
    vi.mocked(spawnManagedProcess).mockReturnValue({ child: replacement, stop: replacement.stop });
    const next = observe(f.runtime.runTurn({
      threadId: "same-thread", options: execOpts, input,
      clientRequestId: clientTurnRequestIdSchema.parse("creq_7777777777"),
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await next).toMatchObject({ status: "fulfilled" });
    expect(f.first.stopped).toBe(true);
    expect(replacement.stopped).toBe(false);
    expect(replacement.requests.filter((request) => request.method === "thread/resume").map((request) => request.params?.providerThreadId)).toEqual([firstResult.value.providerThreadId]);
    expect(replacement.requests.filter((request) => request.method === "turn/start").map((request) => request.params?.clientRequestId)).toEqual(["creq_7777777777"]);
    expect(f.runtime.getProviderSession("same-thread")).toMatchObject({ providerThreadId: firstResult.value.providerThreadId });
    const continuedTurn = f.runtime.getActiveTurnId("same-thread");
    if (continuedTurn === null) throw new Error("Resumed request did not establish an active turn");
    replacement.completeTurn("same-thread");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.runtime.getActiveTurnId("same-thread")).toBeNull();
  });
});
