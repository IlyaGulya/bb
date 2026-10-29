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
    rateLimitRetry: { delaysMs: [2_000] }, onEvent: (event) => events.push(event),
  });
  runtimes.push(runtime);
  const start = (withInput = false) => runtime.startThread({
    threadId: "same-thread", environmentId: "fixture-env", providerId: "fixture", bridgeLaunch: launch, options,
    ...(withInput ? { input, clientRequestId: clientTurnRequestIdSchema.parse("creq_2222222222") } : {}),
  });
  return { first, runtime, events, start };
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
      input, clientRequestId: clientTurnRequestIdSchema.parse("creq_3333333333"),
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await retried).toMatchObject({ status: "fulfilled", value: { providerThreadId: "native-same-thread" } });
    const activeTurn = f.runtime.getActiveTurnId("same-thread");
    expect(activeTurn).toBe("turn-1");
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
    expect(f.runtime.getActiveTurnId("same-thread")).toBe("turn-1");
    expect(await started).toMatchObject({ status: "fulfilled", value: { providerThreadId: "native-same-thread" } });
  });

  it("bounds native replacement initiated by a permission-escalating steer and awaits owned cleanup", async () => {
    const f = setup();
    const started = observe(f.start(true));
    await vi.advanceTimersByTimeAsync(0);
    expect(await started).toMatchObject({ status: "fulfilled" });
    expect(f.runtime.getActiveTurnId("same-thread")).toBe("turn-1");
    f.first.replaceOnFullSteer = true;
    let releaseCleanup!: () => void;
    f.first.stopGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let steerSettled = false;
    try {
      const steered = observe(f.runtime.steerTurn({
        threadId: "same-thread", expectedTurnId: "turn-1", input,
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
});
