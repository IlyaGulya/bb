import { cliCommand, type BbPluginApi, type PluginCliResult } from "@get-bb/plugin-sdk";
import type { TaskWorkflowHandlers } from "../workflow/index.js";
import type { TasksApiStore } from "../api/index.js";
import type { Task } from "../shared/contract.js";
import { workflowRpcContract } from "../shared/workflow-contract.js";
import { EMPTY_WORKFLOW_ROLE, workflowSelectionSchema, type WorkflowSelection } from "../shared/workflow-preparation.js";

export function workflowCommands(
  handlers: TaskWorkflowHandlers,
  resolveTask: (address: string) => Promise<Task>,
  guard: (action: () => Promise<string | PluginCliResult>) => Promise<PluginCliResult>,
  bb: BbPluginApi,
  store: TasksApiStore,
) {
  const task = { name: "task", description: "Task key or ID", required: true } as const;
  const id = { name: "id", description: "Task workflow receipt ID", required: true } as const;
  const json = { type: "boolean", description: "Emit machine-readable JSON" } as const;
  const revision = { type: "string", required: true, description: "Exact published revision for a human decision" } as const;
  const emit = (action: () => Promise<unknown> | unknown) => guard(async () => JSON.stringify(await action(), null, 2));
  const target = async (address: string) => ({ taskId: (await resolveTask(address)).id });
  const named = <T extends { id: string; name: string }>(entries: T[], address: string, label: string) => {
    const matches = entries.filter(entry => entry.name === address || entry.id === address);
    if (matches.length !== 1) throw new Error(`${label}: choose a unique existing name (found ${matches.length})`);
    return matches[0]!;
  };
  function preset(address: string): NonNullable<WorkflowSelection["writer"]> {
    const selected = named(store.tasks.listPresets(), address, "Profile");
    return { provider: selected.providerId, model: selected.modelId, reasoningLevel: selected.reasoningLevel, permissionMode: selected.permissionMode, serviceTier: selected.serviceTier, instructions: selected.instructions, executionContextId: selected.executionContextId ?? "", modelConnectionId: selected.modelConnectionId ?? "" };
  }
  return {
    "workflow draft show": cliCommand({ summary: "Read the server-saved task workflow draft without preparing or starting", positionals: [task], options: { json }, run: input => emit(async () => handlers.getTaskWorkflowDraft(await target(input.positionals.task))) }),
    "workflow draft set": cliCommand({
      summary: "Save task-scoped workflow choices using readable profile, machine, context and account names",
      positionals: [task],
      options: {
        json,
        template: { type: "string", description: "development-review or bugfix" },
        machine: { type: "string", description: "Enrolled machine name" },
        writer: { type: "string", description: "Writer profile name; copies its choices, not global defaults" },
        reviewer: { type: "string", description: "Independent reviewer profile name" },
        "writer-model": { type: "string", description: "Exact selected writer model version" },
        "reviewer-model": { type: "string", description: "Exact selected reviewer model version" },
        "writer-account": { type: "string", description: "Writer model account name" },
        "reviewer-account": { type: "string", description: "Reviewer model account name" },
        "writer-context": { type: "string", description: "Writer execution context name" },
        "reviewer-context": { type: "string", description: "Reviewer execution context name" },
        "writer-reasoning": { type: "string", description: "Writer reasoning level" },
        "reviewer-reasoning": { type: "string", description: "Reviewer reasoning level" },
        "writer-permission": { type: "string", description: "Writer permission mode: full, auto or accept-edits" },
        "reviewer-permission": { type: "string", description: "Reviewer permission mode: full, auto or accept-edits" },
        "writer-tier": { type: "string", description: "Explicit writer service tier" },
        "reviewer-tier": { type: "string", description: "Explicit reviewer service tier" },
        "writer-instructions": { type: "string", description: "Task-scoped writer instructions" },
        "reviewer-instructions": { type: "string", description: "Task-scoped reviewer instructions" },
        checks: { type: "string", description: "JSON array of configured real platform smoke commands" },
        ui: { type: "boolean", description: "Require real UI evidence" },
        selection: { type: "string", description: "Complete typed selection JSON for SDK/automation parity; named flags override it" },
      },
      run(input) {
        return emit(async () => {
          const address = await target(input.positionals.task);
          const draft = await handlers.getTaskWorkflowDraft(address);
          const selection = input.options.selection ? workflowSelectionSchema.parse(JSON.parse(input.options.selection)) : { ...draft.selection };
          if (input.options.template) selection.template = workflowSelectionSchema.shape.template.parse(input.options.template);
          if (input.options.machine) selection.hostId = named(await bb.sdk.hosts.list(), input.options.machine, "Machine").id;
          if (input.options.writer) selection.writer = preset(input.options.writer);
          if (input.options.reviewer) selection.reviewer = preset(input.options.reviewer);
          for (const role of ["writer", "reviewer"] as const) {
            const model = role === "writer" ? input.options["writer-model"] : input.options["reviewer-model"];
            const account = role === "writer" ? input.options["writer-account"] : input.options["reviewer-account"];
            const context = role === "writer" ? input.options["writer-context"] : input.options["reviewer-context"];
            const reasoning = role === "writer" ? input.options["writer-reasoning"] : input.options["reviewer-reasoning"];
            const permission = role === "writer" ? input.options["writer-permission"] : input.options["reviewer-permission"];
            const tier = role === "writer" ? input.options["writer-tier"] : input.options["reviewer-tier"];
            const instructions = role === "writer" ? input.options["writer-instructions"] : input.options["reviewer-instructions"];
            if (model === undefined && account === undefined && context === undefined && reasoning === undefined && permission === undefined && tier === undefined && instructions === undefined) continue;
            const updated = { ...(selection[role] ?? EMPTY_WORKFLOW_ROLE) };
            if (account) {
              const connection = named(await bb.sdk.experimental_modelConnections.list(), account, `${role} account`);
              if (connection.provider !== updated.provider) updated.model = "";
              updated.modelConnectionId = connection.id;
              updated.provider = connection.provider;
            }
            if (context) updated.executionContextId = named(await bb.sdk.experimental_executionContexts.list(), context, `${role} context`).id;
            if (reasoning !== undefined) updated.reasoningLevel = reasoning;
            if (permission !== undefined) updated.permissionMode = workflowSelectionSchema.shape.writer.unwrap().shape.permissionMode.parse(permission);
            if (tier !== undefined) updated.serviceTier = tier;
            if (instructions !== undefined) updated.instructions = instructions;
            if (model !== undefined) {
              if (!selection.hostId || !updated.modelConnectionId || !updated.provider) throw new Error(`${role}: choose a named machine and model account before selecting a model version`);
              const catalog = await bb.sdk.providers.models({ hostId: selection.hostId, providerId: updated.provider, modelConnectionId: updated.modelConnectionId });
              if (catalog.modelLoadError) throw new Error(`${role}: account model catalog unavailable (${catalog.modelLoadError.code})`);
              const matches = [...catalog.models, ...catalog.selectedOnlyModels].filter(entry => entry.id === model || entry.model === model || entry.displayName === model || entry.model.replace(/^bb-cpa\/[^/]+\//, "") === model);
              if (matches.length !== 1) throw new Error(`${role}: choose a unique version offered by the selected account; no model was substituted`);
              updated.model = matches[0]!.model;
            }
            selection[role] = updated;
          }
          if (input.options.checks) selection.smokeCommands = JSON.parse(input.options.checks);
          if (input.options.ui !== undefined) selection.uiRequired = input.options.ui;
          return handlers.saveTaskWorkflowDraft({ ...address, revision: draft.revision, selection: workflowSelectionSchema.parse(selection) });
        });
      },
    }),
    "workflow settings show": cliCommand({ summary: "Read only this task project's settings for the selected draft template", positionals: [task], options: { json }, run: input => emit(async () => { const address = await target(input.positionals.task); const draft = await handlers.getTaskWorkflowDraft(address); return handlers.getProjectWorkflowSettings({ ...address, template: draft.selection.template }); }) }),
    "workflow settings save": cliCommand({ summary: "Explicitly save this task draft as its project's template settings; never changes global presets", positionals: [task], options: { json }, run: input => emit(async () => { const address = await target(input.positionals.task); const draft = await handlers.getTaskWorkflowDraft(address); const current = await handlers.getProjectWorkflowSettings({ ...address, template: draft.selection.template }); return handlers.saveProjectWorkflowSettings({ ...address, revision: current.revision, selection: draft.selection }); }) }),
    "workflow settings apply": cliCommand({ summary: "Explicitly copy this project's selected-template settings into this task draft", positionals: [task], options: { json }, run: input => emit(async () => { const address = await target(input.positionals.task); const draft = await handlers.getTaskWorkflowDraft(address); const current = await handlers.getProjectWorkflowSettings({ ...address, template: draft.selection.template }); if (!current.selection) throw new Error("No saved project settings for this template"); return handlers.saveTaskWorkflowDraft({ ...address, revision: draft.revision, selection: current.selection }); }) }),
    "workflow prepare": cliCommand({ summary: "Prepare one isolated native workspace and Core-admitted contexts; never starts a model turn", positionals: [task], options: { json }, run: input => emit(async () => { const address = await target(input.positionals.task); const draft = await handlers.getTaskWorkflowDraft(address); const saved = draft.revision ? draft : await handlers.saveTaskWorkflowDraft({ ...address, revision: 0, selection: draft.selection }); return handlers.prepareTaskWorkflow({ ...address, revision: saved.revision }); }) }),
    "workflow preparation": cliCommand({ summary: "Observe or reconcile native preparation receipts without duplicate workspaces or implementation", positionals: [task], options: { json }, run: input => emit(async () => handlers.getTaskWorkflowPreparation(await target(input.positionals.task))) }),
    "workflow start": cliCommand({ summary: "Explicitly start the prepared task workflow; idempotent, no origin thread input and no automatic acceptance", positionals: [task], options: { json }, run: input => emit(async () => { const address = await target(input.positionals.task); const preparation = await handlers.getTaskWorkflowPreparation(address); if (!preparation) throw new Error("Run workflow prepare first"); return handlers.launchTaskWorkflow({ ...address, preparationId: preparation.id }); }) }),
    "workflow list": cliCommand({ summary: "Inspect workflow receipts, retained native workers and observed result packages", positionals: [task], options: { json }, run: input => emit(async () => handlers.taskWorkflows(await target(input.positionals.task))) }),
    "workflow accept": cliCommand({ summary: "Human acceptance of the exact reviewed revision; never merges or deploys", positionals: [id], options: { json, revision }, run: input => emit(async () => handlers.acceptTaskWorkflow(workflowRpcContract.acceptTaskWorkflow.input.parse({ id: input.positionals.id, revision: Number(input.options.revision) }))) }),
    "workflow return": cliCommand({ summary: "Return feedback to the same retained writer session and owned workspace", positionals: [id], options: { json, revision, feedback: { type: "string", required: true, description: "Explicit human revision feedback" } }, run: input => emit(async () => handlers.returnTaskWorkflow(workflowRpcContract.returnTaskWorkflow.input.parse({ id: input.positionals.id, revision: Number(input.options.revision), feedback: input.options.feedback }))) }),
  };
}
