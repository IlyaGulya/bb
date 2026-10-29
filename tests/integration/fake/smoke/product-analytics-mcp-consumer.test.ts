import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { join } from "node:path";
import { withListeningAnalyticsCli, writeAnalyticsCliLauncher } from "../../helpers/analytics-cli-process.js";
import { serve } from "@hono/node-server";
import { getProject, productAnalyticsEvents } from "@bb/db";
import { turnScope } from "@bb/domain";
import { groupHostDaemonEvents } from "@bb/host-daemon-contract";
import { PRODUCT_ANALYTICS_HEADERS as analyticsHeaders } from "@bb/server-contract";
import { and, eq } from "drizzle-orm";
import { internalAuthHeaders } from "../../../../apps/server/test/helpers/commands.js";
import { seedThread, seedThreadRuntimeState } from "../../../../apps/server/test/helpers/seed.js";
import type { TestAppHarness } from "../../../../apps/server/test/helpers/test-app.js";
import { createAnalyticsCliProgram } from "../../../../apps/cli/src/__tests__/helpers/product-analytics-cli.js";
import { createCliBbSdk } from "../../../../apps/cli/src/client.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cliEnvironment, type CliRunner } from "../../../../plugins/mcp/src/cli-runner.js";
import { parseCommandIndex } from "../../../../plugins/mcp/src/command-index.js";
import { createBbMcpHttpHandler } from "../../../../plugins/mcp/src/mcp-handler.js";
import { consumerReport, consumerSdk, installConsumerPlugin, withAnalyticsConsumer } from "../../../../apps/server/test/helpers/product-analytics-consumer.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function withListeningConsumerSdk<T>(harness: TestAppHarness, run: () => Promise<T>): Promise<T> {
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: harness.app.fetch });
  try {
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Analytics consumer did not bind a TCP port");
    harness.config.serverPort = address.port;
    harness.pluginService.bindSdk({ baseUrl: `http://127.0.0.1:${address.port}` });
    return await run();
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe("analytics real MCP CLI admission", () => {
  it("preserves explicit smoke mode through MCP environment and actual CLI action on a production server", async () => {
    await withAnalyticsConsumer(async ({ harness, collector, work }) => {
      const serverUrl = "http://localhost";
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => harness.app.request(new Request(input, init)));
      const runCli: CliRunner = async (argv) => {
        const env = cliEnvironment({ BB_PRODUCT_ANALYTICS_MODE: "smoke", BB_PROJECT_ID: work.id, BB_THREAD_ID: "thr_owner_context_must_be_stripped" }, serverUrl);
        for (const key of ["BB_PRODUCT_ANALYTICS_MODE", "BB_PRODUCT_ANALYTICS_SURFACE", "BB_PROJECT_ID", "BB_THREAD_ID"]) vi.stubEnv(key, env[key]);
        const lines: string[] = [];
        const log = vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => { lines.push(values.map(String).join(" ")); });
        try {
          const program = createAnalyticsCliProgram(serverUrl);
          await program.parseAsync([process.execPath, "bb", ...argv]);
          return { exitCode: 0, stdout: lines.join("\n"), stderr: "", timedOut: false, truncated: false };
        } finally {
          log.mockRestore();
        }
      };
      const handler = createBbMcpHttpHandler({ runCli, loadCommandIndex: async () => parseCommandIndex(JSON.stringify({ commands: [{ path: "project update", aliases: [], arguments: "<id>", description: "Update a project", options: ["--name <name>", "--json"] }] })) }, "0.0.0-owned", (error) => { throw error; });
      const headers = new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream" });
      const initialize = await handler.fetch(new Request("http://localhost/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "owned-regression", version: "1" } } }) }));
      expect(initialize.status).toBe(200);
      await initialize.text();
      const sessionId = initialize.headers.get("mcp-session-id");
      if (sessionId !== null) headers.set("mcp-session-id", sessionId);
      headers.set("mcp-protocol-version", "2025-11-25");
      const call = await handler.fetch(new Request("http://localhost/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run", arguments: { code: `return await bb.json(["project", "update", ${JSON.stringify(work.id)}, "--name", "Changed through MCP"]);` } } }) }));
      expect(call.status).toBe(200);
      expect(await call.text()).toContain("Changed through MCP");
      expect(await createCliBbSdk(serverUrl).projects.get({ projectId: work.id })).toMatchObject({ name: "Changed through MCP" });
      expect(consumerReport(collector, work.id, "smoke").rows.find((row) => row.featureId === "core.projects" && row.action === "update")).toMatchObject({ attempts: 1, successes: 1, unknown: 1 });
      expect(collector.report({ days: 7, mode: "smoke", projectId: work.id, surface: "mcp" }).rows.find((row) => row.featureId === "core.projects" && row.action === "update")).toMatchObject({ attempts: 1, successes: 1 });
      expect(consumerReport(collector, work.id, "production").rows.find((row) => row.featureId === "core.projects" && row.action === "update")).toMatchObject({ attempts: 0, successes: 0, lastUsedAt: null });
    });
  });
});

