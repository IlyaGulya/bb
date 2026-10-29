import { cliCommand, type PluginCliResult } from "@get-bb/plugin-sdk";
import type { RoutingHandlers } from "../routing/index.js";
import { LOCAL_AWAY_BOUNDARY, routingRpcContract } from "../shared/routing.js";
import type { Project, Task } from "../shared/contract.js";

export function routingCommands(handlers: RoutingHandlers, resolveTask: (address: string) => Promise<Task>, resolveProject: (address: string) => Promise<Project>, guard: (action: () => Promise<string | PluginCliResult>) => Promise<PluginCliResult>) {
  const id = { name: "id", description: "Native Inbox entry ID", required: true } as const;
  const json = { type: "boolean", description: "Emit compact JSON" } as const;
  const operation = { type: "string", required: true, description: "Unique operation ID; reuse exactly this ID and input when reading a receipt after uncertain delivery" } as const;
  const revision = { type: "integer", min: 0, max: Number.MAX_SAFE_INTEGER, required: true, description: "Exact routing preview revision from route show; 0 before the first preview" } as const;
  const grant = { type: "string", description: "Explicit local-away grant ID; omission is a manual local action, not autonomous permission" } as const;
  const emit = (work: () => Promise<object>, compact: boolean | undefined) => guard(async () => JSON.stringify(await work(), null, compact ? undefined : 2));
  return {
    "route show": cliCommand({ summary: "Inspect routing advice, stale state, local-away scope and idempotent action journal", positionals: [id], options: { json }, run: input => emit(async () => handlers.getInboxRoute({ id: input.positionals.id }), input.options.json) }),
    "route preview": cliCommand({
      summary: "Preview an exact-task or semantic advisory route without sending, preparing or launching work",
      description: `${LOCAL_AWAY_BOUNDARY} Semantic advice requires --semantic and an explicitly selected Core task-route service. It makes at most one completion callback, not a guaranteed single physical model request.`,
      positionals: [id],
      options: { json, operation, revision, grant,
        "source-revision": { type: "string", required: true, description: "Exact Inbox source revision from inbox list" },
        project: { type: "string", description: "Tracker project prefix or ID; required for an explicit new-task proposal" },
        task: { type: "string", description: "Exact native task key or ID; resolved without a classifier" },
        "new-task": { type: "boolean", description: "Explicitly propose a separate new task if no exact existing task reference resolves" },
        semantic: { type: "boolean", description: "Explicitly invoke the selected task-route helper; unavailable in local-away scope" },
      },
      run: input => emit(async () => handlers.previewInboxRoute(routingRpcContract.previewInboxRoute.input.parse({
        id: input.positionals.id, operationId: input.options.operation, grantId: input.options.grant ?? null,
        sourceRevision: input.options["source-revision"], expectedRevision: input.options.revision,
        projectId: input.options.project ? (await resolveProject(input.options.project)).id : null,
        taskRef: input.options.task ?? "", newTask: input.options["new-task"] === true, semantic: input.options.semantic === true,
      })), input.options.json),
    }),
    "route apply": cliCommand({
      summary: "Apply one revision-CAS local routing action; never sends to or replaces an executor",
      description: `${LOCAL_AWAY_BOUNDARY} Action JSON: {kind:'link'}, {kind:'create'}, {kind:'target',target}, or {kind:'workflow-draft',draftRevision,selection}. Native/external/production/governance/Jira/Accept/unknown requests are parked in Needs input.`,
      positionals: [id], options: { json, operation, revision, grant, action: { type: "string", required: true, description: "Strict typed routing-action JSON; source text never defines allowed operations" } },
      run: input => emit(async () => handlers.applyInboxRoute(routingRpcContract.applyInboxRoute.input.parse({ id: input.positionals.id, operationId: input.options.operation, grantId: input.options.grant ?? null, expectedRevision: input.options.revision, action: JSON.parse(input.options.action) })), input.options.json),
    }),
    "away enable": cliCommand({
      summary: "Explicitly enable bounded local-action away for selected Inbox entries and native tasks",
      description: LOCAL_AWAY_BOUNDARY,
      options: { json, operation,
        project: { type: "string", required: true, description: "Tracker project prefix or ID" },
        inboxes: { type: "string", required: true, description: "Comma-separated native Inbox entry IDs; at most 20" },
        tasks: { type: "string", description: "Comma-separated existing task keys/IDs explicitly in scope; omission admits no existing task" },
        actions: { type: "string", required: true, description: "Comma-separated allowlist: preview,link,create,target,workflow-draft" },
        attempts: { type: "integer", min: 1, max: 100, required: true, description: "Server-reserved action-attempt budget, including failed/stale admitted attempts; not model requests" },
        seconds: { type: "integer", min: 1, max: 3600, required: true, description: "Absolute grant lifetime; no restart renewal" },
        "acknowledge-local-only": { type: "boolean", description: "Required acknowledgement: no native execution, external actions, Accept or physical model-call guarantee" },
      },
      run: input => emit(async () => {
        const taskIds = [];
        for (const address of input.options.tasks?.split(",").map(value => value.trim()).filter(Boolean) ?? []) taskIds.push((await resolveTask(address)).id);
        return handlers.enableLocalAway(routingRpcContract.enableLocalAway.input.parse({ operationId: input.options.operation, projectId: (await resolveProject(input.options.project)).id, inboxIds: input.options.inboxes.split(",").map(value => value.trim()), taskIds, actions: input.options.actions.split(",").map(value => value.trim()), maxAttempts: input.options.attempts, durationSeconds: input.options.seconds, acknowledgedBoundary: input.options["acknowledge-local-only"] === true }));
      }, input.options.json),
    }),
    "away revoke": cliCommand({ summary: "Revoke an explicit local-away grant; retained receipts and consumed attempts never reset", positionals: [{ name: "id", description: "Local-away grant ID", required: true }], options: { json }, run: input => emit(async () => handlers.revokeLocalAway({ id: input.positionals.id }), input.options.json) }),
  };
}
