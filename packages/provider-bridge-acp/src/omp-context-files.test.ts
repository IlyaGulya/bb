import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionContextSnapshot } from "@bb/domain";
import { afterEach, describe, expect, it } from "vitest";
import { OmpContextStore, type ResolveOmpContextArgs } from "./omp-context-files.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(overrides: Partial<ExecutionContextSnapshot> = {}) {
  const root = mkdtempSync(join(tmpdir(), "bb-omp-context-"));
  temporary.push(root);
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const data = join(root, "provider");
  const context: ExecutionContextSnapshot = {
    id: "work", name: "Work", enabled: true, projectIds: [],
    instructions: "SELECTED WORK INSTRUCTIONS", skillRoots: [], commandRoots: [],
    pluginRoots: [], settingsPaths: [], mcpServers: [], hooksPath: null,
    autoMemory: false, gitIdentity: null, defaultModelConnectionId: null,
    createdAt: 1, updatedAt: 1, ...overrides,
  };
  const args: ResolveOmpContextArgs = { threadId: "thread", cwd, executionContext: context, resume: false };
  return { root, cwd, data, context, args, store: new OmpContextStore(data) };
}

function source(root: string, name: string, content: string): string {
  const path = join(root, name);
  writeFileSync(path, content);
  return path;
}

