import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { clientTurnRequestIdSchema, executionContextSnapshotSchema, providerStartupDiagnosticSchema, type ThreadEvent } from "@bb/domain";
import { createAgentRuntime } from "./runtime.js";
import { ProviderStartupError, RuntimeStartup } from "./runtime-startup.js";
import type { AgentRuntime, AgentRuntimeBridgeLaunch, AgentRuntimeExecutionOptions } from "./types.js";

const fixture = fileURLToPath(new URL("./test/bridges/bounded-startup-fixture.mjs", import.meta.url));
const roots: string[] = [];
const runtimes: AgentRuntime[] = [];

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Owned startup fixture did not reach its expected state.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "bb-owned-startup-"));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir);
  const startsFile = join(root, "starts");
  const childFile = join(root, "child");
  const events: ThreadEvent[] = [];
  const diagnostics: string[] = [];
  const runtime = createAgentRuntime({ workspacePath: root, onEvent: (event) => events.push(event), onStderr: (message) => diagnostics.push(message), onToolCall: async () => { throw new Error("The startup fixture must not invoke tools"); } });
  runtimes.push(runtime);
  const bridgeLaunch: AgentRuntimeBridgeLaunch = {
    pluginId: "owned-startup-fixture", dataDir,
    source: { kind: "artifact", digest: "owned-startup-fixture", artifactPath: fixture },
    capabilities: { providerInstallation: false, supportsServiceTier: false, permissionModes: ["full"], supportsThreadArchive: false, supportsThreadRename: false, fork: "checkpoint" },
    providerOptions: {}, envPassthrough: [],
  };
  const options = (mode: string, modelDelayMs = 1): AgentRuntimeExecutionOptions => ({
    model: "fixture-only", serviceTier: "default", reasoningLevel: "medium",
    permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null,
    providerOptions: {
      executionContext: executionContextSnapshotSchema.parse({ id: "fixture-context", name: "Fixture", createdAt: 1, updatedAt: 1, startupPolicy: { deadlineMs: 3_000, optionalMcpServers: [] } }),
      startupFixture: { mode, startsFile, childFile, modelDelayMs },
    },
  });
  const start = (mode: string, modelDelayMs = 1) => runtime.startThread({
    threadId: "retained-thread", environmentId: "owned-environment", providerId: "fixture",
    projectId: "owned-project",
    bridgeLaunch, options: options(mode, modelDelayMs),
  });
  return { runtime, start, options, startsFile, childFile, events, diagnostics, bridgeLaunch, dataDir };
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("bounded owned provider startup", () => {
  it("times out a slow native hook, settles its child, and retries the same thread without a second executor", async () => {
    const f = setup();
    const first = f.start("slow-hook");
    const failure = expect(first).rejects.toMatchObject({ code: "provider_startup_timeout" });
    await until(() => existsSync(f.childFile));
    const childPid = Number(readFileSync(f.childFile, "utf8").split(".")[0]);
    const oldBridgePid = Number(readFileSync(f.startsFile, "utf8").trim());
    await expect(f.start("success")).rejects.toThrow(/already owned|competing/i);
    await failure;
    expect(alive(childPid)).toBe(false);
    expect(alive(oldBridgePid)).toBe(false);
    const size = readFileSync(f.childFile, "utf8").length;
    await f.start("success");
    const starts = readFileSync(f.startsFile, "utf8").trim().split("\n").map(Number);
    expect(starts).toHaveLength(2);
    expect(starts.filter(alive)).toEqual([starts[1]]);
    expect(readFileSync(f.childFile, "utf8").length).toBe(size);
    expect(f.runtime.hasThread("retained-thread")).toBe(true);
    expect(f.events.some((event) => event.type === "system/operation" && event.metadata?.phase === "hook" && event.metadata?.hookEvent === "SessionStart")).toBe(true);
  });

  it("cancels owned startup children before acknowledging stop", async () => {
    const f = setup();
    const first = f.start("slow-hook");
    const failure = expect(first).rejects.toMatchObject({ code: "provider_startup_cancelled" });
    await until(() => existsSync(f.childFile));
    const childPid = Number(readFileSync(f.childFile, "utf8").split(".")[0]);
    await f.runtime.stopThread({ threadId: "retained-thread" });
    expect(alive(childPid)).toBe(false);
    await failure;
  });

  it("does not apply the startup deadline to slow model generation and retains the checkpoint", async () => {
    const f = setup();
    await f.start("success", 3_500);
    await f.runtime.runTurn({ threadId: "retained-thread", clientRequestId: clientTurnRequestIdSchema.parse("creq_2222222222"), input: [{ type: "text", text: "Fixture only", mentions: [] }], options: f.options("success", 3_500) });
    await until(() => f.events.some((event) => event.type === "turn/completed"));
    expect(f.events.some((event) => event.type === "system/operation" && event.status === "failed")).toBe(false);
    expect(await f.runtime.stopThread({ threadId: "retained-thread" })).toEqual({ providerCheckpointId: "fixture-checkpoint" });
  });

  it("preserves verified missing-auth classification without exposing ordinary startup output", async () => {
    const f = setup();
    await expect(f.start("missing-auth")).rejects.toMatchObject({ code: "auth_required" });
    await expect(f.start("failure")).rejects.toMatchObject({ code: "provider_startup_failed" });
    expect(JSON.stringify([f.events, f.diagnostics])).not.toContain("SENSITIVE_NATIVE_OUTPUT_MUST_NOT_ESCAPE");
    expect(f.events.some((event) => event.type === "system/operation" && event.metadata?.code === "provider_startup_auth_required")).toBe(true);
  });
  it("fails closed on unobservable required capabilities and permits only explicitly recorded optional servers", async () => {
    const f = setup();
    writeFileSync(join(f.dataDir, "generic-readiness"), "fixture-only");
    const start = (optional: boolean) => f.runtime.startThread({
      threadId: optional ? "optional-thread" : "required-thread", environmentId: "owned-environment", providerId: "fixture", bridgeLaunch: f.bridgeLaunch,
      projectId: "owned-project",
      options: { ...f.options("success"), providerOptions: {
        startupFixture: { mode: "success" },
        executionContext: executionContextSnapshotSchema.parse({ id: optional ? "optional-context" : "required-context", name: "Fixture", createdAt: 1, updatedAt: 1,
          mcpServers: [{ name: "fixture-service", configPath: "/tmp/owned-fixture-config" }],
          startupPolicy: { deadlineMs: 3_000, optionalMcpServers: optional ? ["fixture-service"] : [] },
        }),
      } },
    });
    await expect(start(false)).rejects.toMatchObject({ code: "provider_startup_capability_unverified" });
    const ready = await start(true);
    expect(ready.providerThreadId).toBe("native-optional-thread");
    expect(f.events.some((event) => event.type === "system/operation" && event.threadId === "optional-thread" && event.status === "completed" && event.metadata?.optionalMcpServerCount === 1)).toBe(true);
  });
});

