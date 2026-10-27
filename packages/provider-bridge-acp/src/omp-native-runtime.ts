import {
  constants,
  existsSync,
  realpathSync,
  statSync,
  accessSync,
  readFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, delimiter } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  executionContextSnapshotSchema,
  modelConnectionSnapshotSchema,
} from "@bb/domain";
import { z } from "zod";
import { OmpContextStore, type OmpContextFiles } from "./omp-context-files.js";
import type { AcpSessionParams } from "./session-params.js";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { discoverGatewayModels, gatewayChildEnv, gatewayModelSchema, pinGatewayReceipt, requireGatewayModel, resolveGatewayCredential, type GatewayModel, type OmpGateway } from "./omp-gateway.js";

const launchEnvironment = "BB_OMP_SCOPED_LAUNCH";
const nativePackageName = "@oh-my-pi/pi-coding-agent";
const launchSchema = z
  .object({
    packageRoot: z.string().min(1),
    dataDir: z.string().min(1),
    threadId: z.string().min(1),
    cwd: z.string().min(1),
    instructions: z.string(),
    workspaceRoots: z.array(z.string()),
    executionContext: executionContextSnapshotSchema.nullable(),
    modelConnection: modelConnectionSnapshotSchema.nullable(),
    model: z.string().optional(),
    permissionMode: z.enum(["accept-edits", "full"]),
  })
  .strict();

type NativeLaunch = z.infer<typeof launchSchema>;
interface NativeSettings {
  cloneForCwd(cwd: string): Promise<NativeSettings>;
  getModelRole(role: "default"): string | undefined;
}
interface NativeSession {
  refreshMCPTools(tools: unknown[]): Promise<void>;
}
type NativeLoadResult = { items: unknown[]; warnings?: string[] };
interface NativeSdk {
  Settings: {
    isolated(overrides: Record<string, unknown>): NativeSettings;
    loadReadOnly(options: {
      cwd: string;
      agentDir: string;
    }): Promise<NativeSettings>;
  };
  createAgentSession(options: Record<string, unknown>): Promise<{
    session: NativeSession;
    setToolUIContext?: unknown;
  }>;
  discoverAuthStorage(
    agentDir: string,
    options: { cwd: string; settings: NativeSettings },
  ): Promise<unknown>;
  getAgentDir(): string;
  ModelRegistry: new (
    authStorage: unknown,
    modelsPath: string,
    options: { settings: NativeSettings; ignoreLocalModelConfig?: boolean },
  ) => {
    authStorage: { keys: { setRuntime(provider: string, key: string): void } };
    getAll(kind?: string): unknown[];
    getAvailable(kind?: string): unknown[];
    getProviderModels(provider: string): unknown[];
    getAvailableForProviders(providers: ReadonlySet<string>, kind?: string): unknown[];
    registerProvider(name: string, config: Record<string, unknown>): void;
    find(provider: string, id: string): unknown;
  };
  SessionManager: {
    create(cwd: string, sessionDir: string): unknown;
    getDefaultSessionDir(cwd: string, agentDir: string): string;
  };
}
interface NativeMcpManager {
  setAuthStorage(storage: unknown): void;
  disconnectServer(name: string): Promise<void>;
  discoverAndConnect(options: Record<string, unknown>): Promise<unknown>;
  getTools(): unknown[];
  disconnectAll(): Promise<void>;
}
type NativeMcpServer = {
  name: string;
  command?: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
  type?: "http" | "sse";
  url?: string;
  headers?: Array<{ name: string; value: string }>;
};
type NativeMcpConfigs = {
  configs: Record<string, unknown>;
  sources: Record<string, unknown>;
  exaApiKeys: string[];
};
interface NativeMcpModule {
  MCPManager: new (
    cwd: string,
    cache: null,
    loader: (
      cwd: string,
      options?: Record<string, unknown>,
    ) => Promise<NativeMcpConfigs>,
  ) => NativeMcpManager;
  loadAllMCPConfigs(
    cwd: string,
    options?: Record<string, unknown>,
  ): Promise<NativeMcpConfigs>;
}
interface NativeCapabilities {
  getAllProvidersInfo(): Array<{ id: string }>;
  setDisabledProviders(ids: string[]): void;
  loadCapability(
    id: string,
    options: Record<string, unknown>,
  ): Promise<NativeLoadResult>;
  registerProvider(
    id: string,
    provider: {
      id: string;
      displayName: string;
      description: string;
      priority: number;
      load(ctx: unknown): Promise<NativeLoadResult>;
    },
  ): void;
}
interface NativeHelpers {
  loadFilesFromDir(
    ctx: unknown,
    directory: string,
    provider: string,
    level: "user",
    options: {
      extensions: string[];
      recursive: boolean;
      transform(
        name: string,
        content: string,
        path: string,
        source: unknown,
      ): unknown;
    },
  ): Promise<NativeLoadResult>;
}

