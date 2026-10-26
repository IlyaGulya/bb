import { createHash, type Hash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  experimental_claudeMcpConfigSchema as mcpConfigSchema,
  experimental_claudeSelectedMcpSchema as selectedMcpSchema,
} from "@get-bb/plugin-sdk/provider-bridge";
import type {
  ExecutionContextSnapshot,
  ModelConnectionSnapshot,
} from "@get-bb/plugin-sdk/provider-bridge";
import type {
  McpServerConfig,
  Options,
  Settings,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { BB_BRIDGE_MCP_SERVER_NAME } from "../tool-classification.js";

const stringMap = z.record(z.string(), z.string());
const objectSchema = z.record(z.string(), z.json());
const receiptSchema = z
  .object({ version: z.literal(1), digest: z.string() })
  .strict();
const supportedSettings: Record<string, true> = {
  $schema: true,
  permissions: true,
  sandbox: true,
  hooks: true,
  language: true,
  alwaysThinkingEnabled: true,
  model: true,
  effortLevel: true,
  attribution: true,
};
const nativeAuthEnvironment = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_API_KEY_HELPER_FD",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_MANTLE",
];
const hookEvents: Record<string, true> = {
  PreToolUse: true,
  PostToolUse: true,
  PostToolUseFailure: true,
  PostToolBatch: true,
  Notification: true,
  UserPromptSubmit: true,
  UserPromptExpansion: true,
  SessionStart: true,
  SessionEnd: true,
  Stop: true,
  StopFailure: true,
  SubagentStart: true,
  SubagentStop: true,
  PreCompact: true,
  PostCompact: true,
  PermissionRequest: true,
  PermissionDenied: true,
  Setup: true,
  TeammateIdle: true,
  TaskCreated: true,
  TaskCompleted: true,
  Elicitation: true,
  ElicitationResult: true,
  ConfigChange: true,
  WorktreeCreate: true,
  WorktreeRemove: true,
  InstructionsLoaded: true,
  CwdChanged: true,
  FileChanged: true,
  DirectoryAdded: true,
  MessageDisplay: true,
};
const hookCommon = {
  if: z.string().optional(),
  timeout: z.number().positive().optional(),
  statusMessage: z.string().optional(),
  once: z.boolean().optional(),
};
const promptHook = {
  prompt: z.string().min(1),
  model: z.string().optional(),
  ...hookCommon,
};
const nativeHooksSchema = z.record(
  z.string(),
  z.array(
    z
      .object({
        matcher: z.string().optional(),
        hooks: z.array(
          z.discriminatedUnion("type", [
            z
              .object({
                type: z.literal("command"),
                command: z.string().min(1),
                args: z.array(z.string()).optional(),
                shell: z.enum(["bash", "powershell"]).optional(),
                async: z.boolean().optional(),
                asyncRewake: z.boolean().optional(),
                ...hookCommon,
              })
              .strict(),
            z
              .object({
                type: z.literal("prompt"),
                continueOnBlock: z.boolean().optional(),
                ...promptHook,
              })
              .strict(),
            z.object({ type: z.literal("agent"), ...promptHook }).strict(),
            z
              .object({
                type: z.literal("http"),
                url: z.url(),
                headers: stringMap.optional(),
                allowedEnvVars: z.array(z.string()).optional(),
                ...hookCommon,
              })
              .strict(),
            z
              .object({
                type: z.literal("mcp_tool"),
                server: z.string().min(1),
                tool: z.string().min(1),
                input: z.record(z.string(), z.json()).optional(),
                ...hookCommon,
              })
              .strict(),
          ]),
        ),
      })
      .strict(),
  ),
);

export interface ClaudeContextFiles {
  settings: Settings;
  mcpServers: Record<string, McpServerConfig>;
  verify: () => void;
}

interface ResolveContextArgs {
  threadId: string;
  executionContext?: ExecutionContextSnapshot;
  modelConnection?: ModelConnectionSnapshot;
  resume: boolean;
}

function requireAbsolutePath(path: string): void {
  if (!isAbsolute(path)) {
    throw new Error(
      "Claude scoped context and native auth references must use host-absolute paths.",
    );
  }
}

function readObject(path: string): z.infer<typeof objectSchema> {
  requireAbsolutePath(path);
  try {
    return objectSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    throw new Error(
      `Claude selected context file is not a readable JSON object: ${path}`,
    );
  }
}

