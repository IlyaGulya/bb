import { Command } from "commander";
import { createCliBbSdk } from "../client.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerProjectCommands } from "../commands/project.js";
import { cliEnvironment, type CliRunner } from "../../../../plugins/mcp/src/cli-runner.js";
import { parseCommandIndex } from "../../../../plugins/mcp/src/command-index.js";
import { createBbMcpHttpHandler } from "../../../../plugins/mcp/src/mcp-handler.js";
import { consumerReport, withAnalyticsConsumer } from "../../../server/test/helpers/product-analytics-consumer.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("analytics real MCP CLI admission", () => {
  it("preserves explicit smoke mode through MCP environment and actual CLI action on a production server", async () => {
    await withAnalyticsConsumer(async ({ harness, collector, work }) => {
      const serverUrl = "http://localhost";
      vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => harness.app.request(new Request(input, init)));
      const runCli: CliRunner = async (argv) => {
        const env = cliEnvironment({ BB_PRODUCT_ANALYTICS_MODE: "smoke", BB_PROJECT_ID: work.id, BB_THREAD_ID: "thr_owner_context_must_be_stripped" }, serverUrl);
        for (const key of ["BB_PRODUCT_ANALYTICS_MODE", "BB_PRODUCT_ANALYTICS_SURFACE", "BB_PROJECT_ID", "BB_THREAD_ID"]) vi.stubEnv(key, env[key]);
        const lines: string[] = [];
        const log = vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => { lines.push(values.map(String).join(" ")); });
        try {
          const program = new Command().exitOverride();
          registerProjectCommands(program, () => serverUrl);
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
