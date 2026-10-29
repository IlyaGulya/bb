import { createAgentRuntime } from "@bb/agent-runtime";
import { MemoryBridge } from "@bb/agent-runtime/test";
import {
  encodeClientTurnRequestIdNumber,
  executionContextSnapshotSchema,
  type ThreadEvent,
} from "@bb/domain";
import type {
  HostDaemonCommand,
  HostDaemonOnlineRpcResponseMessage,
} from "@bb/host-daemon-contract";
import { spawnManagedProcess } from "@bb/process-utils";
import { createDeferredPromise } from "@bb/test-helpers";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandRouter } from "../../src/command-router.js";
import { RuntimeManager } from "../../src/runtime-manager.js";
import {
  createFakeWorkspace,
  DISPATCH_TEST_BRIDGE_LAUNCH,
  dispatchTestRuntimeBridgeLaunch,
  makeDispatchOptions,
} from "./dispatch-helpers.js";

vi.mock("@bb/process-utils", async (importOriginal) => ({
  ...await importOriginal<typeof import("@bb/process-utils")>(),
  spawnManagedProcess: vi.fn(),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw new Error("The in-memory startup routing fixture must never signal a host process");
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(spawnManagedProcess).mockReset();
});

describe("CommandRouter bounded startup cancellation", () => {
  it("interrupts owned bounded startup before its deadline and waits for confirmed cleanup", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bb-router-owned-startup-"));
    const cleanup = createDeferredPromise<void>();
    const hookEntered = createDeferredPromise<void>();
    const sibling = new MemoryBridge();
    const owned = new MemoryBridge();
    owned.deferConstruction = true;
    owned.readyOnConstruction = false;
    owned.stopGate = cleanup.promise;
    const bridges = [sibling, owned];
    vi.mocked(spawnManagedProcess)
      .mockReturnValueOnce({ child: sibling, stop: sibling.stop })
      .mockReturnValueOnce({ child: owned, stop: owned.stop });
    const events: ThreadEvent[] = [];
    const threadId = "owned-startup-thread";
    const runtime = createAgentRuntime({
      workspacePath: root,
      bridgeBundleDir: root,
      onEvent: (event) => {
        events.push(event);
        if (event.threadId === threadId && event.type === "system/operation" && event.metadata?.phase === "hook") {
          hookEntered.resolve();
        }
      },
      onToolCall: async () => {
        throw new Error("The in-memory startup routing fixture must never invoke tools");
      },
    });
    const requests: Promise<HostDaemonOnlineRpcResponseMessage>[] = [];
    try {
      const workspace = createFakeWorkspace(root).workspace;
      const manager = new RuntimeManager({
        createRuntime: () => runtime,
        provisionWorkspace: async () => workspace,
      });
      await manager.ensureEnvironment({ environmentId: "owned-startup-env", workspacePath: root });
      const router = new CommandRouter(makeDispatchOptions({
        dataDir: root,
        threadStorageRootPath: path.join(root, "threads"),
        runtimeManager: manager,
      }));
      const route = (requestId: string, command: HostDaemonCommand) => {
        const request = router.handleOnlineRpcRequest({ type: "host-rpc.request", requestId, command });
        requests.push(request);
        return request;
      };
      const command: Extract<HostDaemonCommand, { type: "thread.start" }> = {
        type: "thread.start",
        bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
        environmentId: "owned-startup-env",
        threadId,
        workspaceContext: { workspacePath: root },
        projectId: "owned-startup-project",
        providerId: "fixture",
        requestId: encodeClientTurnRequestIdNumber({ value: 1 }),
        input: [],
        options: {
          model: "fixture-only",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionScope: "full",
          approvalReviewer: null,
          permissionEscalation: null,
          providerOptions: {
            executionContext: executionContextSnapshotSchema.parse({
              id: "owned-startup-context",
              name: "Owned startup fixture",
              createdAt: 1,
              updatedAt: 1,
              startupPolicy: { deadlineMs: 3_000, optionalMcpServers: [] },
            }),
          },
        },
        instructions: "Synthetic startup fixture only",
        dynamicTools: [],
        contributedEnv: [],
        injectedSkillSources: [],
        instructionMode: "append",
      };
      const siblingStart = runtime.startThread({
        bridgeLaunch: dispatchTestRuntimeBridgeLaunch(root),
        environmentId: command.environmentId,
        threadId: "unrelated-thread",
        projectId: command.projectId,
        providerId: command.providerId,
        options: command.options,
      });
      await vi.advanceTimersByTimeAsync(0);
      await siblingStart;
      let startSettled = false;
      const starting = route("owned-startup-start", command).then((response) => {
        startSettled = true;
        return response;
      });
      await hookEntered.promise;
      expect(runtime.hasThread(threadId)).toBe(true);
      expect(runtime.getProviderSession(threadId)).toBeNull();
      expect(runtime.getActiveTurnId(threadId)).toBeNull();
      let stopSettled = false;
      const stopping = route("owned-startup-stop", {
        type: "thread.stop",
        intent: "interrupt",
        environmentId: command.environmentId,
        threadId,
      }).then((response) => {
        stopSettled = true;
        return response;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(owned.stopRequested).toBe(true);
      expect(owned.stopped).toBe(false);
      expect(stopSettled).toBe(false);
      expect(startSettled).toBe(false);
      expect(runtime.hasThread(threadId)).toBe(true);
      expect(sibling.stopped).toBe(false);
      expect(runtime.hasThread("unrelated-thread")).toBe(true);

      cleanup.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(await stopping).toMatchObject({
        ok: true,
        commandType: "thread.stop",
        result: { providerCheckpointId: null },
      });
      expect(await starting).toMatchObject({
        ok: false,
        commandType: "thread.start",
        errorCode: "provider_startup_cancelled",
      });
      expect(owned.stopped).toBe(true);
      expect(runtime.hasThread(threadId)).toBe(false);
      expect(events).toContainEqual(expect.objectContaining({
        type: "system/operation",
        threadId,
        status: "failed",
        metadata: expect.objectContaining({
          phase: "stopped",
          failureStage: "hook",
          code: "provider_startup_cancelled",
          retryBlocked: false,
        }),
      }));
      expect(events.some((event) => event.type === "system/operation" && event.metadata?.code === "provider_startup_timeout")).toBe(false);

      const replacement = new MemoryBridge();
      bridges.push(replacement);
      vi.mocked(spawnManagedProcess).mockReturnValueOnce({ child: replacement, stop: replacement.stop });
      const recovery = route("owned-startup-retry", {
        ...command,
        requestId: encodeClientTurnRequestIdNumber({ value: 2 }),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(await recovery).toMatchObject({ ok: true, result: { providerThreadId: `native-${threadId}` } });
      expect(runtime.getProviderSession(threadId)).toMatchObject({ providerThreadId: `native-${threadId}` });
      expect(sibling.stopped).toBe(false);
      expect(runtime.hasThread("unrelated-thread")).toBe(true);
    } finally {
      cleanup.resolve();
      try {
        await runtime.shutdown();
        await vi.advanceTimersByTimeAsync(0);
        await Promise.allSettled(requests);
      } finally {
        for (const bridge of bridges) {
          bridge.finish();
          bridge.stdin.destroy();
          bridge.stdout.destroy();
          bridge.stderr.destroy();
        }
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });
});
