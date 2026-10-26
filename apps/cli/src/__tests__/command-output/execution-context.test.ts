import { describe, expect, it, vi } from "vitest";
import {
  collectLogLines,
  setupCommandOutputTestEnvironment,
  runCommand,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import { registerExecutionContextCommands } from "../../commands/execution-context.js";

describe("bb execution-context mcp-inspect", () => {
  setupCommandOutputTestEnvironment();
  const register: CommandRegistrar = (program) =>
    registerExecutionContextCommands(program, () => "http://server");

  it("preserves repeated host paths and reports static failures in JSON", async () => {
    const inspection = {
      hostId: "host-1",
      providerId: "claude-code",
      files: [
        {
          configPath: "/remote/mcp.json",
          status: "ok",
          issue: null,
          servers: [{
            name: "docs",
            transport: "stdio",
            supported: true,
            issue: null,
            authStatus: "not_checked",
          }],
        },
        {
          configPath: "/remote/missing.json",
          status: "unavailable",
          issue: "Configuration unavailable",
          servers: [],
        },
      ],
    };
    const post = vi.fn(async () => inspection);
    stubServerApi({ "v1.execution-contexts.mcp.inspect.$post": post });
    await runCommand([
      "execution-context", "mcp-inspect",
      "--machine", "host-1", "--provider", "claude-code",
      "--config", "/remote/mcp.json",
      "--config", "/remote/missing.json", "--json",
    ], register);
    expect(post).toHaveBeenCalledWith({ json: {
      hostId: "host-1",
      providerId: "claude-code",
      configPaths: ["/remote/mcp.json", "/remote/missing.json"],
    } });
    expect(JSON.parse(collectLogLines(vi.mocked(console.log)).join("\n"))).toEqual(inspection);
  });
});
