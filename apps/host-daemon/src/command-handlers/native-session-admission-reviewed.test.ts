import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDeferredPromise } from "@bb/test-helpers";
import { createHarness, DISPATCH_TEST_BRIDGE_LAUNCH, dispatchTestRuntimeBridgeLaunch } from "../../test/command/dispatch-helpers.js";
import type { CommandOf } from "../command-dispatch-support.js";
import { admitNativeSession } from "./native-session-admission.js";
import { discoverNativeSessions } from "./native-sessions.js";

describe("reviewed native admission ownership", () => {
  it("does not promote a registered identity while provider resume is still unresolved", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-native-pending-"));
    const cwd = join(directory, "workspace");
    const sessions = join(directory, "sessions");
    await mkdir(cwd); await mkdir(sessions);
    const sessionId = "synthetic-pending-codex-session";
    await writeFile(join(sessions, "source.jsonl"), JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd } }));
    const page = await discoverNativeSessions({ roots: [{ engine: "codex", path: sessions, profile: "Synthetic pending profile", artifactRoots: [] }], cursor: 0, limit: 100 });
    const source = page.sessions[0];
    if (!source) throw new Error(page.warnings.join("; "));
    const fixture = createHarness({ workspacePath: cwd });
    const entered = createDeferredPromise<void>();
    const completion = createDeferredPromise<void>();
    const options: CommandOf<"native.sessions.admit">["options"] = { model: "synthetic-model", reasoningLevel: "medium", serviceTier: "default", providerOptions: {}, permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null };
    fixture.runtime.resumeThread = async (args) => {
      fixture.threadControls.setProviderSession(args.threadId, { providerId: args.providerId, providerThreadId: sessionId });
      entered.resolve();
      await completion.promise;
      throw new Error("Synthetic provider construction failed before acquiring ownership");
    };
    const construction = fixture.runtime.resumeThread({ bridgeLaunch: dispatchTestRuntimeBridgeLaunch(directory), environmentId: "env-pending", threadId: "thread-pending", projectId: "project-pending", providerId: "codex", providerThreadId: sessionId, contributedEnv: [], options, instructions: "Synthetic admission only", dynamicTools: [], instructionMode: "append" });
    const settledConstruction = construction.then(() => "completed", () => "failed");
    await entered.promise;
    const command: CommandOf<"native.sessions.admit"> = { type: "native.sessions.admit", environmentId: "env-pending", threadId: "thread-pending", projectId: "project-pending", providerId: "codex", workspaceContext: { workspacePath: cwd }, bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH, options, instructions: "Synthetic admission only", dynamicTools: [], contributedEnv: [], injectedSkillSources: [], instructionMode: "append", source };
    try {
      const result = await admitNativeSession(command, fixture.dispatchOptions({ dataDir: directory, threadStorageRootPath: join(directory, "thread-storage") }));
      expect(result.admitted).toBe(false);
    } finally {
      completion.resolve();
      await settledConstruction;
      await fixture.manager.shutdownAll();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