describe("OMP selected native context sources", () => {
  it("loads native nested YAML and JSON setting IDs without ambient ancestors or native instructions", () => {
    const f = fixture();
    mkdirSync(join(f.root, ".omp"));
    source(join(f.root, ".omp"), "config.yml", "auth: PRIVATE_ANCESTOR\n");
    source(f.root, "AGENTS.md", "PRIVATE ANCESTOR INSTRUCTIONS");
    mkdirSync(join(f.cwd, ".omp"));
    source(join(f.cwd, ".omp"), "config.yml", "provider: PRIVATE_PROJECT\n");
    source(f.cwd, "AGENTS.md", "BB ALREADY INJECTS REPO INSTRUCTIONS");
    const yaml = source(f.root, "selected.yml", "compaction:\n  enabled: false\n  keepRecentTokens: 4096\nbash:\n  gitGuard: true\n");
    const json = source(f.root, "settings.json", '{"compaction.enabled":true,"edit":{"fuzzyMatch":false}}');
    f.context.settingsPaths = [yaml, json];
    const files = f.store.resolve(f.args);
    expect(files.settingsOverrides).toMatchObject({
      "compaction.enabled": true, "compaction.keepRecentTokens": 4096,
      "bash.gitGuard": true, "edit.fuzzyMatch": false,
      "memory.backend": "off", "memories.enabled": false,
      "mnemopi.autoRecall": false, "mnemopi.autoRetain": false,
      "mcp.enableProjectConfig": false, "bash.direnv": "off",
    });
    expect(files.contextFiles).toEqual([]);
    source(f.root, "AGENTS.md", "CHANGED UNSELECTED ANCESTOR");
    files.verify();
    expect(new OmpContextStore(f.data).resolve({ ...f.args, resume: true }).settingsOverrides).toEqual(files.settingsOverrides);
  });

  it("selects only named MCP entries and preserves secrets only in memory, never the hash receipt", () => {
    const f = fixture();
    const mcp = source(f.root, "mcp.json", JSON.stringify({
      mcpServers: {
        selected: { command: "selected-server", args: ["--safe"], env: { TOKEN: "SELECTED_PRIVATE_TOKEN" } },
        sibling: { type: "unsupported", command: "PRIVATE_SIBLING_COMMAND", oauth: { clientSecret: "PRIVATE" } },
      },
    }));
    f.context.mcpServers = [{ name: "selected", configPath: mcp }];
    const files = f.store.resolve(f.args);
    expect(files.mcpServers).toEqual({ selected: { type: "stdio", command: "selected-server", args: ["--safe"], env: { TOKEN: "SELECTED_PRIVATE_TOKEN" } } });
    const receipts = join(f.data, "execution-contexts");
    const path = join(receipts, readdirSync(receipts)[0]!);
    const receipt = readFileSync(path, "utf8");
    expect(JSON.parse(receipt)).toEqual({ version: 1, digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(receipt).not.toMatch(/PRIVATE|selected-server|Work|INSTRUCTIONS|mcp\.json/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("normalizes selected HTTP and SSE server fields losslessly", () => {
    const f = fixture();
    const mcp = source(f.root, "mcp.json", JSON.stringify({ mcpServers: {
      http: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "private-reference" } },
      sse: { type: "sse", url: "http://127.0.0.1/events" },
    } }));
    f.context.mcpServers = ["http", "sse"].map((name) => ({ name, configPath: mcp }));
    expect(f.store.resolve(f.args).mcpServers).toEqual({
      http: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "private-reference" } },
      sse: { type: "sse", url: "http://127.0.0.1/events", headers: {} },
    });
  });

  it.each(["timeout", "oauth", "auth", "cwd", "enabled", "requestIdFormat", "instructions"])("rejects selected MCP %s instead of silently dropping it", (field) => {
    const f = fixture();
    const path = source(f.root, "mcp.json", JSON.stringify({ mcpServers: { selected: { command: "server", [field]: "unsupported" } } }));
    f.context.mcpServers = [{ name: "selected", configPath: path }];
    expect(() => f.store.resolve(f.args)).toThrow("unsupported native transport/options");
  });

  it.each([
    "apiKey: PRIVATE", "auth:\n  token: PRIVATE", "providers:\n  custom:\n    baseUrl: https://example.invalid",
    "model: private-route", "modelRoles:\n  default: private-route", "env:\n  ANTHROPIC_API_KEY: PRIVATE",
    "extensions: [/private]", "skills:\n  customDirectories: [/private]", "contextFiles:\n  extra: [/private]",
    "hooks: {}", "memory:\n  backend: local", "unknownFutureControl: true",
  ])("refuses credential/routing/discovery or unsupported side setting %s", (settings) => {
    const f = fixture();
    f.context.settingsPaths = [source(f.root, "selected.yml", settings)];
    expect(() => f.store.resolve(f.args)).toThrow("OMP scoped settings do not support");
  });

  it.each(["compaction:\n  enabled: yes", "edit:\n  fuzzyThreshold: 2", "compaction.enabled: true\ncompaction:\n  enabled: false"])("rejects invalid or ambiguous native settings %s", (settings) => {
    const f = fixture();
    f.context.settingsPaths = [source(f.root, "selected.yml", settings)];
    expect(() => f.store.resolve(f.args)).toThrow(/invalid native value|declared twice/);
  });

  it("matches native manifest precedence, including indexed directories, without importing modules", () => {
    const f = fixture();
    const plugin = join(f.root, "plugin");
    mkdirSync(join(plugin, "entry"), { recursive: true });
    source(plugin, "package.json", JSON.stringify({ omp: { extensions: ["entry", "chosen.js"] } }));
    const indexed = source(join(plugin, "entry"), "index.ts", 'throw new Error("must not execute during source selection");');
    const chosen = source(plugin, "chosen.js", "export default function(pi) { pi.on('session_start', () => {}); }");
    source(plugin, "index.ts", "PRIVATE NONSELECTED ENTRY");
    source(plugin, "sibling.ts", "PRIVATE NONSELECTED ENTRY");
    const hooks = source(f.root, "hooks.ts", "export default function(pi) { pi.on('tool_call', () => {}); }");
    f.context.pluginRoots = [plugin];
    f.context.hooksPath = hooks;
    const files = f.store.resolve(f.args);
    expect(files.extensionPaths).toEqual([indexed, chosen, hooks]);
    expect(files.pluginRoots).toEqual([plugin]);
  });

  it("matches native index and one-level configured extension scan fallback", () => {
    const f = fixture();
    const indexed = join(f.root, "indexed");
    const scanned = join(f.root, "scanned");
    mkdirSync(indexed);
    mkdirSync(join(scanned, "child"), { recursive: true });
    const main = source(indexed, "index.js", "export default function() {}");
    source(indexed, "ignored.ts", "not selected");
    const direct = source(scanned, "direct.ts", "export default function() {}");
    const child = source(join(scanned, "child"), "index.ts", "export default function() {}");
    source(scanned, "not-a-module.json", "{}");
    f.context.pluginRoots = [indexed, scanned];
    expect(f.store.resolve(f.args).extensionPaths).toEqual(expect.arrayContaining([main, direct, child]));
    expect(f.store.resolve(f.args).extensionPaths).toHaveLength(3);
  });

  it("refuses Claude JSON hook definitions with actionable native extension guidance", () => {
    const f = fixture();
    f.context.hooksPath = source(f.root, "hooks.json", '{"hooks":{"PreToolUse":[]}}');
    expect(() => f.store.resolve(f.args)).toThrow("module exporting a default extension factory, not JSON command hooks");
  });

  it("refuses an empty or shell-only hooks root rather than silently dropping hooks", () => {
    const f = fixture();
    const hooks = join(f.root, "hooks");
    mkdirSync(hooks);
    source(hooks, "pre-tool.sh", "exit 0");
    f.context.hooksPath = hooks;
    expect(() => f.store.resolve(f.args)).toThrow("contains no native extension modules");
  });

  it("refuses manifest paths outside the selected plugin and stale explicit entries", () => {
    const f = fixture();
    const plugin = join(f.root, "plugin");
    mkdirSync(plugin);
    source(f.root, "private.ts", "private module");
    const manifest = source(plugin, "package.json", '{"omp":{"extensions":["../private.ts"]}}');
    f.context.pluginRoots = [plugin];
    expect(() => f.store.resolve(f.args)).toThrow("must remain inside their selected root");
    writeFileSync(manifest, '{"omp":{"extensions":["missing.ts"]}}');
    expect(() => f.store.resolve(f.args)).toThrow();
  });

  it("refuses changed selected sources for active and resumed bindings", () => {
    const f = fixture();
    const skills = join(f.root, "skills");
    mkdirSync(skills);
    const selected = source(skills, "SKILL.md", "ORIGINAL SELECTED SKILL");
    f.context.skillRoots = [skills];
    const files = f.store.resolve(f.args);
    writeFileSync(selected, "CHANGED SELECTED SKILL");
    expect(() => files.verify()).toThrow("sources changed");
    expect(() => f.store.resolve(f.args)).toThrow("selected sources changed");
    expect(() => new OmpContextStore(f.data).resolve({ ...f.args, resume: true })).toThrow("changed since this thread started");
  });

  it("refuses missing selected sources rather than replacing them with ambient context", () => {
    const f = fixture();
    const selected = source(f.root, "selected.json", "{}");
    f.context.settingsPaths = [selected];
    const files = f.store.resolve(f.args);
    unlinkSync(selected);
    expect(() => files.verify()).toThrow("missing, unreadable or unsafe");
    expect(() => new OmpContextStore(f.data).resolve({ ...f.args, resume: true })).toThrow("ambient files will not be substituted");
  });

  it("requires a valid unchanged receipt even for cached resolutions", () => {
    const f = fixture();
    const files = f.store.resolve(f.args);
    const receipts = join(f.data, "execution-contexts");
    const receipt = join(receipts, readdirSync(receipts)[0]!);
    writeFileSync(receipt, "not JSON");
    expect(() => files.verify()).toThrow("invalid host source receipt");
    expect(() => f.store.resolve(f.args)).toThrow("invalid host source receipt");
    unlinkSync(receipt);
    expect(() => files.verify()).toThrow("source receipt is missing or changed");
    expect(() => new OmpContextStore(f.data).resolve({ ...f.args, resume: true })).toThrow("without its host source receipt");
    expect(() => f.store.resolve(f.args)).toThrow("without its host source receipt");
  });

  it("binds instruction text and selected source roots immutably", () => {
    const f = fixture();
    const files = f.store.resolve(f.args);
    f.context.instructions = "DIFFERENT CONTEXT";
    // Verify retains the admitted snapshot, not a mutable caller-owned reference.
    files.verify();
    expect(() => f.store.resolve(f.args)).toThrow("immutable binding");
    expect(() => new OmpContextStore(f.data).resolve({ ...f.args, resume: true })).toThrow("changed since this thread started");
  });

  it("rejects cyclic roots before recursion can escape or hang admission", () => {
    const f = fixture();
    const skills = join(f.root, "skills");
    mkdirSync(skills);
    symlinkSync(skills, join(skills, "cycle"));
    f.context.skillRoots = [skills];
    expect(() => f.store.resolve(f.args)).toThrow("unsafe");
    try {
      f.store.resolve(f.args);
    } catch (error) {
      expect((error as Error).cause).toMatchObject({ message: expect.stringContaining("symlink cycle") });
    }
  });

  it("rejects special files before attempting a potentially blocking read", () => {
    const f = fixture();
    const commands = join(f.root, "commands");
    mkdirSync(commands);
    execFileSync("mkfifo", [join(commands, "pipe")]);
    f.context.commandRoots = [commands];
    expect(() => f.store.resolve(f.args)).toThrow("unsafe");
    try {
      f.store.resolve(f.args);
    } catch (error) {
      expect((error as Error).cause).toMatchObject({ message: expect.stringContaining("special files are unsupported") });
    }
  });

  it("rejects unscoped native auto-memory and relative references", () => {
    const f = fixture({ autoMemory: true });
    expect(() => f.store.resolve(f.args)).toThrow("no isolated native memory namespace");
    f.context.autoMemory = false;
    f.context.skillRoots = ["relative/skills"];
    expect(() => f.store.resolve(f.args)).toThrow("unsafe");
    f.context.skillRoots = [];
    expect(() => f.store.resolve({ ...f.args, cwd: "relative" })).toThrow("host-absolute");
  });
});
