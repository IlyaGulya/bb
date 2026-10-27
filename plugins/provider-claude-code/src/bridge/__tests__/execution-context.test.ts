import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  experimental_executionContextSnapshotSchema as executionContextSnapshotSchema,
  experimental_modelConnectionSnapshotSchema as modelConnectionSnapshotSchema,
  type ExecutionContextSnapshot,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildClaudeSessionEnvironment,
  ClaudeContextStore,
  mergeClaudeMcpServers,
  mergeClaudeSettings,
  requireClaudeCloudImportControl,
} from "../execution-context.js";

let directory: string;

function context(id: string, fields: Partial<ExecutionContextSnapshot> = {}) {
  return executionContextSnapshotSchema.parse({
    id,
    name: id,
    createdAt: 1,
    updatedAt: 1,
    ...fields,
  });
}

function connection(configDir: string | null) {
  return modelConnectionSnapshotSchema.parse({
    id: "native-work",
    name: "Native work",
    provider: "claude-code",
    hostId: "host",
    nativeAuth: { configDir },
    createdAt: 1,
    updatedAt: 1,
  });
}

function json(name: string, value: unknown): string {
  const path = join(directory, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "bb-claude-context-test-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("scoped Claude context files", () => {
  it("resumes pre-gateway native receipts without rewriting them or changing auth sources", () => {
    const snapshot = connection(null);
    const { gateway: _gateway, ...legacyConnection } = snapshot;
    const threadId = "legacy-native";
    const state = join(directory, "state");
    const receipts = join(state, "execution-contexts");
    mkdirSync(receipts, { recursive: true });
    const receiptPath = join(
      receipts,
      `${createHash("sha256").update(threadId).digest("hex")}.json`,
    );
    const original = JSON.stringify({
      version: 1,
      digest: createHash("sha256")
        .update(
          JSON.stringify({
            executionContext: null,
            modelConnection: legacyConnection,
          }),
        )
        .digest("hex"),
    });
    writeFileSync(receiptPath, original, { mode: 0o600 });
    const files = new ClaudeContextStore(state).resolve({
      threadId,
      modelConnection: snapshot,
      resume: true,
    })!;
    files.verify();
    expect(readFileSync(receiptPath, "utf8")).toBe(original);
    const changedSource = join(directory, "changed-native-source");
    mkdirSync(changedSource);
    expect(() =>
      new ClaudeContextStore(state).resolve({
        threadId,
        modelConnection: {
          ...snapshot,
          nativeAuth: { ...snapshot.nativeAuth, configDir: changedSource },
        },
        resume: true,
      }),
    ).toThrow();
  });
  it("opts into a host-native MCP profile without importing its settings or changing legacy context defaults", () => {
    const profileRoot = join(directory, "native-mcp-profile");
    mkdirSync(profileRoot);
    const snapshot = context("selected-native-mcp", {
      claudeNativeMcp: { configDir: profileRoot },
    });
    const native = connection(profileRoot);
    const store = new ClaudeContextStore(join(directory, "state"));
    const files = store.resolve({
      threadId: "native-profile", executionContext: snapshot,
      modelConnection: native, resume: false,
    })!;
    expect(files.settings).toEqual({});
    expect(files.mcpServers).toEqual({});
    const launchEnv = {
      HOME: "/unchanged-home", CLAUDE_CONFIG_DIR: "/unselected-profile",
      ANTHROPIC_API_KEY: "ambient-key", ANTHROPIC_AUTH_TOKEN: "ambient-token",
    };
    const env = buildClaudeSessionEnvironment({
      env: launchEnv, executionContext: snapshot, modelConnection: native,
    });
    expect(env.HOME).toBe(launchEnv.HOME);
    expect(env.CLAUDE_CONFIG_DIR).toBe(profileRoot);
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("true");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(launchEnv.CLAUDE_CONFIG_DIR).toBe("/unselected-profile");
    expect(() => buildClaudeSessionEnvironment({
      env: {}, executionContext: snapshot, modelConnection: connection(null),
    })).toThrow("same configDir");
    expect(() => new ClaudeContextStore(join(directory, "state")).resolve({
      threadId: "native-profile",
      executionContext: context("selected-native-mcp"),
      modelConnection: native, resume: true,
    })).toThrow("changed");
  });

  it("keeps simultaneous contexts and direct MCP inventories independent on the same native account", async () => {
    const account = join(directory, "native-account");
    mkdirSync(account);
    const configPath = json("servers.json", {
      mcpServers: {
        work: { command: "work-fixture", args: ["--stdio"] },
        personal: { type: "http", url: "https://personal.invalid/mcp" },
        imported: { type: "claudeai-proxy", id: "not-selected" },
      },
    });
    const work = context("work", {
      mcpServers: [{ name: "work", configPath }],
    });
    const personal = context("personal", {
      mcpServers: [{ name: "personal", configPath }],
    });
    const store = new ClaudeContextStore(join(directory, "state"));
    const native = connection(account);
    const [workFiles, personalFiles] = await Promise.all([
      Promise.resolve().then(() =>
        store.resolve({
          threadId: "work-thread",
          executionContext: work,
          modelConnection: native,
          resume: false,
        }),
      ),
      Promise.resolve().then(() =>
        store.resolve({
          threadId: "personal-thread",
          executionContext: personal,
          modelConnection: native,
          resume: false,
        }),
      ),
    ]);
    expect(Object.keys(workFiles!.mcpServers)).toEqual(["work"]);
    expect(Object.keys(personalFiles!.mcpServers)).toEqual(["personal"]);
    const bridge: McpServerConfig = { command: "bb-fixture-bridge" };
    const workServers = mergeClaudeMcpServers(workFiles!.mcpServers, bridge);
    const personalServers = mergeClaudeMcpServers(
      personalFiles!.mcpServers,
      bridge,
    );
    expect(Object.keys(workServers)).toEqual(["work", "bb-bridge"]);
    expect(Object.keys(personalServers)).toEqual(["personal", "bb-bridge"]);
    expect(workServers["bb-bridge"]).toBe(bridge);
    expect(Object.keys(workFiles!.mcpServers)).toEqual(["work"]);
    const env = {
      HOME: "/unchanged-home",
      CLAUDE_CONFIG_DIR: "/ambient-account",
      ENABLE_CLAUDEAI_MCP_SERVERS: "true",
    };
    const workEnv = buildClaudeSessionEnvironment({
      env,
      executionContext: work,
      modelConnection: native,
    });
    const personalEnv = buildClaudeSessionEnvironment({
      env,
      executionContext: personal,
      modelConnection: native,
    });
    expect(workEnv.CLAUDE_CONFIG_DIR).toBe(personalEnv.CLAUDE_CONFIG_DIR);
    expect(workEnv.HOME).toBe("/unchanged-home");
    expect(workEnv.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("true");
  });

  it("reads only selected settings and hooks, preserves hook order, and refuses context/auth crossover", () => {
    const first = json("settings-a.json", {
      permissions: { deny: ["Bash(rm *)"] },
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "selected-start" }] },
        ],
      },
    });
    const second = json("settings-b.json", {
      language: "English",
      permissions: { ask: ["Bash(git push *)"] },
    });
    const hooks = json("hooks.json", {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "selected-second" }] },
        ],
      },
    });
    json("ambient-settings.json", {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "never-load" }] }],
      },
    });
    const store = new ClaudeContextStore(join(directory, "state"));
    const files = store.resolve({
      threadId: "hooks",
      executionContext: context("work", {
        settingsPaths: [first, second],
        hooksPath: hooks,
      }),
      resume: false,
    })!;
    expect(files.settings.permissions).toEqual({
      deny: ["Bash(rm *)"],
      ask: ["Bash(git push *)"],
    });
    expect(
      files.settings.hooks?.SessionStart?.flatMap((matcher) => matcher.hooks),
    ).toEqual([
      { type: "command", command: "selected-start" },
      { type: "command", command: "selected-second" },
    ]);
    const invalid = json("invalid.json", {
      env: { CLAUDE_CONFIG_DIR: "/other-account" },
    });
    expect(() =>
      store.resolve({
        threadId: "invalid",
        executionContext: context("invalid", { settingsPaths: [invalid] }),
        resume: false,
      }),
    ).toThrow("do not support 'env'");
    const invalidHook = json("invalid-hook.json", {
      hooks: { SessionStart: [{ hooks: [{ type: "command" }] }] },
    });
    expect(() =>
      store.resolve({
        threadId: "bad-hook",
        executionContext: context("bad-hook", { hooksPath: invalidHook }),
        resume: false,
      }),
    ).toThrow("invalid native hook definitions");
    const foreignMcpHook = json("foreign-mcp-hook.json", {
      hooks: {
        PreToolUse: [
          { hooks: [{ type: "mcp_tool", server: "sibling", tool: "read" }] },
        ],
      },
    });
    expect(() =>
      store.resolve({
        threadId: "foreign-hook",
        executionContext: context("foreign-hook", {
          hooksPath: foreignMcpHook,
        }),
        resume: false,
      }),
    ).toThrow("outside the selected context");
  });

  it("rejects modified source content on continuation and on a fresh host resume, without storing source bodies", () => {
    const path = json("selected-settings.json", { language: "English" });
    const selected = context("work", { settingsPaths: [path] });
    const dataDir = join(directory, "state");
    const store = new ClaudeContextStore(dataDir);
    const files = store.resolve({
      threadId: "thread",
      executionContext: selected,
      resume: false,
    })!;
    const restored = new ClaudeContextStore(dataDir).resolve({
      threadId: "thread",
      executionContext: selected,
      resume: true,
    });
    expect(restored?.settings.language).toBe("English");
    writeFileSync(path, JSON.stringify({ language: "French" }));
    expect(() => files.verify()).toThrow(
      "changed while this thread was active",
    );
    expect(() =>
      new ClaudeContextStore(dataDir).resolve({
        threadId: "thread",
        executionContext: selected,
        resume: true,
      }),
    ).toThrow("changed since this thread started");
    const receipt = readFileSync(
      join(
        dataDir,
        "execution-contexts",
        readdirSync(join(dataDir, "execution-contexts"))[0]!,
      ),
      "utf8",
    );
    expect(JSON.parse(receipt)).toEqual({
      version: 1,
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(receipt).not.toContain("English");
    expect(receipt).not.toContain(path);
  });

  it("detects edits inherited through selected symlink roots and ignores unrelated sibling roots", () => {
    const selectedRoot = join(directory, "selected");
    const linkedRoot = join(directory, "linked");
    const siblingRoot = join(directory, "sibling");
    mkdirSync(selectedRoot);
    mkdirSync(linkedRoot);
    mkdirSync(siblingRoot);
    writeFileSync(join(linkedRoot, "SKILL.md"), "selected skill");
    writeFileSync(join(siblingRoot, "SKILL.md"), "sibling skill");
    symlinkSync(linkedRoot, join(selectedRoot, "skill"), "dir");
    const store = new ClaudeContextStore(join(directory, "state"));
    const files = store.resolve({
      threadId: "root",
      executionContext: context("work", { skillRoots: [selectedRoot] }),
      resume: false,
    })!;
    writeFileSync(join(siblingRoot, "SKILL.md"), "changed unrelated sibling");
    expect(() => files.verify()).not.toThrow();
    writeFileSync(join(linkedRoot, "SKILL.md"), "changed selected skill");
    expect(() => files.verify()).toThrow("changed");
  });

  it("refuses unknown receipts, memory leakage, reserved MCP names and same-thread rebinding", () => {
    const store = new ClaudeContextStore(join(directory, "state"));
    const work = context("work");
    expect(() =>
      store.resolve({
        threadId: "missing",
        executionContext: work,
        resume: true,
      }),
    ).toThrow("without its host context receipt");
    expect(() =>
      store.resolve({
        threadId: "memory",
        executionContext: context("memory", { autoMemory: true }),
        resume: false,
      }),
    ).toThrow("scoped auto-memory is unsupported");
    const configPath = json("bridge.json", {
      mcpServers: { "bb-bridge": { command: "override" } },
    });
    expect(() =>
      store.resolve({
        threadId: "bridge",
        executionContext: context("bridge", {
          mcpServers: [{ name: "bb-bridge", configPath }],
        }),
        resume: false,
      }),
    ).toThrow("cannot replace bb-bridge");
    store.resolve({ threadId: "bound", executionContext: work, resume: false });
    expect(() =>
      store.resolve({
        threadId: "bound",
        executionContext: context("personal"),
        resume: false,
      }),
    ).toThrow("keeps its original binding");
  });

  it("retains selected sandbox restrictions when the host adds its workspace sandbox policy", () => {
    const selected = {
      sandbox: {
        network: { deniedDomains: ["private.invalid"] },
        filesystem: { denyRead: ["/unselected"] },
      },
    };
    const merged = mergeClaudeSettings(selected, {
      sandbox: {
        enabled: true,
        network: { allowLocalBinding: true },
        filesystem: { allowWrite: ["/selected"] },
      },
    });
    expect(merged.sandbox).toEqual({
      enabled: true,
      network: { deniedDomains: ["private.invalid"], allowLocalBinding: true },
      filesystem: { denyRead: ["/unselected"], allowWrite: ["/selected"] },
    });
    expect(selected.sandbox.network).toEqual({
      deniedDomains: ["private.invalid"],
    });
  });
});