describe("analytics actual MCP semantic producer", () => {
  it("keeps a request-tagged smoke tool in its project and QA plane while retaining ordinary production usage", async () => {
    await withAnalyticsConsumer(async ({ harness, collector, work, personal }) => withListeningConsumerSdk(harness, async () => {
      const plugin = await harness.pluginService.install("builtin:mcp", { kind: "root" });
      if (plugin.status !== "running") throw new Error(`Actual MCP plugin did not load: ${plugin.statusDetail}`);
      const path = `/api/v1/plugins/${plugin.id}/http/mcp`;
      const privateResult = "owned MCP result excluded from analytics";
      for (const mode of ["production", "smoke"] as const) {
        const headers = new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream" });
        headers.set(analyticsHeaders.mode, mode);
        headers.set(analyticsHeaders.actor, "agent");
        headers.set(analyticsHeaders.surface, "mcp");
        headers.set(analyticsHeaders.intent, "use");
        headers.set(analyticsHeaders.operation, randomUUID());
        if (mode === "smoke") headers.set(analyticsHeaders.project, work.id);
        const initialized = await harness.app.request(path, {
          method: "POST", headers,
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "owned-semantic-consumer", version: "1" } } }),
        });
        expect(initialized.status).toBe(200);
        await initialized.text();
        const sessionId = initialized.headers.get("mcp-session-id");
        if (sessionId !== null) headers.set("mcp-session-id", sessionId);
        headers.set("mcp-protocol-version", "2025-11-25");
        headers.set(analyticsHeaders.operation, randomUUID());
        const called = await harness.app.request(path, {
          method: "POST", headers,
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run", arguments: { code: `await bb.sleep(0); return ${JSON.stringify(privateResult)};` } } }),
        });
        expect(called.status).toBe(200);
        expect(await called.text()).toContain(privateResult);
        expect(consumerReport(collector, undefined, "production").rows.find((row) => row.featureId === `plugin.${plugin.id}` && row.action === "mcp.run")).toMatchObject({ attempts: 1, successes: 1, failures: 0 });
      }
      const smoke = consumerReport(collector, work.id, "smoke");
      expect(smoke.rows.find((row) => row.featureId === `plugin.${plugin.id}` && row.action === "mcp.run")).toMatchObject({ attempts: 1, successes: 1, failures: 0, agent: 1 });
      expect(collector.report({ days: 7, mode: "smoke", projectId: work.id, surface: "mcp" }).rows.find((row) => row.featureId === `plugin.${plugin.id}` && row.action === "mcp.run")).toMatchObject({ attempts: 1, successes: 1 });
      for (const projectId of [personal.id, undefined]) expect(consumerReport(collector, projectId, "smoke").rows.find((row) => row.featureId === `plugin.${plugin.id}` && row.action === "mcp.run")).toMatchObject({ attempts: 0, successes: 0, lastUsedAt: null });
      expect(consumerReport(collector, work.id, "production").rows.find((row) => row.featureId === `plugin.${plugin.id}` && row.action === "mcp.run")).toMatchObject({ attempts: 0, successes: 0, lastUsedAt: null });
      expect(JSON.stringify(harness.db.select().from(productAnalyticsEvents).all())).not.toContain(privateResult);
    }));
  });
});