function executable(command: string, env: NodeJS.ProcessEnv): string | null {
  const candidates = isAbsolute(command)
    ? [command]
    : (env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => resolve(directory, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch {}
  }
  return null;
}

function nativePackageRoot(command: string, env: NodeJS.ProcessEnv): string {
  const explicit = env.OMP_SDK_PATH;
  if (explicit && !isAbsolute(explicit))
    throw new Error(
      "OMP_SDK_PATH must reference an absolute native OMP package directory on the execution host.",
    );
  const cli = executable(command, env);
  const candidates = explicit
    ? [explicit]
    : cli
      ? [
          dirname(cli),
          resolve(dirname(cli), ".."),
          resolve(dirname(cli), "../.."),
        ]
      : [];
  for (const candidate of candidates) {
    try {
      const manifest = z
        .object({ name: z.string(), version: z.string() })
        .parse(
          JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")),
        );
      const version = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(manifest.version);
      if (
        manifest.name !== nativePackageName ||
        !version ||
        Number(version[1]) !== 18 ||
        Number(version[2]) < 12 ||
        (Number(version[2]) === 12 && Number(version[3]) < 6)
      )
        continue;
      if (
        existsSync(join(candidate, "src/index.ts")) &&
        existsSync(join(candidate, "src/modes/acp/acp-mode.ts"))
      )
        return realpathSync(candidate);
    } catch {}
  }
  throw new Error(
    "Scoped OMP requires the host-installed native @oh-my-pi/pi-coding-agent SDK 18.12.6 or compatible 18.x. A standalone CLI or wrapper is insufficient; set OMP_SDK_PATH to its native package directory. No ambient CLI fallback was started.",
  );
}

export interface OmpScopedLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  files?: OmpContextFiles;
  gatewayReceipt?: { verify(): void };
}

export function prepareOmpScopedLaunch(args: {
  params: AcpSessionParams;
  dataDir: string;
  artifactPath: string;
  resume: boolean;
  env: NodeJS.ProcessEnv;
}): OmpScopedLaunch {
  const context = args.params.executionContext;
  const gateway = args.params.modelConnection?.gateway;
  if (!context && !gateway)
    throw new Error("Native SDK launch requires an execution context or CPA gateway.");
  if (
    args.params.agent.args.length !== 1 ||
    args.params.agent.args[0] !== "acp"
  ) {
    throw new Error(
      "Scoped OMP uses the native SDK ACP factory, not custom CLI context/profile flags. Use the standard omp acp launch and explicit execution-context/model-connection references.",
    );
  }
  const packageRoot = nativePackageRoot(args.params.agent.command, args.env);
  const bun = executable("bun", args.env);
  if (!bun)
    throw new Error(
      "Scoped native OMP requires Bun on the execution host PATH. No ambient CLI fallback was started.",
    );
  const files = context ? new OmpContextStore(args.dataDir).resolve({
    threadId: args.params.threadId,
    cwd: args.params.cwd,
    executionContext: context,
    resume: args.resume,
  }) : undefined;
  const selection = args.params.modelSelection;
  const model = selection
    ? "model" in selection
      ? selection.model
      : selection.modelId
    : undefined;
  let gatewayReceipt: { verify(): void } | undefined;
  if (gateway) {
    if (!model?.startsWith(`bb-cpa/${gateway.accountPrefix}/`))
      throw new Error("CPA requires an explicit model in the selected account namespace.");
    gatewayReceipt = pinGatewayReceipt(args.dataDir, args.params.threadId, gateway, model, args.resume);
  }
  const launch: NativeLaunch = {
    packageRoot,
    dataDir: args.dataDir,
    threadId: args.params.threadId,
    cwd: args.params.cwd,
    instructions: [context?.instructions, args.params.instructions]
      .filter(Boolean)
      .join("\n\n"),
    workspaceRoots: args.params.workspaceWriteRoots ?? [],
    executionContext: context,
    modelConnection: args.params.modelConnection ?? null,
    ...(model && model !== "default" ? { model } : {}),
    permissionMode: args.params.permissionMode,
  };
  return {
    command: bun,
    args: [args.artifactPath, "--omp-scoped-acp"],
    env: { ...(gateway ? gatewayChildEnv(gateway, process.env, args.env) : args.env), [launchEnvironment]: JSON.stringify(launch) },
    files,
    gatewayReceipt,
  };
}

