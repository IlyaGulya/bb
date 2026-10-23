import {
  cliCommand,
  defineCli,
  type BbPluginApi,
  type PluginCliResult,
} from "@get-bb/plugin-sdk";
import {
  configurationSchema,
  type Configuration,
  type Status,
} from "./contract.js";
import { SETUP } from "./setup.js";

export type SlackActions = {
  status: () => Status;
  configure: (configuration: Configuration) => Promise<Status>;
  checkCoverage: () => Promise<Status>;
  retry: () => Promise<Status>;
};
export function registerCli(bb: BbPluginApi, actions: SlackActions): void {
  async function output(
    work: () => unknown | Promise<unknown>,
  ): Promise<PluginCliResult> {
    try {
      return {
        exitCode: 0,
        stdout: `${JSON.stringify(await work(), null, 2)}\n`,
      };
    } catch {
      return {
        exitCode: 1,
        stderr:
          "Slack Inbox operation failed. Check configuration and safe status diagnostics.\n",
      };
    }
  }
  bb.cli.register(
    defineCli({
      name: "slack-inbox",
      summary: "Approved Slack human-mention intake; never task dispatch",
      root: cliCommand({
        summary: "Show Slack Inbox commands",
        run: ({ help }) => ({ exitCode: 0, stdout: help }),
      }),
      commands: {
        status: cliCommand({
          summary:
            "Connection, durable delivery, real coverage and gap status (JSON)",
          run: () => output(actions.status),
        }),
        setup: cliCommand({
          summary: "Exact app permissions and safe setup instructions (JSON)",
          run: () => output(() => SETUP),
        }),
        configure: cliCommand({
          summary:
            "Replace non-secret configuration; --yes acknowledges approved scope (JSON)",
          options: {
            data: {
              type: "string",
              description:
                "Configuration JSON: enabled, approved, teamId, userId, context, conversations",
            },
            yes: {
              type: "boolean",
              description: "Confirm approved configuration change",
            },
          },
          run: ({ options }) =>
            output(async () => {
              if (!options.yes || !options.data)
                throw new Error("Configuration and confirmation required");
              return actions.configure(
                configurationSchema.parse(JSON.parse(options.data)),
              );
            }),
        }),
        coverage: cliCommand({
          summary:
            "Recheck selected conversation access; no message history reads (JSON)",
          run: () => output(actions.checkCoverage),
        }),
        retry: cliCommand({
          summary: "Retry durable Inbox delivery and failed connection (JSON)",
          run: () => output(actions.retry),
        }),
      },
    }),
  );
}
