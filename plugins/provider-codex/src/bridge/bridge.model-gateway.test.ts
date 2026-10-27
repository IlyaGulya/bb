import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BridgeExecutionOptions, ModelConnectionSnapshot } from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness, experimental_assembleCapturedThreadEvents as assembleCapturedThreadEvents, type BridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { z } from "zod";
import { experimental_providerBridge, handleLine } from "./bridge.js";
import { FULL_ACCESS_SESSION_OPTIONS, stubFakeCodexAppServer } from "./fake-codex-app-server-harness.js";

let root: string;
let server: Server;
let endpoint: string;
let harness: BridgeJsonRpcTestHarness;
let catalogStatus: number;
let catalog: string[];
let discoveries: { authorization: string | undefined; correlation: string | string[] | undefined }[];
const threads = new Set<string>();
const key = "synthetic-cpa-client-key";
let nextId: number;
const providerIdentitySchema = z.object({ providerThreadId: z.string() });
const recordedRequestSchema = z.object({ method: z.string(), params: z.record(z.string(), z.unknown()) });

function connection(prefix = "personal"): ModelConnectionSnapshot {
  return {
    id: `connection-${prefix}`, name: prefix, provider: "codex", hostId: null,
    enabled: true, revoked: false, createdAt: 1, updatedAt: 1,
    nativeAuth: { configDir: null, profile: null, hostEnv: null },
    gateway: {
      baseUrl: endpoint, protocol: "openai-responses",
      accountPrefix: prefix, modelProvider: "openai-codex",
      credential: { kind: "env", name: "CPA_CODEX_TEST_KEY" }, allowedHostIds: ["host-test"],
    },
  };
}

function options(prefix = "personal", model = `bb-cpa/${prefix}/gpt-example`) {
  return { ...FULL_ACCESS_SESSION_OPTIONS, model, modelConnection: connection(prefix) };
}

async function construct(threadId: string, opts: BridgeExecutionOptions = options(), kind: "start" | "resume" | "fork" = "start", providerThreadId?: string) {
  threads.add(threadId);
  const id = nextId++;
  harness.sendRequest(id, `thread/${kind}`, {
    threadId, cwd: root, instructionMode: "append", options: opts,
    ...(kind === "resume" ? { providerThreadId } : {}),
    ...(kind === "fork" ? { sourceProviderThreadId: providerThreadId } : {}),
    dynamicTools: [{ name: "local_probe", description: "Local native tool", inputSchema: { type: "object", properties: {} } }],
  });
  return harness.waitForResponse(id);
}

function requests(): { method: string; params: Record<string, unknown> }[] {
  return readFileSync(join(root, "requests.jsonl"), "utf8").trim().split("\n").map((line) => recordedRequestSchema.parse(JSON.parse(line)));
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "bb-codex-cpa-"));
  catalogStatus = 200;
  catalog = ["personal/gpt-example", "work/gpt-example"];
  discoveries = [];
  threads.clear();
  nextId = 100;
  server = createServer((req, res) => {
    discoveries.push({ authorization: req.headers.authorization, correlation: req.headers["x-bb-thread-id"] });
    res.writeHead(req.url === "/v1/models" ? catalogStatus : 404, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: catalog.map((id) => ({ id })) }));
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture listener");
  endpoint = `http://127.0.0.1:${address.port}/v1`;
  vi.stubEnv("CPA_CODEX_TEST_KEY", key);
  const script = join(root, "script.json");
  writeFileSync(script, JSON.stringify({ requestLogPath: join(root, "requests.jsonl") }));
  stubFakeCodexAppServer(script);
  experimental_providerBridge.start?.({ pluginId: "provider-codex", dataDir: root, tempDir: root });
  harness = createBridgeJsonRpcTestHarness(handleLine);
});

afterEach(async () => {
  let id = 990_000;
  for (const threadId of threads) {
    id += 1;
    harness.sendRequest(id, "thread/stop", { threadId, providerThreadId: "cleanup", intent: "release", activeTurnId: null });
    await harness.waitForResponse(id);
  }
  harness.restore();
  vi.unstubAllEnvs();
  const closed = Promise.withResolvers<void>();
  server.close((error) => error ? closed.reject(error) : closed.resolve());
  await closed.promise;
  rmSync(root, { recursive: true, force: true });
});