function moduleFunctions(
  module: unknown,
  names: string[],
  label: string,
): Record<string, unknown> {
  if (!module || typeof module !== "object")
    throw new Error(`Native OMP ${label} module is unavailable.`);
  const record = module as Record<string, unknown>;
  if (names.some((name) => typeof record[name] !== "function"))
    throw new Error(
      `Native OMP ${label} module lacks the required explicit-context SDK API.`,
    );
  return record;
}

export async function runOmpScopedAcp(): Promise<void> {
  const launch = launchSchema.parse(
    JSON.parse(process.env[launchEnvironment] ?? "null"),
  );
  delete process.env[launchEnvironment];
  const gateway = launch.modelConnection?.gateway;
  const gatewayKey = gateway ? resolveGatewayCredential(gateway, process.env) : undefined;
  if (gateway?.credential.kind === "env") delete process.env[gateway.credential.name];
  if (![launch.packageRoot, launch.dataDir, launch.cwd].every(isAbsolute))
    throw new Error("Native OMP scoped paths must be absolute.");
  if (!launch.executionContext) {
    await runGatewayOnlyAcp(launch, gatewayKey);
    return;
  }
  const executionContext = launch.executionContext;
  const files = new OmpContextStore(launch.dataDir).resolve({
    threadId: launch.threadId,
    cwd: launch.cwd,
    executionContext: launch.executionContext,
    resume: true,
  });
  const modulePath = (path: string) =>
    pathToFileURL(join(launch.packageRoot, "src", path)).href;
  const sdkModule = await import(modulePath("index.ts"));
  const sdk = moduleFunctions(
    sdkModule,
    ["createAgentSession", "discoverAuthStorage", "getAgentDir"],
    "session",
  ) as unknown as NativeSdk;
  if (
    typeof sdk.Settings?.isolated !== "function" ||
    typeof sdk.Settings?.loadReadOnly !== "function"
  )
    throw new Error("Native OMP isolated settings API is unavailable.");
  if (sdkModule.EXPLICIT_CONTEXT_DISCOVERY_VERSION !== 1)
    throw new Error(
      "This native OMP SDK does not enforce explicit context discovery for agents and multi-root instructions. Install the scoped-discovery native SDK revision; ambient startup was refused.",
    );
  const capabilities = moduleFunctions(
    await import(modulePath("capability/index.ts")),
    [
      "getAllProvidersInfo",
      "setDisabledProviders",
      "registerProvider",
      "loadCapability",
    ],
    "capability",
  ) as unknown as NativeCapabilities;
  const helpers = moduleFunctions(
    await import(modulePath("discovery/helpers.ts")),
    ["loadFilesFromDir"],
    "directory loader",
  ) as unknown as NativeHelpers;
  const acp = moduleFunctions(
    await import(modulePath("modes/acp/acp-mode.ts")),
    ["runAcpMode"],
    "ACP",
  ) as unknown as {
    runAcpMode(
      factory: (
        cwd: string,
        options?: {
          interactivePrompts?: boolean;
          mcpServers?: NativeMcpServer[];
        },
      ) => Promise<unknown>,
    ): Promise<void>;
  };
  const mcp = moduleFunctions(
    await import(modulePath("mcp/index.ts")),
    ["MCPManager", "loadAllMCPConfigs"],
    "MCP",
  ) as unknown as NativeMcpModule;
  const rootScope = moduleFunctions(
    await import(modulePath("discovery/omp-extension-roots.ts")),
    ["withOmpExtensionRootScope", "setInvocationConfiguredExtensions"],
    "root scope",
  ) as unknown as {
    withOmpExtensionRootScope(
      roots: string[],
      mode: "explicit-only",
      callback: () => Promise<void>,
    ): Promise<void>;
    setInvocationConfiguredExtensions(roots: string[], level: "user"): void;
  };
  const provider = "bb-execution-context";
  capabilities.registerProvider("slash-commands", {
    id: provider,
    displayName: "BB execution context",
    description: "Explicit thread command roots",
    priority: 200,
    load: async (ctx) => {
      files.verify();
      const results = await Promise.all(
        files.commandRoots.map((directory) =>
          helpers.loadFilesFromDir(ctx, directory, provider, "user", {
            extensions: ["md"],
            recursive: true,
            transform: (name, content, path, source) => ({
              name: name.replace(/\.md$/, ""),
              content,
              path,
              level: "user",
              _source: source,
            }),
          }),
        ),
      );
      return {
        items: results.flatMap((result) => result.items),
        warnings: results.flatMap((result) => result.warnings ?? []),
      };
    },
  });
  const allowedProviders = new Set([provider, "omp-plugins"]);
  const disabledProviders = capabilities
    .getAllProvidersInfo()
    .map((entry) => entry.id)
    .filter((id) => !allowedProviders.has(id));
  capabilities.setDisabledProviders(disabledProviders);
  const agentDir = sdk.getAgentDir();
  const authDir = launch.modelConnection?.nativeAuth.configDir ?? agentDir;
  if (!isAbsolute(authDir) || !statSync(authDir).isDirectory())
    throw new Error(
      "The selected native OMP authentication directory is unavailable.",
    );
  const roots = {
    explicit: files.pluginRoots,
    configured: [],
    configuredLevel: "user",
    mode: "explicit-only",
  };
  await rootScope.withOmpExtensionRootScope(
    files.pluginRoots,
    "explicit-only",
    async () => {
      rootScope.setInvocationConfiguredExtensions([], "user");
      const authSettings = await sdk.Settings.loadReadOnly({
        cwd: authDir,
        agentDir: authDir,
      });
      const authStorage = await sdk.discoverAuthStorage(authDir, {
        cwd: authDir,
        settings: authSettings,
      });
      const mcpAuthSettings =
        authDir === agentDir
          ? authSettings
          : await sdk.Settings.loadReadOnly({ cwd: agentDir, agentDir });
      const mcpAuthStorage =
        authDir === agentDir
          ? authStorage
          : await sdk.discoverAuthStorage(agentDir, {
              cwd: agentDir,
              settings: mcpAuthSettings,
            });
      if (
        typeof sdk.ModelRegistry !== "function" ||
        typeof sdk.SessionManager?.create !== "function" ||
        typeof sdk.SessionManager?.getDefaultSessionDir !== "function"
      )
        throw new Error(
          "Native OMP auth/model/session registry API is unavailable.",
        );
      const modelRegistry = new sdk.ModelRegistry(
        authStorage,
        launch.modelConnection?.gateway ? join(launch.dataDir, "omp-gateway", "models.yml") : join(authDir, "models.yml"),
        { settings: authSettings, ignoreLocalModelConfig: !!launch.modelConnection?.gateway },
      );
      const gatewayModel = launch.modelConnection?.gateway
        ? await configureGatewayRegistry(launch, modelRegistry, gatewayKey)
        : undefined;
      const selectedTools = await capabilities.loadCapability("tools", {
        cwd: launch.cwd,
        agentDir,
        extensionRoots: roots,
        providers: ["omp-plugins"],
      });
      const customToolSchema = z.object({
        path: z.string(),
        level: z.enum(["user", "project"]),
        _source: z.object({ provider: z.string(), providerName: z.string() }),
      });
      const customToolPaths = selectedTools.items
        .map((item) => customToolSchema.parse(item))
        .filter(
          (item) =>
            /\.(?:ts|js|mjs|cjs)$/.test(item.path) &&
            !item.path.endsWith(".d.ts"),
        )
        .map((item) => ({
          path: item.path,
          source: {
            provider: item._source.provider,
            providerName: item._source.providerName,
            level: item.level,
          },
        }));
      await acp.runAcpMode(async (cwd, options) => {
        if (resolve(cwd) !== resolve(launch.cwd))
          throw new Error(
            "Native OMP scoped ACP cannot switch to another workspace.",
          );
        files.verify();
        const settings = await sdk.Settings.isolated({
          ...files.settingsOverrides,
          disabledProviders,
          enabledProviders: [],
          personality: "none",
          "secrets.enabled": false,
          "advisor.enabled": false,
          includeWorkspaceTree: false,
          "skills.customDirectories": files.skillRoots,
          "skills.enableCodexUser": false,
          "skills.enableClaudeUser": false,
          "skills.enableClaudeProject": false,
          "skills.enablePiUser": false,
          "skills.enablePiProject": false,
          "skills.enableAgentsUser": false,
          "skills.enableAgentsProject": false,
          "commands.enableClaudeUser": false,
          "commands.enableClaudeProject": false,
          "commands.enableOpencodeUser": false,
          "commands.enableOpencodeProject": false,
        }).cloneForCwd(cwd);
        let clientServers = options?.mcpServers ?? [];
        const mcpManager = new mcp.MCPManager(
          cwd,
          null,
          async (directory, discoveryOptions) => {
            files.verify();
            const result = await mcp.loadAllMCPConfigs(
              directory,
              discoveryOptions,
            );
            for (const server of executionContext.mcpServers) {
              result.configs[server.name] = files.mcpServers[server.name];
              result.sources[server.name] = {
                provider: "bb-execution-context",
                providerName: "BB execution context",
                path: server.configPath,
                level: "user",
              };
            }
            for (const server of clientServers) {
              result.configs[server.name] = server.command
                ? {
                    type: "stdio",
                    command: server.command,
                    args: server.args ?? [],
                    env: Object.fromEntries(
                      (server.env ?? []).map((entry) => [
                        entry.name,
                        entry.value,
                      ]),
                    ),
                    envPolicy: "literal",
                  }
                : {
                    type: server.type,
                    url: server.url,
                    headers: Object.fromEntries(
                      (server.headers ?? []).map((entry) => [
                        entry.name,
                        entry.value,
                      ]),
                    ),
                    headerPolicy: "origin-locked",
                  };
              result.sources[server.name] = {
                provider: "acp",
                providerName: "ACP Client",
                path: `acp://${server.name}`,
                level: "project",
              };
            }
            return result;
          },
        );
        mcpManager.setAuthStorage(mcpAuthStorage);
        try {
          await mcpManager.discoverAndConnect({
            enableProjectConfig: false,
            extensionRoots: roots,
          });
          const result = await sdk.createAgentSession({
            cwd,
            authStorage,
            modelRegistry,
            ...(gatewayModel ? { model: gatewayModel, scopedModels: [{ model: gatewayModel }], modelPatternDefaultFallbackChain: [], allowSessionModelFallback: false } : {}),
            sessionManager: sdk.SessionManager.create(
              cwd,
              sdk.SessionManager.getDefaultSessionDir(cwd, agentDir),
            ),
            settings,
            contextFiles: files.contextFiles,
            disableExtensionDiscovery: true,
            preloadedExtensionPaths: files.extensionPaths,
            preloadedCustomToolPaths: customToolPaths,
            extensionRoots: () => roots,
            enableMCP: true,
            mcpManager,
            ownsMcpCallbacks: true,
            mcpTools: mcpManager.getTools(),
            customSystemPrompt: "",
            appendSystemPrompt: launch.instructions,
            additionalDirectories: launch.workspaceRoots.filter(
              (directory) => resolve(directory) !== resolve(cwd),
            ),
            deferUsageReserveConfirmation: true,
            interactivePrompts: options?.interactivePrompts ?? false,
            autoApprove: launch.permissionMode === "full",
            cacheWarming: false,
            autoTitle: false,
            ...((launch.model ?? authSettings.getModelRole("default"))
              ? {
                  modelPattern:
                    launch.model ?? authSettings.getModelRole("default"),
                }
              : {}),
          });
          await result.session.refreshMCPTools(mcpManager.getTools());
          return {
            session: result.session,
            ...(result.setToolUIContext
              ? { setToolUIContext: result.setToolUIContext }
              : {}),
            mcp: {
              manager: mcpManager,
              configureServers: async (servers: NativeMcpServer[]) => {
                if (servers === clientServers) return;
                const previous = new Map(
                  clientServers.map((server) => [server.name, server]),
                );
                const changed = new Set<string>();
                for (const server of servers) {
                  if (!isDeepStrictEqual(server, previous.get(server.name)))
                    changed.add(server.name);
                  previous.delete(server.name);
                }
                for (const name of previous.keys()) changed.add(name);
                await Promise.all(
                  [...changed].map((name) => mcpManager.disconnectServer(name)),
                );
                clientServers = servers;
                if (changed.size === 0) return;
                await mcpManager.discoverAndConnect({
                  enableProjectConfig: false,
                  extensionRoots: roots,
                });
              },
            },
          };
        } catch (error) {
          await mcpManager.disconnectAll();
          throw error;
        }
      });
    },
  );
}