describe("native auth and account MCP boundary", () => {
  it("does not fall back to ambient API keys, alternate accounts or cloud providers for an explicit native connection", () => {
    const auth = join(directory, "native");
    mkdirSync(auth);
    const ambient = {
      HOME: "/original-home",
      CLAUDE_CONFIG_DIR: "/other-profile",
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "/other-keychain-account",
      ANTHROPIC_API_KEY: "fixture-key",
      ANTHROPIC_AUTH_TOKEN: "fixture-bearer",
      ANTHROPIC_BASE_URL: "https://unselected.invalid",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth",
      CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "9",
      CLAUDE_CODE_MANAGED_SETTINGS_PATH: "/mandatory-policy",
      ENABLE_CLAUDEAI_MCP_SERVERS: "true",
    };
    const selected = context("work");
    const env = buildClaudeSessionEnvironment({
      env: ambient,
      executionContext: selected,
      modelConnection: connection(auth),
    });
    expect(env.HOME).toBe(ambient.HOME);
    expect(env.CLAUDE_CONFIG_DIR).toBe(auth);
    for (const key of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
      "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    ]) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.CLAUDE_CODE_MANAGED_SETTINGS_PATH).toBe("/mandatory-policy");
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    expect(ambient.CLAUDE_CODE_OAUTH_TOKEN).toBe("fixture-oauth");
    expect(
      buildClaudeSessionEnvironment({
        env: ambient,
        modelConnection: connection(null),
      }).CLAUDE_CONFIG_DIR,
    ).toBeUndefined();
    expect(() =>
      buildClaudeSessionEnvironment({
        env: ambient,
        modelConnection: connection(auth),
      }),
    ).toThrow("requires an explicit execution context");
    expect(buildClaudeSessionEnvironment({ env: ambient })).toEqual(ambient);
  });

  it("fails closed for revoked, incompatible and unsupported native profile/broker references", () => {
    const native = connection(null);
    for (const selected of [
      { ...native, revoked: true },
      { ...native, enabled: false },
      { ...native, provider: "omp" },
    ]) {
      expect(() =>
        buildClaudeSessionEnvironment({ env: {}, modelConnection: selected }),
      ).toThrow("unavailable or incompatible");
    }
    expect(() =>
      buildClaudeSessionEnvironment({
        env: {},
        modelConnection: {
          ...native,
          nativeAuth: { ...native.nativeAuth, profile: "other" },
        },
      }),
    ).toThrow("per-session auth profile");
    expect(() =>
      buildClaudeSessionEnvironment({
        env: {},
        modelConnection: {
          ...native,
          nativeAuth: {
            ...native.nativeAuth,
            hostEnv: { brokerUrlEnv: "URL", brokerTokenEnv: "TOKEN" },
          },
        },
      }),
    ).toThrow("does not support OMP");
  });

  it("refuses uninspectable native cloud imports instead of mistaking strict local MCP for isolation", () => {
    const wrapper = join(directory, "wrapper");
    writeFileSync(wrapper, '#!/bin/sh\nexec claude "$@"\n');
    expect(() => requireClaudeCloudImportControl(undefined)).toThrow(
      "strict local MCP configuration alone",
    );
    expect(() => requireClaudeCloudImportControl(wrapper)).toThrow(
      "cloud-import and plugin MCP controls",
    );
  });
});
