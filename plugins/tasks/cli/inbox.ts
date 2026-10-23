import { cliCommand, type PluginCliResult } from "@get-bb/plugin-sdk";
import type { InboxHandlers } from "../inbox/index.js";
import { inboxRpcContract } from "../shared/inbox-contract.js";
import type { Project, Task } from "../shared/contract.js";

const json = {
  type: "boolean",
  description: "Emit machine-readable JSON",
} as const;
const id = {
  name: "id",
  description: "Inbox entry ID from inbox list",
  required: true,
} as const;
function render(value: object, compact?: boolean) {
  return JSON.stringify(value, null, compact ? undefined : 2);
}
export function inboxCommands(
  handlers: InboxHandlers,
  resolveTask: (address: string) => Promise<Task>,
  resolveProject: (address: string) => Promise<Project>,
  guard: (
    action: () => Promise<string | PluginCliResult>,
  ) => Promise<PluginCliResult>,
) {
  return {
    "inbox list": cliCommand({
      summary:
        "List New, Needs input and Review attention, independently of tasks",
      options: {
        json,
        state: {
          type: "string",
          description: "open (default), snoozed, resolved, or all",
        },
        context: {
          type: "string",
          description: "work, personal, or unknown; organization only, not ACL",
        },
      },
      run(input) {
        return guard(async () =>
          render(
            await handlers.listInbox(
              inboxRpcContract.listInbox.input.parse(input.options),
            ),
            input.options.json,
          ),
        );
      },
    }),
    working: cliCommand({
      summary:
        "List native starting/running linked agents, not accepted results",
      options: { json },
      run(input) {
        return guard(async () =>
          render(await handlers.listWorking({}), input.options.json),
        );
      },
    }),
    "inbox add": cliCommand({
      summary: "Capture manual incoming without creating a task or thread",
      options: {
        json,
        title: {
          type: "string",
          required: true,
          description: "Incoming title",
        },
        body: { type: "string", description: "Context and details" },
        context: { type: "string", description: "work, personal, or unknown" },
        "source-url": {
          type: "string",
          description: "Optional http(s) source link",
        },
      },
      run(input) {
        return guard(async () =>
          render(
            await handlers.createInbox(
              inboxRpcContract.createInbox.input.parse({
                ...input.options,
                sourceUrl: input.options["source-url"],
              }),
            ),
            input.options.json,
          ),
        );
      },
    }),
    "inbox resolve": cliCommand({
      summary:
        "Dismiss an inbox revision; never completes a task or answers an agent",
      positionals: [id],
      options: { json },
      run(input) {
        return guard(async () =>
          render(
            await handlers.decideInbox({
              id: input.positionals.id,
              action: "resolve",
            }),
            input.options.json,
          ),
        );
      },
    }),
    "inbox snooze": cliCommand({
      summary: "Snooze until an ISO-8601 time; server returns it automatically",
      positionals: [id],
      options: {
        json,
        until: {
          type: "string",
          required: true,
          description: "Future ISO-8601 timestamp with timezone",
        },
      },
      run(input) {
        return guard(async () =>
          render(
            await handlers.decideInbox({
              id: input.positionals.id,
              action: "snooze",
              until: input.options.until,
            }),
            input.options.json,
          ),
        );
      },
    }),
    "inbox unsnooze": cliCommand({
      summary: "Return an active snoozed or dismissed item to attention",
      positionals: [id],
      options: { json },
      run(input) {
        return guard(async () =>
          render(
            await handlers.decideInbox({
              id: input.positionals.id,
              action: "unsnooze",
            }),
            input.options.json,
          ),
        );
      },
    }),
    "inbox link": cliCommand({
      summary: "Link one existing native task and resolve the incoming item",
      positionals: [id],
      options: {
        json,
        task: {
          type: "string",
          required: true,
          description: "Existing task key or ID",
        },
      },
      run(input) {
        return guard(async () =>
          render(
            await handlers.linkInboxTask({
              id: input.positionals.id,
              taskId: (await resolveTask(input.options.task)).id,
            }),
            input.options.json,
          ),
        );
      },
    }),
    "inbox task": cliCommand({
      summary:
        "Create exactly one native task for this incoming, without dispatching",
      positionals: [id],
      options: {
        json,
        project: {
          type: "string",
          required: true,
          description: "Tracker project prefix or ID",
        },
      },
      run(input) {
        return guard(async () =>
          render(
            await handlers.createInboxTask({
              id: input.positionals.id,
              projectId: (await resolveProject(input.options.project)).id,
            }),
            input.options.json,
          ),
        );
      },
    }),
    "inbox source": cliCommand({
      summary: "Upsert or resolve a durable external source revision",
      description:
        "JSON fields: sourceKind, sourceKey, revision, title, body, active; optional context, sourceUrl. active:false resolves only this inbox source. Same revision never reopens dismissal; a meaningful new revision does. Native source kinds are reserved.",
      options: {
        json,
        data: {
          type: "string",
          required: true,
          description:
            "JSON source envelope, never a polling timestamp revision",
        },
      },
      run(input) {
        return guard(async () =>
          render(
            await handlers.upsertInboxSource(
              inboxRpcContract.upsertInboxSource.input.parse(
                JSON.parse(input.options.data),
              ),
            ),
            input.options.json,
          ),
        );
      },
    }),
    "inbox history": cliCommand({
      summary: "Read retained source revisions and human decisions",
      positionals: [id],
      options: { json },
      run(input) {
        return guard(async () =>
          render(
            await handlers.inboxHistory({ id: input.positionals.id }),
            input.options.json,
          ),
        );
      },
    }),
  };
}