it("blocks retry while stop is pending and retains ownership when stop cannot be confirmed", async () => {
  const events: ThreadEvent[] = [];
  const startup = new RuntimeStartup((event) => events.push(event));
  let rejectStop!: (error: Error) => void;
  const stopping = new Promise<void>((_, reject) => { rejectStop = reject; });
  const first = startup.run({ threadId: "same-thread", policy: { deadlineMs: 60_000, optionalMcpServers: [] }, stop: () => stopping, work: () => new Promise<void>(() => {}) });
  const failed = expect(first).rejects.toMatchObject({ code: "provider_startup_stop_unverified" });
  const cancellation = startup.cancel("same-thread");
  const cancelled = expect(cancellation).rejects.toMatchObject({ code: "provider_startup_stop_unverified" });
  await expect(startup.run({ threadId: "same-thread", policy: { deadlineMs: 60_000, optionalMcpServers: [] }, stop: async () => {}, work: async () => {} })).rejects.toThrow(/owned/);
  rejectStop(new Error("fixture stop could not be verified"));
  await Promise.all([failed, cancelled]);
  await expect(startup.run({ threadId: "same-thread", policy: { deadlineMs: 60_000, optionalMcpServers: [] }, stop: async () => {}, work: async () => {} })).rejects.toMatchObject({ code: "provider_startup_stop_unverified" });
  expect(startup.isActive("same-thread")).toBe(true);
  expect(events.at(-1)).toMatchObject({ type: "system/operation", status: "failed", metadata: { retryBlocked: true } });
});

it("retains an ordinary pre-hook cause internally while publishing only allowlisted startup failure fields", async () => {
  const events: ThreadEvent[] = [];
  const startup = new RuntimeStartup((event) => events.push(event));
  const sensitive = {
    message: "SYNTHETIC_SENSITIVE_PREHOOK_MESSAGE",
    code: "SYNTHETIC_UNTRUSTED_PROVIDER_CODE",
    stage: "SYNTHETIC_UNTRUSTED_PROVIDER_STAGE",
    credential: "SYNTHETIC_SECRET_VALUE",
    path: "/synthetic/private/provider-item",
    output: "SYNTHETIC_RAW_NATIVE_OUTPUT",
  };
  const original = Object.assign(new Error(sensitive.message), {
    code: sensitive.code,
    stage: sensitive.stage,
    details: { credential: sensitive.credential, path: sensitive.path },
    stdout: sensitive.output,
  });
  const threadId = "ordinary-prehook-failure";
  const error: unknown = await startup.run({
    threadId,
    policy: { deadlineMs: 3_000, optionalMcpServers: [] },
    stop: async () => {},
    work: () => startup.track(threadId, async () => { throw original; }),
  }).catch((failure: unknown) => failure);
  if (!(error instanceof ProviderStartupError)) throw new Error("Expected a classified startup failure", { cause: error });
  expect.soft(error.cause).toBe(original);
  expect(error.code).toBe("provider_startup_failed");
  expect(error.message).toBe(new ProviderStartupError("provider_startup_failed").message);
  const terminal = events.at(-1);
  if (terminal?.type !== "system/operation" || terminal.operation !== "provider_startup" || terminal.status !== "failed") {
    throw new Error("Expected a terminal startup diagnostic");
  }
  const diagnostic = providerStartupDiagnosticSchema.parse(terminal.metadata);
  expect.soft(diagnostic).toMatchObject({
    phase: "stopped", failureStage: "initializing", code: "provider_startup_failed", retryBlocked: false,
    hookEvent: null, hookId: null, hookState: null,
  });
  const publicOutput = JSON.stringify({ code: error.code, message: error.message, error, events, diagnostic });
  for (const value of Object.values(sensitive)) expect(publicOutput).not.toContain(value);
});
