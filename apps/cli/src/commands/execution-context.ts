import { readFile } from "node:fs/promises";
import { Command } from "commander";
import {
  createExecutionContextRequestSchema,
  inspectMcpRequestSchema,
  updateExecutionContextRequestSchema,
  createModelConnectionRequestSchema,
  updateModelConnectionRequestSchema,
} from "@bb/server-contract";
import type { ModelConnection } from "@bb/domain";
import { action } from "../action.js";
import { createCliBbSdk } from "../client.js";
import {
  confirmDestructiveAction,
  outputJson,
  type JsonOutputOptions,
} from "./helpers.js";

interface FileOptions extends JsonOutputOptions {
  file: string;
}

interface ConnectionOptions extends JsonOutputOptions {
  file?: string;
  name?: string;
  provider?: string;
  host?: string;
  native?: boolean;
  gatewayBaseUrl?: string;
  gatewayProtocol?: string;
  gatewayAccountPrefix?: string;
  gatewayModelProvider?: string;
  gatewayCredentialEnv?: string;
  gatewayCredentialFile?: string;
  gatewayAllowedHost?: string[];
}

function addConnectionOptions(command: Command): Command {
  return command
    .option("--file <path>", "Local JSON definition containing references only")
    .option("--name <name>", "Connection display name")
    .option("--provider <id>", "Provider ID (gateway requires acp-omp)")
    .option("--host <id>", "Native connection host ID; clears gateway")
    .option("--native", "Clear gateway and use native host authentication")
    .option("--gateway-base-url <url>", "Gateway model API base URL")
    .option("--gateway-protocol <protocol>", "openai-responses, openai-completions, or anthropic-messages")
    .option("--gateway-account-prefix <prefix>", "Gateway account model namespace")
    .option("--gateway-model-provider <id>", "Native model catalog provider ID")
    .option("--gateway-credential-env <name>", "Worker environment variable name, never its value")
    .option("--gateway-credential-file <path>", "Absolute worker credential file path, never its contents")
    .option(
      "--gateway-allowed-host <id>",
      "Permitted worker host ID (repeat to replace the complete allowed host list)",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option("--json", "Print machine-readable JSON output")
    .addHelpText("after", CONNECTION_HELP);
}

function hasGatewayOptions(options: ConnectionOptions): boolean {
  return [
    options.gatewayBaseUrl,
    options.gatewayProtocol,
    options.gatewayAccountPrefix,
    options.gatewayModelProvider,
    options.gatewayCredentialEnv,
    options.gatewayCredentialFile,
    options.gatewayAllowedHost,
  ].some((value) => value !== undefined);
}

async function connectionDefinition(
  options: ConnectionOptions,
  current?: ModelConnection,
): Promise<Record<string, unknown>> {
  const definition: unknown = options.file
    ? await readDefinition(options.file)
    : {};
  if (!definition || typeof definition !== "object" || Array.isArray(definition))
    throw new Error("--file must contain a JSON definition object.");
  const input: Record<string, unknown> = { ...definition };
  if (options.name !== undefined) input.name = options.name;
  if (options.provider !== undefined) input.provider = options.provider;
  const gatewayOptions = hasGatewayOptions(options);
  if (gatewayOptions && (options.native || options.host !== undefined))
    throw new Error("Gateway flags cannot be combined with --native or --host.");
  if (options.gatewayCredentialEnv !== undefined && options.gatewayCredentialFile !== undefined)
    throw new Error("Choose only one gateway credential reference: env or file.");
  if (gatewayOptions) {
    if (options.provider !== undefined && options.provider !== "acp-omp")
      throw new Error("Gateway connections require --provider acp-omp.");
    const gateway = input.gateway === undefined ? current?.gateway : input.gateway;
    if (gateway !== undefined && gateway !== null &&
        (typeof gateway !== "object" || Array.isArray(gateway)))
      throw new Error("gateway must be a definition object or null.");
    input.gateway = {
      ...gateway,
      ...(options.gatewayBaseUrl !== undefined ? { baseUrl: options.gatewayBaseUrl } : {}),
      ...(options.gatewayProtocol !== undefined ? { protocol: options.gatewayProtocol } : {}),
      ...(options.gatewayAccountPrefix !== undefined ? { accountPrefix: options.gatewayAccountPrefix } : {}),
      ...(options.gatewayModelProvider !== undefined ? { modelProvider: options.gatewayModelProvider } : {}),
      ...(options.gatewayCredentialEnv !== undefined
        ? { credential: { kind: "env", name: options.gatewayCredentialEnv } }
        : options.gatewayCredentialFile !== undefined
          ? { credential: { kind: "file", path: options.gatewayCredentialFile } }
          : {}),
      ...(options.gatewayAllowedHost !== undefined ? { allowedHostIds: options.gatewayAllowedHost } : {}),
    };
    input.hostId = null;
    input.provider = "acp-omp";
    input.nativeAuth = { configDir: null, profile: null, hostEnv: null };
  } else if (options.native || options.host !== undefined) {
    input.gateway = null;
    input.hostId = options.host ?? input.hostId ?? current?.hostId;
    if (!input.hostId)
      throw new Error("Switching to native authentication requires --host <id>.");
  }
  return input;
}

function print(options: JsonOutputOptions, value: unknown): void {
  if (!outputJson(options, value)) console.log(JSON.stringify(value, null, 2));
}

async function readDefinition(path: string): Promise<unknown> {
  const text = await readFile(path, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("--file must contain a valid JSON definition object.");
  }
}

const CONTEXT_HELP = `
JSON fields: name, enabled, projectIds, instructions, skillRoots, commandRoots,
pluginRoots, settingsPaths, mcpServers:[{name,configPath}], hooksPath (or null),
autoMemory, gitIdentity:{name,email} (or null), defaultModelConnectionId (or null).
Create requires name; projectIds defaults to [] (no permitted projects).
Update accepts partial fields; omitted fields remain unchanged. IDs and timestamps
are not definition fields. Paths refer to the execution host, not this CLI machine.
MCP entries are config file references, not inline credentials.
Example: bb execution-context create --file work-context.json --json
`;

const CONNECTION_HELP = `
JSON fields: name, provider, hostId, enabled, revoked, gateway (or null),
nativeAuth:{configDir:string|null,profile:string|null,
hostEnv:{brokerUrlEnv:string,brokerTokenEnv:string}|null}.
Gateway fields: baseUrl, protocol, accountPrefix, modelProvider,
credential:{kind:"env",name} or {kind:"file",path}, allowedHostIds.
Gateway requires provider acp-omp, hostId:null and default nativeAuth.
Native requires hostId and gateway:null. Paths and environment names refer to
workers, never this CLI machine. Credentials are references only, never values.
Use --native --host <id> to clear a gateway. Gateway edit flags preserve omitted
gateway fields; repeated --gateway-allowed-host replaces the complete host list.
JSON fields and explicit flags can be combined; explicit flags take precedence.
Example: bb model-connection create --file work-account.json --json
`;

export function registerExecutionContextCommands(
  program: Command,
  getUrl: () => string,
): void {
  const context = program
    .command("execution-context")
    .description(
      "Manage logical instructions/tool contexts, not physical machine/workspace context",
    )
    .addHelpText("after", CONTEXT_HELP);

  context
    .command("mcp-inspect")
    .description(
      "Inspect host MCP configuration static validity; authentication is not checked",
    )
    .requiredOption("--machine <id>", "Machine hosting the configuration files")
    .requiredOption("--provider <id>", "Native provider ID")
    .requiredOption(
      "--config <path>",
      "Absolute configuration path on the host (repeatable)",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option("--json", "Print machine-readable JSON output")
    .addHelpText(
      "after",
      "\nReports static configuration validity only. Authentication is not checked. Paths refer to the selected host, not this CLI machine. No MCP connection is made.",
    )
    .action(
      action(
        async (
          opts: JsonOutputOptions & {
            machine: string;
            provider: string;
            config: string[];
          },
        ) => {
          const input = inspectMcpRequestSchema.parse({
            hostId: opts.machine,
            providerId: opts.provider,
            configPaths: opts.config,
          });
          print(
            opts,
            await createCliBbSdk(
              getUrl(),
            ).experimental_executionContexts.inspectMcp(input),
          );
        },
      ),
    );

  context
    .command("list")
    .description("List execution contexts")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: JsonOutputOptions) => {
        print(
          opts,
          await createCliBbSdk(getUrl()).experimental_executionContexts.list(),
        );
      }),
    );
  context
    .command("show <id>")
    .description("Show an execution context definition")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, opts: JsonOutputOptions) => {
        print(
          opts,
          await createCliBbSdk(getUrl()).experimental_executionContexts.get({
            id,
          }),
        );
      }),
    );
  context
    .command("create")
    .description("Create an execution context from a validated JSON file")
    .requiredOption("--file <path>", "Local JSON definition file")
    .option("--json", "Print machine-readable JSON output")
    .addHelpText("after", CONTEXT_HELP)
    .action(
      action(async (opts: FileOptions) => {
        const input = createExecutionContextRequestSchema.parse(
          await readDefinition(opts.file),
        );
        print(
          opts,
          await createCliBbSdk(getUrl()).experimental_executionContexts.create(
            input,
          ),
        );
      }),
    );
  context
    .command("update <id>")
    .description("Patch an execution context from a validated JSON file")
    .requiredOption(
      "--file <path>",
      "Local JSON file containing only fields to change",
    )
    .option("--json", "Print machine-readable JSON output")
    .addHelpText("after", CONTEXT_HELP)
    .action(
      action(async (id: string, opts: FileOptions) => {
        const input = updateExecutionContextRequestSchema
          .omit({ id: true })
          .parse(await readDefinition(opts.file));
        print(
          opts,
          await createCliBbSdk(getUrl()).experimental_executionContexts.update({
            id,
            ...input,
          }),
        );
      }),
    );
  context
    .command("delete <id>")
    .description("Delete an execution context")
    .option("--yes", "Skip confirmation")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (id: string, opts: JsonOutputOptions & { yes?: boolean }) => {
          if (
            !opts.yes &&
            !(await confirmDestructiveAction(`Delete execution context ${id}?`))
          )
            return;
          await createCliBbSdk(getUrl()).experimental_executionContexts.delete({
            id,
          });
          if (!outputJson(opts, { id, deleted: true }))
            console.log(`Deleted execution context ${id}`);
        },
      ),
    );
}