it("discovers only the selected connection namespace without routing correlation or invented capabilities", async () => {
  for (const prefix of ["personal", "work"]) {
    const id = nextId++;
    harness.sendRequest(id, "model/list", { modelConnection: connection(prefix) });
    const result = await harness.waitForResponse(id);
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ models: [{
      id: `bb-cpa/${prefix}/gpt-example`, model: `bb-cpa/${prefix}/gpt-example`,
      displayName: `${prefix}/gpt-example`, description: `CPA ${prefix}; native Codex Responses`,
      supportedReasoningEfforts: [], defaultReasoningEffort: "medium", supportedServiceTiers: [], isDefault: false,
    }], selectedOnlyModels: [] });
  }
  expect(discoveries).toEqual([
    { authorization: `Bearer ${key}`, correlation: undefined },
    { authorization: `Bearer ${key}`, correlation: undefined },
  ]);
});

it.each(["gpt-example", "bb-cpa/work/gpt-example", "bb-cpa/personal/unknown", ""])(
  "rejects unsupported selection %s without constructing a native fallback", async (model) => {
    const result = await construct("thr_cpa_reject", options("personal", model));
    expect(result.error?.message).toContain("fallback");
    expect(harness.messages.some((message) => message.method === "session/identity")).toBe(false);
  },
);

it("does not fall back to native discovery when CPA denies the worker credential", async () => {
  catalogStatus = 403;
  harness.sendRequest(10, "model/list", { modelConnection: connection() });
  const result = await harness.waitForResponse(10);
  expect(result.error?.message).toContain("403");
  expect(JSON.stringify(result)).not.toContain(key);
  expect(result.result).toBeUndefined();
});

it("requires the worker credential even if execution envVars supplies one", async () => {
  vi.stubEnv("CPA_CODEX_TEST_KEY", undefined);
  const result = await construct("thr_cpa_credential", { ...options(), envVars: { CPA_CODEX_TEST_KEY: key, OPENAI_API_KEY: "native-synthetic" } });
  expect(result.error?.message).toContain("credential");
  expect(discoveries).toEqual([]);
});

it("pins the model across continuation, reopen and fork while preserving native identity and tools", async () => {
  const threadId = "thr_cpa_session";
  const started = await construct(threadId);
  expect(started.error).toBeUndefined();
  const { providerThreadId } = providerIdentitySchema.parse(started.result);
  expect(providerThreadId).toMatch(/^codex-fx-/);
  const turn = async (id: number, opts = options()) => {
    harness.sendRequest(id, "turn/start", { threadId, providerThreadId, clientRequestId: `creq_cpagateway${id}`, input: [{ type: "text", text: "hello", mentions: [] }], options: opts });
    return harness.waitForResponse(id);
  };
  expect((await turn(2)).error).toBeUndefined();
  expect((await turn(3, options("personal", "bb-cpa/personal/other"))).error?.message).toContain("pinned");
  expect((await turn(4)).error).toBeUndefined();
  harness.sendRequest(5, "thread/stop", { threadId, providerThreadId, intent: "release", activeTurnId: null });
  await harness.waitForResponse(5);
  const resumed = await construct(threadId, options(), "resume", providerThreadId);
  expect(resumed.error).toBeUndefined();
  expect(resumed.result).toMatchObject({ providerThreadId });
  const forked = await construct("thr_cpa_fork", options(), "fork", providerThreadId);
  expect(forked.error).toBeUndefined();
  expect(providerIdentitySchema.parse(forked.result).providerThreadId).not.toBe(providerThreadId);
  const construction = requests().filter((request) => ["thread/start", "thread/resume", "thread/fork"].includes(request.method));
  expect(construction).toHaveLength(3);
  for (const { params } of construction) {
    expect(params).toMatchObject({ cwd: root, model: "personal/gpt-example", dynamicTools: [expect.objectContaining({ name: "local_probe" })] });
    expect(params.config).toMatchObject({ disable_response_storage: true });
    expect(JSON.stringify(params)).not.toContain(key);
  }
  expect(harness.messages.filter((message) => message.method === "session/replaced")).toEqual([]);
}, 30_000);