async function bundledGatewayModels(packageRoot: string, gateway: OmpGateway): Promise<GatewayModel[]> {
  const require = createRequire(join(packageRoot, "package.json"));
  const catalog = moduleFunctions(await import(pathToFileURL(require.resolve("@oh-my-pi/pi-catalog/models")).href), ["getBundledModels"], "bundled catalog") as unknown as {
    getBundledModels(provider: string): unknown[];
  };
  return catalog.getBundledModels(gateway.modelProvider).map((model) => gatewayModelSchema.parse(model));
}

async function configureGatewayRegistry(launch: NativeLaunch, registry: InstanceType<NativeSdk["ModelRegistry"]>, key: string | undefined): Promise<unknown> {
  const gateway = launch.modelConnection?.gateway;
  if (!gateway) throw new Error("CPA gateway binding is missing.");
  if (!key) throw new Error("CPA client credential is unavailable; native fallback is disabled.");
  pinGatewayReceipt(launch.dataDir, launch.threadId, gateway, launch.model ?? "", true).verify();
  const models = await discoverGatewayModels(gateway, key, await bundledGatewayModels(launch.packageRoot, gateway));
  const id = requireGatewayModel(launch.model, gateway, models);
  registry.authStorage.keys.setRuntime("bb-cpa", key);
  registry.registerProvider("bb-cpa", {
    baseUrl: gateway.baseUrl, api: gateway.protocol, apiKey: key, authHeader: true,
    headers: { "X-BB-Thread-Id": launch.threadId },
    models: models.map((model) => ({ ...model, api: gateway.protocol, baseUrl: gateway.baseUrl })),
  });
  const selected = registry.find("bb-cpa", id);
  if (!selected) throw new Error("Native OMP refused the bound CPA model.");
  registry.find = (provider, modelId) => provider === "bb-cpa" && modelId === id ? selected : undefined;
  registry.getAll = () => [selected];
  registry.getAvailable = () => [selected];
  registry.getProviderModels = (provider) => provider === "bb-cpa" ? [selected] : [];
  registry.getAvailableForProviders = (providers) => providers.has("bb-cpa") ? [selected] : [];
  return selected;
}