export function mergeClaudeSettings(left: Settings, right: Settings): Settings {
  const result: Settings = { ...left, ...right };
  if (left.hooks || right.hooks) {
    result.hooks = { ...left.hooks };
    for (const [event, matchers] of Object.entries(right.hooks ?? {})) {
      result.hooks[event] = [...(result.hooks[event] ?? []), ...matchers];
    }
  }
  if (left.permissions || right.permissions) {
    result.permissions = { ...left.permissions, ...right.permissions };
    for (const field of [
      "allow",
      "deny",
      "ask",
      "additionalDirectories",
    ] as const) {
      if (left.permissions?.[field] || right.permissions?.[field]) {
        result.permissions[field] = [
          ...(left.permissions?.[field] ?? []),
          ...(right.permissions?.[field] ?? []),
        ];
      }
    }
  }
  if (left.sandbox || right.sandbox) {
    result.sandbox = { ...left.sandbox, ...right.sandbox };
    if (left.sandbox?.network || right.sandbox?.network) {
      result.sandbox.network = {
        ...left.sandbox?.network,
        ...right.sandbox?.network,
      };
    }
    if (left.sandbox?.filesystem || right.sandbox?.filesystem) {
      result.sandbox.filesystem = {
        ...left.sandbox?.filesystem,
        ...right.sandbox?.filesystem,
      };
    }
  }
  return result;
}

function readSettings(path: string, hooksOnly = false): Settings {
  const value = readObject(path);
  for (const key of Object.keys(value)) {
    if (
      !(hooksOnly ? key === "hooks" : Object.hasOwn(supportedSettings, key))
    ) {
      throw new Error(
        `Claude scoped settings do not support '${key}'. Select instructions, roots, direct MCP, auth, and memory through the execution context or model connection instead.`,
      );
    }
  }
  if (value.hooks !== undefined) {
    const parsed = nativeHooksSchema.safeParse(value.hooks);
    if (
      !parsed.success ||
      Object.keys(parsed.data).some(
        (event) => !Object.hasOwn(hookEvents, event),
      )
    ) {
      throw new Error(
        `Claude selected hooks file has invalid native hook definitions: ${path}`,
      );
    }
  }
  return value as Settings;
}

function hashPath(
  hash: Hash,
  path: string,
  ancestors: Set<string>,
  buffer: Buffer,
): void {
  requireAbsolutePath(path);
  const real = realpathSync(path);
  if (ancestors.has(real)) {
    throw new Error("Claude selected context roots contain a symlink cycle.");
  }
  const stat = statSync(real);
  hash.update(path).update("\0").update(real).update("\0");
  if (stat.isDirectory()) {
    hash.update("directory\0");
    ancestors.add(real);
    for (const name of readdirSync(real).sort()) {
      hashPath(hash, join(path, name), ancestors, buffer);
    }
    ancestors.delete(real);
    return;
  }
  if (!stat.isFile()) {
    throw new Error(
      "Claude selected context roots must contain only files and directories.",
    );
  }
  hash
    .update("file\0")
    .update(String(stat.mode))
    .update("\0")
    .update(String(stat.size))
    .update("\0");
  const fd = openSync(real, "r");
  try {
    let bytes: number;
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(fd);
  }
  hash.update("\0");
}

function sourceDigest(args: ResolveContextArgs): string {
  const hash = createHash("sha256").update(
    JSON.stringify({
      executionContext: args.executionContext ?? null,
      modelConnection: args.modelConnection ?? null,
    }),
  );
  const context = args.executionContext;
  if (context) {
    const paths = new Set([
      ...context.settingsPaths,
      ...context.skillRoots,
      ...context.commandRoots,
      ...context.pluginRoots,
      ...context.mcpServers.map((server) => server.configPath),
      ...(context.hooksPath ? [context.hooksPath] : []),
    ]);
    if (paths.size > 0) {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const ancestors = new Set<string>();
      for (const path of paths) {
        hashPath(hash, path, ancestors, buffer);
      }
    }
  }
  return hash.digest("hex");
}

export class ClaudeContextStore {
  private readonly prepared = new Map<
    string,
    { digest: string; files: ClaudeContextFiles }
  >();

  constructor(private readonly dataDir: string) {}