it("keeps simultaneous gateway sessions isolated from each other and ambient pool routing", async () => {
  vi.stubEnv("CODEX_OPENAI_BASE_URL", "https://pool.invalid/v1");
  vi.stubEnv("CODEX_POOL_AUTH_TOKEN", "synthetic-pool-token");
  expect((await construct("thr_cpa_personal")).error).toBeUndefined();
  expect((await construct("thr_cpa_work", options("work"))).error).toBeUndefined();
  const starts = requests().filter((request) => request.method === "thread/start");
  expect(starts).toHaveLength(2);
  expect(starts.map(({ params }) => params.model)).toEqual(["personal/gpt-example", "work/gpt-example"]);
  expect(starts[0]!.params.modelProvider).not.toBe(starts[1]!.params.modelProvider);
  for (const { params } of starts) {
    expect(JSON.stringify(params)).not.toContain("pool.invalid");
    expect(JSON.stringify(params)).not.toContain("synthetic-pool-token");
  }
}, 30_000);

it("refuses reopening a pinned thread with a changed endpoint or with native fallback", async () => {
  const started = await construct("thr_cpa_reopen");
  const { providerThreadId } = providerIdentitySchema.parse(started.result);
  const changed = options();
  changed.modelConnection.gateway!.baseUrl = `${endpoint}/changed`;
  catalogStatus = 200;
  const rejected = await construct("thr_cpa_reopen", changed, "resume", providerThreadId);
  expect(rejected.error).toBeDefined();
  harness.sendRequest(20, "thread/resume", { threadId: "thr_cpa_reopen", providerThreadId, cwd: root, instructionMode: "append", options: FULL_ACCESS_SESSION_OPTIONS });
  expect((await harness.waitForResponse(20)).error?.message).toContain("pinned");
}, 30_000);

it("surfaces payer failure without native quota recovery or leaking the child credential", async () => {
  const error = { message: `Quota exceeded; echoed credential ${key}`, codexErrorInfo: "usageLimitExceeded", additionalDetails: null };
  writeFileSync(join(root, "script.json"), JSON.stringify({
    requestLogPath: join(root, "requests.jsonl"),
    turns: [[
      { method: "turn/started", params: { threadId: "x", turn: { id: "turn-cpa-limit", status: "inProgress" } } },
      { method: "error", params: { threadId: "x", turnId: "turn-cpa-limit", error, willRetry: false } },
      { method: "turn/completed", params: { threadId: "x", turn: { id: "turn-cpa-limit", status: "failed", error } } },
    ]],
  }));
  const threadId = "thr_cpa_failure";
  const started = await construct(threadId, {
    ...options(),
    envVars: { CODEX_OPENAI_BASE_URL: "https://pool.invalid/v1", CODEX_POOL_AUTH_TOKEN: "synthetic-pool-secret", CPA_CODEX_TEST_KEY: key },
  });
  expect(started.error).toBeUndefined();
  const { providerThreadId } = providerIdentitySchema.parse(started.result);
  harness.sendRequest(2, "turn/start", {
    threadId, providerThreadId, clientRequestId: "creq_cpafailure2",
    input: [{ type: "text", text: "hello", mentions: [] }], options: options(),
  });
  await harness.waitForResponse(2);
  await vi.waitFor(() => expect(assembleCapturedThreadEvents(harness.messages, "codex")).toContainEqual(
    expect.objectContaining({ type: "turn/completed", status: "failed" }),
  ));
  const events = assembleCapturedThreadEvents(harness.messages, "codex");
  expect(events.some((event) => event.type === "provider/error")).toBe(true);
  expect(JSON.stringify(harness.messages)).not.toContain(key);
  expect(requests().filter((request) => request.method === "account/rateLimits/read")).toEqual([]);
  expect(requests().filter((request) => request.method === "thread/start")).toHaveLength(1);
  expect(requests().filter((request) => request.method === "turn/start")).toHaveLength(1);
  expect(JSON.stringify(requests())).not.toContain(key);
  expect(JSON.stringify(requests())).not.toContain("synthetic-pool-secret");
}, 30_000);

it("requires an explicit selection and a nonempty catalog in the bound namespace", async () => {
  const missing = await construct("thr_cpa_missing_model", { ...FULL_ACCESS_SESSION_OPTIONS, modelConnection: connection() });
  expect(missing.error?.message).toContain("fallback");
  expect(discoveries).toEqual([]);
  catalog = ["work/gpt-example"];
  const wrongNamespace = await construct("thr_cpa_empty_namespace");
  expect(wrongNamespace.error).toBeDefined();
  expect(wrongNamespace.result).toBeUndefined();
});