async function runGatewayOnlyAcp(launch: NativeLaunch, key: string | undefined): Promise<void> {
  const sdk = moduleFunctions(await import(pathToFileURL(join(launch.packageRoot, "src/index.ts")).href), ["createAgentSession", "discoverAuthStorage", "getAgentDir"], "session") as unknown as NativeSdk;
  const agentDir = sdk.getAgentDir();
  const settings = await sdk.Settings.loadReadOnly({ cwd: launch.cwd, agentDir });
  const authStorage = await sdk.discoverAuthStorage(agentDir, { cwd: launch.cwd, settings });
  const registry = new sdk.ModelRegistry(authStorage, join(launch.dataDir, "omp-gateway", "models.yml"), { settings, ignoreLocalModelConfig: true });
  const model = await configureGatewayRegistry(launch, registry, key);
  const acp = moduleFunctions(await import(pathToFileURL(join(launch.packageRoot, "src/modes/acp/acp-mode.ts")).href), ["runAcpMode"], "ACP") as unknown as {
    runAcpMode(factory: (cwd: string, options?: { interactivePrompts?: boolean }) => Promise<unknown>): Promise<void>;
  };
  await acp.runAcpMode(async (cwd, options) => {
    if (resolve(cwd) !== resolve(launch.cwd)) throw new Error("CPA ACP cannot change the bound workspace.");
    pinGatewayReceipt(launch.dataDir, launch.threadId, launch.modelConnection!.gateway!, launch.model!, true).verify();
    return sdk.createAgentSession({
      cwd, settings, authStorage, modelRegistry: registry, model,
      scopedModels: [{ model }], modelPatternDefaultFallbackChain: [], allowSessionModelFallback: false,
      sessionManager: sdk.SessionManager.create(cwd, sdk.SessionManager.getDefaultSessionDir(cwd, agentDir)),
      appendSystemPrompt: launch.instructions,
      additionalDirectories: launch.workspaceRoots.filter((directory) => resolve(directory) !== resolve(cwd)),
      interactivePrompts: options?.interactivePrompts ?? false,
      autoApprove: launch.permissionMode === "full", cacheWarming: false, autoTitle: false,
    });
  });
}