describe("analytics authenticated native tool provenance", () => {
  it("counts a real Core child mutation as deliberate agent usage in the originating smoke turn, not production", async () => {
    await withAnalyticsConsumer(async ({ harness, collector, session, work, personal, environment }) => withListeningConsumerSdk(harness, async () => {
      const production = consumerSdk(harness, { actorKind: "agent", surface: "sdk", mode: "production", intentional: true, projectId: work.id });
      expect(await production.projects.update({ projectId: work.id, name: "Owned production positive control" })).toMatchObject({ name: "Owned production positive control" });
      expect(consumerReport(collector, work.id, "production").rows.find((row) => row.featureId === "core.projects" && row.action === "update")).toMatchObject({ attempts: 1, successes: 1, agent: 1 });
      const { pluginId } = await installConsumerPlugin(harness, `import { z } from "zod";
export default function plugin(bb) {
  bb.agents.registerTool({
    name: "rename_owned_project",
    description: "Rename the calling thread's project",
    parameters: z.object({ name: z.string() }),
    async execute({ name }, ctx) {
      const project = await bb.sdk.projects.update({ projectId: ctx.projectId, name });
      return project.name;
    },
  });
}`);
      const thread = seedThread(harness.deps, { projectId: work.id, environmentId: environment.id, status: "idle" });
      const providerThreadId = "owned-native-tool-provider";
      const turnId = "owned-native-tool-smoke-turn";
      seedThreadRuntimeState(harness.deps, { threadId: thread.id, environmentId: environment.id, providerThreadId });
      const smoke = consumerSdk(harness, { actorKind: "agent", surface: "sdk", mode: "smoke", intentional: true, projectId: work.id });
      const privatePrompt = "owned native tool prompt excluded from analytics";
      expect(await smoke.threads.send({ threadId: thread.id, input: [{ type: "text", text: privatePrompt, mentions: [] }], mode: "start", model: "gpt-5", permissionMode: "full", reasoningLevel: "medium", serviceTier: "default" })).toMatchObject({ delivery: "sent" });
      const started = await harness.app.request("/internal/session/events", {
        method: "POST", headers: internalAuthHeaders(harness),
        body: JSON.stringify({ sessionId: session.id, eventGroups: groupHostDaemonEvents([{ threadId: thread.id, event: { type: "turn/started", threadId: thread.id, providerThreadId, scope: turnScope(turnId) } }]) }),
      });
      expect(started.status).toBe(200);
      expect(consumerReport(collector, work.id, "smoke").rows.find((row) => row.featureId === "core.execution" && row.action === "turn")).toMatchObject({ attempts: 1, successes: 0, system: 1 });
      const privateName = "Changed through authenticated native tool";
      const called = await harness.app.request("/internal/session/tool-call", {
        method: "POST", headers: internalAuthHeaders(harness),
        body: JSON.stringify({ sessionId: session.id, threadId: thread.id, providerThreadId, turnId, callId: "owned-native-tool-call", tool: "rename_owned_project", arguments: { name: privateName } }),
      });
      expect(called.status).toBe(200);
      expect(await called.json()).toMatchObject({ success: true, contentItems: [{ type: "inputText", text: privateName }] });
      expect(getProject(harness.db, work.id)).toMatchObject({ name: privateName });
      const report = consumerReport(collector, work.id, "smoke");
      const identities = [{ featureId: "core.projects", action: "update" }, { featureId: `plugin.${pluginId}`, action: "agent-tool.rename_owned_project" }];
      for (const identity of identities) {
        expect(report.rows.find((row) => row.featureId === identity.featureId && row.action === identity.action)).toMatchObject({ attempts: 1, successes: 1, failures: 0, agent: 1 });
        expect(collector.report({ days: 7, mode: "smoke", projectId: work.id, surface: "agent" }).rows.find((row) => row.featureId === identity.featureId && row.action === identity.action)).toMatchObject({ attempts: 1, successes: 1 });
        for (const projectId of [personal.id, undefined]) expect(consumerReport(collector, projectId, "smoke").rows.find((row) => row.featureId === identity.featureId && row.action === identity.action)).toMatchObject({ attempts: 0, successes: 0, lastUsedAt: null });
      }
      const completed = identities.map((identity) => harness.db.select({ operationId: productAnalyticsEvents.operationId, mode: productAnalyticsEvents.mode, actorKind: productAnalyticsEvents.actorKind, surface: productAnalyticsEvents.surface }).from(productAnalyticsEvents).where(and(eq(productAnalyticsEvents.featureId, identity.featureId), eq(productAnalyticsEvents.action, identity.action), eq(productAnalyticsEvents.mode, "smoke"), eq(productAnalyticsEvents.stage, "completed"))).get());
      for (const event of completed) expect(event).toMatchObject({ mode: "smoke", actorKind: "agent", surface: "agent" });
      expect(completed[0]?.operationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(completed[1]?.operationId).toBe(completed[0]?.operationId);
      expect(consumerReport(collector, work.id, "production").rows.find((row) => row.featureId === "core.projects" && row.action === "update")).toMatchObject({ attempts: 1, successes: 1, agent: 1 });
      expect(consumerReport(collector, work.id, "production").rows.find((row) => row.featureId === `plugin.${pluginId}` && row.action === "agent-tool.rename_owned_project")).toMatchObject({ attempts: 0, successes: 0, lastUsedAt: null });
      const events = JSON.stringify(harness.db.select().from(productAnalyticsEvents).all());
      expect(events).not.toContain(privateName);
      expect(events).not.toContain(privatePrompt);
    }));
  });
});

describe("analytics MCP request to actual CLI subprocess", () => {
  it("keeps concurrent request QA modes through Core mutations without changing the production server environment", async () => {
    await withAnalyticsConsumer(async ({ harness, collector, work, personal }) => {
      const environmentAtMutation = new Map<string, string | null>();
      await withListeningAnalyticsCli(harness, async () => {
        const launcher = await writeAnalyticsCliLauncher(join(harness.config.dataDir, "owned-cli-launcher"));
        vi.stubEnv("BB_CLI", launcher);
        vi.stubEnv("BB_CLI_REEXEC", "1");
        vi.stubEnv("BB_DATA_DIR", join(harness.config.dataDir, "owned-mcp-cli-data"));
        vi.stubEnv("BB_PRODUCT_ANALYTICS_MODE", undefined);
        const ambientMode = process.env.BB_PRODUCT_ANALYTICS_MODE;
        const plugin = await harness.pluginService.install("builtin:mcp", { kind: "root" });
        if (plugin.status !== "running") throw new Error(`Actual MCP plugin did not load: ${plugin.statusDetail}`);
        const path = `/api/v1/plugins/${plugin.id}/http/mcp`;
        const cases = [
          { mode: "smoke", projectId: work.id, name: "Owned smoke MCP subprocess update" },
          { mode: "production", projectId: personal.id, name: "Owned production MCP subprocess control" },
        ] as const;
        await Promise.all(cases.map(async (testCase) => {
          const headers = new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream" });
          headers.set(analyticsHeaders.mode, testCase.mode);
          headers.set(analyticsHeaders.actor, "agent");
          headers.set(analyticsHeaders.surface, "mcp");
          headers.set(analyticsHeaders.intent, "use");
          headers.set(analyticsHeaders.project, testCase.projectId);
          headers.set(analyticsHeaders.operation, randomUUID());
          const initialized = await harness.app.request(path, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "owned-subprocess-provenance", version: "1" } } }) });
          expect(initialized.status).toBe(200);
          await initialized.text();
          const sessionId = initialized.headers.get("mcp-session-id");
          if (sessionId !== null) headers.set("mcp-session-id", sessionId);
          headers.set("mcp-protocol-version", "2025-11-25");
          headers.set(analyticsHeaders.operation, randomUUID());
          const code = `return await bb.json(["project", "update", ${JSON.stringify(testCase.projectId)}, "--name", ${JSON.stringify(testCase.name)}]);`;
          const called = await harness.app.request(path, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run", arguments: { code } } }) });
          expect(called.status).toBe(200);
          expect(await called.text()).toContain(testCase.name);
          expect(getProject(harness.db, testCase.projectId)).toMatchObject({ name: testCase.name });
        }));
        for (const testCase of cases) {
          const result = consumerReport(collector, testCase.projectId, testCase.mode);
          expect(result.rows.find((row) => row.featureId === `plugin.${plugin.id}` && row.action === "mcp.run")).toMatchObject({ attempts: 1, successes: 1, failures: 0, agent: 1 });
          expect(result.rows.find((row) => row.featureId === "core.projects" && row.action === "update")).toMatchObject({ attempts: 1, successes: 1, failures: 0, human: 0 });
          expect(collector.report({ days: 7, mode: testCase.mode, projectId: testCase.projectId, surface: "mcp" }).rows.find((row) => row.featureId === "core.projects" && row.action === "update")).toMatchObject({ attempts: 1, successes: 1 });
          const otherMode = testCase.mode === "smoke" ? "production" : "smoke";
          expect(consumerReport(collector, testCase.projectId, otherMode).rows.find((row) => row.featureId === "core.projects" && row.action === "update")).toMatchObject({ attempts: 0, successes: 0, lastUsedAt: null });
          expect(environmentAtMutation.get(testCase.projectId)).toBe(null);
        }
        expect(process.env.BB_PRODUCT_ANALYTICS_MODE).toBe(ambientMode);
        const stored = JSON.stringify(harness.db.select().from(productAnalyticsEvents).all());
        for (const testCase of cases) expect(stored).not.toContain(testCase.name);
      }, (request) => {
        const match = /^\/api\/v1\/projects\/([^/]+)$/.exec(new URL(request.url).pathname);
        if (request.method === "PATCH" && match?.[1] !== undefined) environmentAtMutation.set(match[1], process.env.BB_PRODUCT_ANALYTICS_MODE ?? null);
      });
    });
  });
});

