import { readFile } from "node:fs/promises";
import { Command } from "commander";
import {
  createExecutionContextRequestSchema,
  inspectMcpRequestSchema,
  updateExecutionContextRequestSchema,
  createModelConnectionRequestSchema,
  updateModelConnectionRequestSchema,
} from "@bb/server-contract";
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
JSON fields: name, provider, hostId, enabled, revoked,
nativeAuth:{configDir:string|null,profile:string|null,
hostEnv:{brokerUrlEnv:string,brokerTokenEnv:string}|null}.
Create requires name, provider and hostId. Update accepts partial fields; omitted
fields remain unchanged. IDs and timestamps are not definition fields.
Native auth contains references only; do not put tokens, API keys or credentials
in this file. configDir refers to a directory on the permitted host. hostEnv
contains host environment variable names only, never broker URLs or token values.
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
      "Manage native provider account references independently of execution contexts and models",
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
  connection
    .command("create")
    .description("Create a native model connection from a validated JSON file")
    .requiredOption(
      "--file <path>",
      "Local JSON definition file; native references only, no credentials",
    )
    .option("--json", "Print machine-readable JSON output")
    .addHelpText("after", CONNECTION_HELP)
    .action(
      action(async (opts: FileOptions) => {
        const input = createModelConnectionRequestSchema.parse(
          await readDefinition(opts.file),
        );
        print(
          opts,
          await createCliBbSdk(getUrl()).experimental_modelConnections.create(
            input,
          ),
        );
      }),
    );
  connection
    .command("update <id>")
    .description("Patch a model connection from a validated JSON file")
    .requiredOption(
      "--file <path>",
      "Local JSON file containing only fields to change",
    )
    .option("--json", "Print machine-readable JSON output")
    .addHelpText("after", CONNECTION_HELP)
    .action(
      action(async (id: string, opts: FileOptions) => {
        const input = updateModelConnectionRequestSchema
          .omit({ id: true })
          .parse(await readDefinition(opts.file));
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