  resolve(args: ResolveContextArgs): ClaudeContextFiles | undefined {
    if (!args.executionContext && !args.modelConnection) return undefined;
    const digest = sourceDigest(args);
    const cached = this.prepared.get(args.threadId);
    if (cached) {
      if (cached.digest !== digest) {
        throw new Error(
          "Claude thread execution context or model connection changed. Create a new thread; the existing native session keeps its original binding.",
        );
      }
      return cached.files;
    }
    const directory = join(this.dataDir, "execution-contexts");
    const receiptPath = join(
      directory,
      `${createHash("sha256").update(args.threadId).digest("hex")}.json`,
    );
    if (existsSync(receiptPath)) {
      const receipt = receiptSchema.safeParse(
        JSON.parse(readFileSync(receiptPath, "utf8")),
      );
      if (!receipt.success || receipt.data.digest !== digest) {
        throw new Error(
          "Claude selected context files or binding changed since this thread started. Restore the original files or create a new thread; native resume was not attempted.",
        );
      }
    } else if (args.resume) {
      throw new Error(
        "Claude cannot resume a scoped thread without its host context receipt. Restore the provider data directory or create a new thread; an ambient context will not be substituted.",
      );
    }
    const context = args.executionContext;
    let settings: Settings = {};
    const mcpServers: Record<string, McpServerConfig> = Object.create(null);
    if (context) {
      if (!context.enabled)
        throw new Error("The selected Claude execution context is disabled.");
      if (context.autoMemory) {
        throw new Error(
          "Claude scoped auto-memory is unsupported by this native adapter. Set the execution context autoMemory policy to false; shared native account/project memory will not be loaded.",
        );
      }
      for (const path of context.settingsPaths) {
        settings = mergeClaudeSettings(settings, readSettings(path));
      }
      if (context.hooksPath)
        settings = mergeClaudeSettings(
          settings,
          readSettings(context.hooksPath, true),
        );
      for (const server of context.mcpServers) {
        if (
          server.name === BB_BRIDGE_MCP_SERVER_NAME ||
          Object.hasOwn(mcpServers, server.name)
        ) {
          throw new Error(
            "Claude selected MCP names must be unique and cannot replace bb-bridge.",
          );
        }
        const config = mcpConfigSchema.safeParse(readObject(server.configPath));
        if (
          !config.success ||
          !Object.hasOwn(config.data.mcpServers, server.name)
        ) {
          throw new Error(
            `Claude selected MCP configuration must define the selected server '${server.name}'. Unsupported native MCP transports/options are refused, not ignored.`,
          );
        }
        const selected = selectedMcpSchema.safeParse(
          config.data.mcpServers[server.name],
        );
        if (!selected.success) {
          throw new Error(
            `Claude selected MCP server '${server.name}' uses an unsupported or invalid native transport/options.`,
          );
        }
        mcpServers[server.name] = selected.data;
      }
    }
    for (const matchers of Object.values(settings.hooks ?? {})) {
      for (const matcher of matchers) {
        for (const hook of matcher.hooks) {
          if (
            hook.type === "mcp_tool" &&
            hook.server !== BB_BRIDGE_MCP_SERVER_NAME &&
            !Object.hasOwn(mcpServers, hook.server)
          ) {
            throw new Error(
              "Claude selected hooks reference an MCP server outside the selected context.",
            );
          }
        }
      }
    }
    const files: ClaudeContextFiles = {
      settings,
      mcpServers,
      verify: () => {
        if (sourceDigest(args) !== digest) {
          throw new Error(
            "Claude selected context files changed while this thread was active. Restore them or create a new thread before continuing.",
          );
        }
      },
    };
    files.verify();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(receiptPath, JSON.stringify({ version: 1, digest }), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (!existsSync(receiptPath)) throw error;
      const receipt = receiptSchema.parse(
        JSON.parse(readFileSync(receiptPath, "utf8")),
      );
      if (receipt.digest !== digest) {
        throw new Error(
          "A concurrent Claude launch has a different context binding for this thread.",
        );
      }
    }
    this.prepared.set(args.threadId, { digest, files });
    return files;
  }
}