describe("analytics cold MCP command-index subprocess", () => {
  it.each([
    { tool: "search", mode: "smoke" },
    { tool: "search", mode: "test" },
    { tool: "read", mode: "smoke" },
    { tool: "read", mode: "test" },
  ] as const)("keeps a cold $tool index child in $mode during a concurrent production request", async ({ tool, mode }) => {
    await withAnalyticsConsumer(async ({ harness, collector, work, personal }) => {
      const environmentDuringChildRequests: (string | null)[] = [];
      await withListeningAnalyticsCli(harness, async () => {
        const launcher = await writeAnalyticsCliLauncher(join(harness.config.dataDir, "owned-cold-index-launcher"));
        vi.stubEnv("BB_CLI", launcher);
        vi.stubEnv("BB_CLI_REEXEC", "1");
        vi.stubEnv("BB_DATA_DIR", join(harness.config.dataDir, "owned-cold-index-cli-data"));
        vi.stubEnv("BB_PRODUCT_ANALYTICS_MODE", "production");
        const plugin = await harness.pluginService.install("builtin:mcp", { kind: "root" });
        if (plugin.status !== "running") throw new Error(`Actual MCP plugin did not load: ${plugin.statusDetail}`);
        const path = `/api/v1/plugins/${plugin.id}/http/mcp`;
        const invoke = async (requestMode: "production" | "smoke" | "test", projectId: string, name: "search" | "read" | "run", args: { query: string; limit: number } | { code: string }) => {
          const headers = new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream" });
          headers.set(analyticsHeaders.mode, requestMode);
          headers.set(analyticsHeaders.actor, "agent");
          headers.set(analyticsHeaders.surface, "mcp");
          headers.set(analyticsHeaders.intent, "use");
          headers.set(analyticsHeaders.project, projectId);
          headers.set(analyticsHeaders.operation, randomUUID());
          const initialized = await harness.app.request(path, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "owned-cold-index-consumer", version: "1" } } }) });
          expect(initialized.status).toBe(200);
          await initialized.text();
          const sessionId = initialized.headers.get("mcp-session-id");
          if (sessionId !== null) headers.set("mcp-session-id", sessionId);
          headers.set("mcp-protocol-version", "2025-11-25");
          headers.set(analyticsHeaders.operation, randomUUID());
          const called = await harness.app.request(path, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }) });
          expect(called.status).toBe(200);
          return called.text();
        };
        const productionName = `Owned ${tool} ${mode} concurrent production control`;
        const [coldResult, productionResult] = await Promise.all([
          invoke(mode, work.id, tool, tool === "search" ? { query: "project show", limit: 5 } : { code: `return await bb.json(["project", "show", ${JSON.stringify(work.id)}]);` }),
          invoke("production", personal.id, "run", { code: `return await bb.json(["project", "update", ${JSON.stringify(personal.id)}, "--name", ${JSON.stringify(productionName)}]);` }),
        ]);
        expect(coldResult).toContain(tool === "search" ? "bb project show" : work.id);
        expect(productionResult).toContain(productionName);
        expect(getProject(harness.db, personal.id)).toMatchObject({ name: productionName });
        const guideEvents = harness.db.select({ mode: productAnalyticsEvents.mode, stage: productAnalyticsEvents.stage, outcome: productAnalyticsEvents.outcome, surface: productAnalyticsEvents.surface, actorKind: productAnalyticsEvents.actorKind }).from(productAnalyticsEvents).where(and(eq(productAnalyticsEvents.featureId, "cli.local"), eq(productAnalyticsEvents.action, "guide"))).orderBy(productAnalyticsEvents.stage).all();
        expect(guideEvents).toEqual([
          { mode, stage: "completed", outcome: "succeeded", surface: "mcp", actorKind: "unknown" },
          { mode, stage: "started", outcome: "none", surface: "mcp", actorKind: "unknown" },
        ]);
        expect(consumerReport(collector, work.id, mode).rows.find((row) => row.featureId === `plugin.${plugin.id}` && row.action === `mcp.${tool}`)).toMatchObject({ attempts: 1, successes: 1, failures: 0, agent: 1 });
        const production = consumerReport(collector, personal.id, "production");
        expect(production.rows.find((row) => row.featureId === `plugin.${plugin.id}` && row.action === "mcp.run")).toMatchObject({ attempts: 1, successes: 1, failures: 0, agent: 1 });
        expect(production.rows.find((row) => row.featureId === "core.projects" && row.action === "update")).toMatchObject({ attempts: 1, successes: 1, failures: 0, human: 0 });
        expect(new Set(environmentDuringChildRequests)).toEqual(new Set(["production"]));
        expect(process.env.BB_PRODUCT_ANALYTICS_MODE).toBe("production");
      }, (request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/api/v1/system/product-analytics/events" || (request.method === "PATCH" && /^\/api\/v1\/projects\/[^/]+$/.test(pathname))) environmentDuringChildRequests.push(process.env.BB_PRODUCT_ANALYTICS_MODE ?? null);
      });
    });
  });
});
