import type { McpConfigurationFileInspection } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import { seedHostSession } from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function inspect(harness: TestAppHarness, hostId: string, providerId = "claude-code") {
  return harness.app.request("/api/v1/execution-contexts/mcp/inspect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hostId, providerId, configPaths: ["/fixtures/mcp.json"] }),
  });
}

describe("MCP configuration inspection API", () => {
  it("returns static sanitized metadata from the selected host and provider", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const files: McpConfigurationFileInspection[] = [{
        configPath: "/fixtures/mcp.json",
        status: "ok",
        issue: null,
        servers: [{ name: "calendar", transport: "http", supported: true, issue: null, authStatus: "not_checked" }],
      }];
      const rpc = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: () => ({ ok: true, result: { files } }),
      });
      const response = await inspect(harness, host.id);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ hostId: host.id, providerId: "claude-code", files });
      expect(rpc.requests.map((request) => request.command)).toEqual([{
        type: "host.inspect_mcp_sources", providerId: "claude-code", configPaths: ["/fixtures/mcp.json"],
      }]);
    });
  });

  it("refuses unsupported providers without contacting the worker", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const rpc = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: () => { throw new Error("Unexpected worker request"); },
      });
      const response = await inspect(harness, host.id, "codex");
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        code: "mcp_inspection_provider_unsupported",
        message: "MCP configuration inspection is unavailable for this provider.",
      });
      expect(rpc.requests).toEqual([]);
    });
  });

  it("does not expose native host failures or their secret-bearing diagnostics", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: () => ({ ok: false, errorCode: "native_parser_failure", errorMessage: "Authorization: Bearer fixture-secret https://private.example.test" }),
      });
      const response = await inspect(harness, host.id);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        code: "mcp_inspection_unavailable",
        message: "MCP configuration could not be inspected on the execution host.",
      });
    });
  });

  it("sanitizes offline and missing host errors", async () => {
    await withTestHarness(async (harness) => {
      const response = await inspect(harness, "missing-host");
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        code: "mcp_inspection_unavailable",
        message: "MCP configuration could not be inspected on the execution host.",
      });
    });
  });
});
