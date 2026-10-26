import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  MCP_INSPECTION_MAX_FILE_BYTES,
  MCP_INSPECTION_MAX_SERVERS,
  mcpConfigurationInspectionSchema,
  validateSelectedMcpServers,
} from "@bb/domain";
import { afterEach, describe, expect, it } from "vitest";
import { inspectHostMcpSources } from "./inspect-mcp.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bb-mcp-inspection-"));
  roots.push(dir);
  return dir;
}
async function fixture(value: unknown): Promise<string> {
  const path = join(await root(), "mcp.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}
async function inspect(configPaths: string[], providerId = "claude-code") {
  return inspectHostMcpSources({ type: "host.inspect_mcp_sources", providerId, configPaths });
}

describe("worker MCP configuration inspection", () => {
  it("returns only selected metadata, never descriptors, credentials or native diagnostics", async () => {
    const secret = "private-fixture-marker-do-not-return";
    const configPath = await fixture({ mcpServers: {
      local: { command: secret, args: [secret], env: { TOKEN: secret } },
      remote: { type: "http", url: `https://example.invalid/${secret}`, headers: { Authorization: secret } },
      unsupported: { command: secret, oauth: { clientSecret: secret } },
      "bb-bridge": { command: secret },
    } });
    const { files } = await inspect([configPath]);
    expect(files).toEqual([{ configPath, status: "ok", issue: null, servers: [
      { name: "local", transport: "stdio", supported: true, issue: null, authStatus: "not_checked" },
      { name: "remote", transport: "http", supported: true, issue: null, authStatus: "not_checked" },
      { name: "unsupported", transport: "unsupported", supported: false, issue: "Unsupported server descriptor", authStatus: "not_checked" },
      { name: "bb-bridge", transport: "stdio", supported: false, issue: "Reserved server name", authStatus: "not_checked" },
    ] }]);
    expect(JSON.stringify(files)).not.toContain(secret);
    const inspection = mcpConfigurationInspectionSchema.parse({ hostId: "worker", providerId: "claude-code", files });
    expect(validateSelectedMcpServers([{ name: "local", configPath }], inspection)).toBeNull();
    expect(validateSelectedMcpServers([{ name: "unsupported", configPath }], inspection)).not.toBeNull();
  });

  it.each([
    [{ command: "server" }, true, true],
    [{ type: "stdio", command: "server", args: [], env: {} }, true, true],
    [{ command: "server", timeout: 10, alwaysLoad: false }, true, false],
    [{ type: "http", url: "https://example.invalid/mcp", headers: { X: "value" } }, true, true],
    [{ type: "sse", url: "https://example.invalid/events" }, true, true],
    [{ type: "http", url: "https://user:password@example.invalid/mcp" }, true, false],
    [{ type: "http", url: "file:///tmp/native" }, true, false],
    [{ command: "server", cwd: "/tmp" }, false, false],
    [{ command: "server", oauth: {} }, false, false],
    [{ type: "http", url: "https://example.invalid", headersHelper: "helper" }, false, false],
    [{ type: "claudeai-proxy", url: "https://example.invalid" }, false, false],
    [{ command: "server", env: { BAD: 5 } }, false, false],
    [{ type: "stdio", command: "" }, false, false],
  ])("preserves native provider descriptor semantics for %j", async (descriptor, claude, omp) => {
    const configPath = await fixture({ mcpServers: { selected: descriptor } });
    expect((await inspect([configPath], "claude-code")).files[0]?.servers[0]?.supported).toBe(claude);
    expect((await inspect([configPath], "acp-omp")).files[0]?.servers[0]?.supported).toBe(omp);
  });

  it("preserves differing native top-level controls instead of accepting a common permissive subset", async () => {
    const path = await fixture({ $schema: "https://example.invalid/schema", mcpServers: { selected: { command: "server" } } });
    expect((await inspect([path], "claude-code")).files[0]).toMatchObject({ status: "invalid", issue: "Unsupported configuration structure", servers: [] });
    expect((await inspect([path], "acp-omp")).files[0]).toMatchObject({ status: "ok", issue: null });
    const unknown = await fixture({ mcpServers: {}, nativeGlobalAuth: "never-leak" });
    expect((await inspect([unknown], "acp-omp")).files[0]).toMatchObject({ status: "invalid", servers: [] });
  });

  it("bounds file bytes and server count while accepting exact limits", async () => {
    const path = await fixture({ mcpServers: {} });
    const minimal = '{"mcpServers":{}}';
    await writeFile(path, minimal + " ".repeat(MCP_INSPECTION_MAX_FILE_BYTES - minimal.length));
    expect((await inspect([path])).files[0]?.status).toBe("ok");
    await writeFile(path, " ".repeat(MCP_INSPECTION_MAX_FILE_BYTES + 1));
    expect((await inspect([path])).files[0]).toMatchObject({ status: "invalid", issue: "Configuration exceeds size limit", servers: [] });
    const servers = Object.fromEntries(Array.from({ length: MCP_INSPECTION_MAX_SERVERS }, (_, i) => [`s${i}`, { command: "server" }]));
    await writeFile(path, JSON.stringify({ mcpServers: servers }));
    expect((await inspect([path])).files[0]?.servers).toHaveLength(MCP_INSPECTION_MAX_SERVERS);
    await writeFile(path, JSON.stringify({ mcpServers: { ...servers, excess: { command: "server" } } }));
    expect((await inspect([path])).files[0]).toMatchObject({ issue: "Configuration exceeds server limit", servers: [] });
  });

  it("isolates missing, directory and malformed files using fixed diagnostics", async () => {
    const dir = await root();
    const missing = join(dir, "absent.json");
    const directory = join(dir, "directory");
    const malformed = join(dir, "invalid.json");
    await mkdir(directory);
    await writeFile(malformed, '{"mcpServers": "PRIVATE_INVALID_JSON');
    const { files } = await inspect([missing, directory, malformed]);
    expect(files.map(({ status, issue, servers }) => ({ status, issue, servers }))).toEqual([
      { status: "unavailable", issue: "Configuration unavailable", servers: [] },
      { status: "invalid", issue: "Configuration must be a regular file", servers: [] },
      { status: "invalid", issue: "Invalid JSON configuration", servers: [] },
    ]);
    expect(JSON.stringify(files)).not.toContain("PRIVATE_INVALID_JSON");
  });

  it.skipIf(process.platform === "win32")("refuses FIFOs without waiting for a writer", async () => {
    const fifo = join(await root(), "source.fifo");
    await promisify(execFile)("mkfifo", [fifo]);
    expect((await inspect([fifo])).files[0]).toMatchObject({ status: "invalid", issue: "Configuration must be a regular file", servers: [] });
  });

  it("rejects unsafe path/count requests and honestly refuses unsupported providers", async () => {
    await expect(inspect(["relative.json"])).rejects.toThrow();
    await expect(inspect(["/tmp/invalid\0.json"])).rejects.toThrow();
    await expect(inspect(Array.from({ length: 17 }, (_, i) => `/tmp/${i}`))).rejects.toThrow();
    const path = join(await root(), "missing.json");
    expect((await inspect([path], "other-provider")).files).toEqual([{ configPath: path, status: "invalid", issue: "Unsupported provider", servers: [] }]);
    expect(await inspect([])).toEqual({ files: [] });
  });
});