export async function listOmpGatewayModels(args: { connection: NonNullable<AcpSessionParams["modelConnection"]>; command: string; env: NodeJS.ProcessEnv; artifactPath: string }): Promise<GatewayModel[]> {
  const packageRoot = nativePackageRoot(args.command, args.env);
  const bun = executable("bun", args.env);
  if (!bun) throw new Error("CPA model metadata requires native OMP and Bun on this worker.");
  if (!args.connection.gateway) throw new Error("CPA gateway binding is missing.");
  const env = gatewayChildEnv(args.connection.gateway, process.env, args.env);
  const { promise, resolve: resolveModels, reject } = Promise.withResolvers<GatewayModel[]>();
    const child = spawn(bun, [args.artifactPath, "--omp-gateway-models"], {
      env: { ...env, [launchEnvironment]: JSON.stringify({ packageRoot, connection: args.connection }) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("CPA model metadata timed out.")); }, 20000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 4 * 1024 * 1024) child.kill("SIGKILL");
    });
    child.stderr.resume();
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error("CPA model discovery failed; native fallback is disabled.")); return; }
      try { resolveModels(z.array(gatewayModelSchema).parse(JSON.parse(output))); } catch (error) { reject(error); }
    });
  return promise;
}

export async function runOmpGatewayModelList(): Promise<void> {
  const input = z.object({ packageRoot: z.string(), connection: modelConnectionSnapshotSchema }).parse(JSON.parse(process.env[launchEnvironment] ?? "null"));
  delete process.env[launchEnvironment];
  const gateway = input.connection.gateway;
  if (!gateway) throw new Error("CPA gateway binding is missing.");
  const key = resolveGatewayCredential(gateway, process.env);
  if (gateway.credential.kind === "env") delete process.env[gateway.credential.name];
  const models = await discoverGatewayModels(gateway, key, await bundledGatewayModels(input.packageRoot, gateway));
  process.stdout.write(JSON.stringify(models));
}