export function buildClaudeSessionEnvironment(args: {
  env: NodeJS.ProcessEnv;
  executionContext?: ExecutionContextSnapshot;
  modelConnection?: ModelConnectionSnapshot;
}): NodeJS.ProcessEnv {
  const env = { ...args.env };
  const connection = args.modelConnection;
  if (connection) {
    if (
      connection.provider !== "claude-code" ||
      !connection.enabled ||
      connection.revoked
    ) {
      throw new Error(
        "The selected model connection is unavailable or incompatible with native Claude Code. No fallback account was selected.",
      );
    }
    if (connection.nativeAuth.hostEnv !== null) {
      throw new Error(
        "Native Claude Code does not support OMP hostEnv broker auth references. Select a native Claude configDir reference.",
      );
    }
    if (connection.nativeAuth.profile !== null) {
      throw new Error(
        "Native Claude Code does not expose per-session auth profile selection. Use a native configDir reference with profile=null; no global profile or login will be changed.",
      );
    }
    for (const key of nativeAuthEnvironment) delete env[key];
    const configDir = connection.nativeAuth.configDir;
    if (configDir !== null) {
      if (!args.executionContext) {
        throw new Error(
          "A non-default native Claude auth configDir requires an explicit execution context. Otherwise Claude would also import that account directory's user settings and skills, which is not auth-only selection.",
        );
      }
      requireAbsolutePath(configDir);
      if (!statSync(configDir).isDirectory())
        throw new Error(
          "The selected native Claude auth configDir is unavailable.",
        );
      env.CLAUDE_CONFIG_DIR = configDir;
    } else {
      delete env.CLAUDE_CONFIG_DIR;
    }
  }
  const context = args.executionContext;
  if (context) {
    env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
    delete env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD;
    if (context.gitIdentity) {
      env.GIT_AUTHOR_NAME = context.gitIdentity.name;
      env.GIT_COMMITTER_NAME = context.gitIdentity.name;
      env.GIT_AUTHOR_EMAIL = context.gitIdentity.email;
      env.GIT_COMMITTER_EMAIL = context.gitIdentity.email;
    }
  }
  return env;
}

const supportedExecutables = new Map<string, string>();

export function requireClaudeCloudImportControl(
  executable: string | undefined,
): void {
  if (!executable) {
    throw new Error(
      "Scoped Claude execution requires an installed native Claude Code executable with ENABLE_CLAUDEAI_MCP_SERVERS support. Set BB_CLAUDE_CODE_EXECUTABLE to that executable; strict local MCP configuration alone does not disable account-provided cloud MCP imports.",
    );
  }
  const path = realpathSync(executable);
  const stat = statSync(path);
  const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  if (supportedExecutables.get(path) === signature) return;
  const fd = openSync(path, "r");
  const markers = [
    Buffer.from("ENABLE_CLAUDEAI_MCP_SERVERS"),
    Buffer.from("--plugin-dir-no-mcp"),
  ];
  const found = new Set<number>();
  try {
    const overlap = Math.max(...markers.map((marker) => marker.length));
    const buffer = Buffer.allocUnsafe(64 * 1024 + overlap);
    let carry = 0;
    let bytes: number;
    while ((bytes = readSync(fd, buffer, carry, 64 * 1024, null)) > 0) {
      const length = carry + bytes;
      for (let index = 0; index < markers.length; index += 1) {
        if (buffer.subarray(0, length).includes(markers[index]!))
          found.add(index);
      }
      if (found.size === markers.length) break;
      carry = Math.min(overlap - 1, length);
      buffer.copy(buffer, 0, length - carry, length);
    }
    if (fstatSync(fd).size !== stat.size) found.clear();
  } finally {
    closeSync(fd);
  }
  if (found.size !== markers.length) {
    throw new Error(
      "This Claude executable does not expose the required cloud-import and plugin MCP controls (ENABLE_CLAUDEAI_MCP_SERVERS and --plugin-dir-no-mcp). Scoped execution is refused: strictMcpConfig alone cannot isolate account-provided Claude.ai MCP or plugin MCP. Select a compatible native executable; wrappers without an inspectable native engine are unsupported.",
    );
  }
  supportedExecutables.set(path, signature);
}

export function mergeClaudeMcpServers(
  selected: SdkMcpServers | undefined,
  bridge: NonNullable<SdkMcpServers>[string],
): NonNullable<SdkMcpServers> {
  return { ...selected, [BB_BRIDGE_MCP_SERVER_NAME]: bridge };
}

type SdkMcpServers = Options["mcpServers"];