export function registerModelConnectionCommands(
  program: Command,
  getUrl: () => string,
): void {
  const connection = program
    .command("model-connection")
    .description(
      "Manage native or gateway model account references independently of execution contexts and models",
    )
    .addHelpText("after", CONNECTION_HELP);
  connection
    .command("list")
    .description("List model connections")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: JsonOutputOptions) => {
        print(
          opts,
          await createCliBbSdk(getUrl()).experimental_modelConnections.list(),
        );
      }),
    );
  connection
    .command("show <id>")
    .description("Show a model connection definition")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, opts: JsonOutputOptions) => {
        print(
          opts,
          await createCliBbSdk(getUrl()).experimental_modelConnections.get({
            id,
          }),
        );
      }),
    );
  addConnectionOptions(connection.command("create"))
    .description("Create a validated native or gateway model connection")
    .action(
      action(async (opts: ConnectionOptions) => {
        const input = createModelConnectionRequestSchema.parse(
          await connectionDefinition(opts),
        );
        print(
          opts,
          await createCliBbSdk(getUrl()).experimental_modelConnections.create(
            input,
          ),
        );
      }),
    );
  addConnectionOptions(connection.command("update <id>"))
    .description("Patch a validated native or gateway model connection")
    .action(
      action(async (id: string, opts: ConnectionOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const current = hasGatewayOptions(opts) || opts.native
          ? await sdk.experimental_modelConnections.get({ id })
          : undefined;
        const input = updateModelConnectionRequestSchema
          .omit({ id: true })
          .parse(await connectionDefinition(opts, current));
        print(
          opts,
          await createCliBbSdk(getUrl()).experimental_modelConnections.update({
            id,
            ...input,
          }),
        );
      }),
    );
  connection
    .command("delete <id>")
    .description("Delete a model connection")
    .option("--yes", "Skip confirmation")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (id: string, opts: JsonOutputOptions & { yes?: boolean }) => {
          if (
            !opts.yes &&
            !(await confirmDestructiveAction(`Delete model connection ${id}?`))
          )
            return;
          await createCliBbSdk(getUrl()).experimental_modelConnections.delete({
            id,
          });
          if (!outputJson(opts, { id, deleted: true }))
            console.log(`Deleted model connection ${id}`);
        },
      ),
    );
}
