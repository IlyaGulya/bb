import { createHash } from "node:crypto";
import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { TasksApiStore } from "../api/index.js";
import { workflowSetupContract, type WorkflowPreparation, type WorkflowSelection } from "../shared/workflow-preparation.js";
import { WorkflowPreparationStore } from "./preparation-store.js";
import { environmentThreads, requireIdleTask, withTaskExecution } from "../delegate/execution.js";
import { RepositoryStore } from "../repositories/store.js";
const profileKey = (selection: WorkflowSelection, role: "writer" | "reviewer") => createHash("sha256").update(JSON.stringify(selection[role])).digest("hex");

const failure = (error: unknown) => error instanceof Error ? error.message : String(error);
const rejected = z.object({ status: z.union([z.literal(400), z.literal(401), z.literal(403), z.literal(404), z.literal(409), z.literal(422)]), code: z.string().min(1) });

export function requireWorkflowSelection(selection: WorkflowSelection) {
  const { writer, reviewer, hostId } = selection;
  if (!hostId) throw new Error("Machine: choose an execution machine");
  if (!writer || !reviewer) throw new Error("Roles: choose both writer and independent reviewer");
  if (!selection.smokeCommands.length) throw new Error("Checks: configure the actual project/template smoke commands before preparing");
  for (const [role, profile] of [["Writer", writer], ["Reviewer", reviewer]] as const) {
    if (!profile.provider || !profile.model || !profile.reasoningLevel) throw new Error(`${role}: choose an actual provider/model version and reasoning level`);
    if (!profile.executionContextId || !profile.modelConnectionId)
      throw new Error(`${role}: explicitly select context and model account; workflow execution never inherits a payer`);
  }
  return { writer, reviewer, hostId };
}

export function createWorkflowPreparation(bb: BbPluginApi, store: TasksApiStore) {
  const persistence = new WorkflowPreparationStore(store);
  const active = new Map<string, Promise<WorkflowPreparation>>();
  async function validate(taskId: string, selection: WorkflowSelection, environmentId?: string) {
    const project = persistence.project(taskId);
    if (!project.linkedBbProjectId) throw new Error("Project: link this tracker project to a code project first");
    const roles = requireWorkflowSelection(selection);
    const hosts = await bb.sdk.hosts.list();
    const host = hosts.find(entry => entry.id === roles.hostId);
    if (!host) throw new Error("Machine: selected machine is no longer enrolled");
    if (host.status !== "connected") throw new Error("Machine: reconnect the selected machine before preparing or starting");
    const contexts = await bb.sdk.experimental_executionContexts.list();
    const connections = await bb.sdk.experimental_modelConnections.list();
    for (const role of ["writer", "reviewer"] as const) {
      const profile = roles[role];
      const context = contexts.find(entry => entry.id === profile.executionContextId);
      if (!context?.enabled || !context.projectIds.includes(project.linkedBbProjectId)) throw new Error(`${role}: context is unavailable or does not include this code project`);
      const connection = connections.find(entry => entry.id === profile.modelConnectionId);
      if (!connection?.enabled || connection.revoked || connection.provider !== profile.provider || (connection.gateway ? !connection.gateway.allowedHostIds.includes(roles.hostId) : connection.hostId !== roles.hostId))
        throw new Error(`${role}: account is missing, revoked, disabled or incompatible with the selected provider/machine; choose an account explicitly`);
      const catalog = await bb.sdk.providers.models({ hostId: roles.hostId, projectId: project.linkedBbProjectId, providerId: profile.provider, modelConnectionId: connection.id });
      if (catalog.modelLoadError) throw new Error(`${role}: selected account model catalog is unavailable (${catalog.modelLoadError.code})`);
      const model = [...catalog.models, ...catalog.selectedOnlyModels].find(entry => entry.model === profile.model || entry.id === profile.model);
      if (!model) throw new Error(`${role}: selected model is no longer offered by this account`);
      if (!model.supportedReasoningEfforts.some(entry => entry.reasoningEffort === profile.reasoningLevel)) throw new Error(`${role}: selected reasoning level is unavailable`);
    }
    if (environmentId) {
      const environment = await bb.sdk.environments.get({ environmentId });
      if (environment.projectId !== project.linkedBbProjectId || environment.hostId !== roles.hostId || environment.status !== "ready" || environment.lifecycle.phase !== "active" || environment.hostLifecycle !== "active")
        throw new Error("Workspace: prepared environment is unavailable or no longer belongs to this project/machine");
      if ((await environmentThreads(bb, environmentId)).some(thread => !["idle", "error"].includes(thread.status)))
        throw new Error("Workspace: another active operation holds this workspace; wait for it to settle");
    }
    await requireIdleTask(bb, store.tasks, taskId);
    return { ...roles, projectId: project.linkedBbProjectId };
  }
  async function discover(view: WorkflowPreparation, role: "writer" | "reviewer") {
    for (let offset = 0; ; offset += 100) {
      const threads = await bb.sdk.threads.list({ projectId: view.projectId, originPluginId: bb.pluginId, includeHidden: true, limit: 100, offset });
      for (const thread of threads) {
        const metadata = z.object({ workflowPreparation: z.string(), role: z.enum(["writer", "reviewer"]), preparationProfile: z.string() }).safeParse(await bb.sdk.threads.getPluginMetadata({ threadId: thread.id }));
        if (metadata.success && metadata.data.workflowPreparation === view.id && metadata.data.role === role && metadata.data.preparationProfile === profileKey(view.selection, role)) return thread.id;
      }
      if (threads.length < 100) return null;
    }
  }
  async function advance(taskId: string): Promise<WorkflowPreparation> {
    const pending = active.get(taskId);
    if (pending) return pending;
    const work = (async () => {
      let view = persistence.preparation(taskId);
      if (!view) throw new Error("Prepare this task first");
      const save = (patch: Partial<WorkflowPreparation>) => {
        view = persistence.savePreparation({ ...view!, ...patch });
        bb.realtime.publish("workflows:changed", { taskId });
        return view;
      };
      try {
        const selection = await validate(taskId, view.selection);
        for (const role of ["writer", "reviewer"] as const) {
          const column = role === "writer" ? "threadId" : "reviewerThreadId";
          const receiptRole = `${role}:${profileKey(view.selection, role)}`;
          let threadId = view[column];
          if (!threadId) {
            const receipt = store.database.prepare<[string, string], { state: string }>("SELECT state FROM task_workflow_preparation_deliveries WHERE preparation_id = ? AND role = ?").get(view.id, receiptRole);
            if (receipt) threadId = await discover(view, role);
            if (!threadId && receipt && receipt.state !== "rejected") return save({ state: "uncertain", error: `${role} preparation delivery is uncertain. No duplicate context or branch was created. Reconcile native preparation before retrying.`, progress: "Preparation requires reconciliation; no implementation started" });
            if (!threadId) {
              if (role === "reviewer" && !view.environmentId) return save({ state: "preparing", progress: "Preparing isolated workspace; no implementation started" });
              store.database.prepare(`INSERT INTO task_workflow_preparation_deliveries(preparation_id, role, state) VALUES (?, ?, 'sending') ON CONFLICT(preparation_id, role) DO UPDATE SET state = 'sending'`).run(view.id, receiptRole);
              save({ state: "creating", error: null, progress: `Validating ${role} through Core and preparing the native workspace; no model turn` });
              try {
                const profile = selection[role];
                const thread = await bb.sdk.threads.spawn({
                  projectId: selection.projectId,
                  environment: view.environmentId ? { type: "reuse", environmentId: view.environmentId } : { type: "provider", environmentProviderId: "git-worktree", machine: { type: "existing", hostId: selection.hostId }, inputs: { branch: view.selection.baseBranch ? { kind: "named", name: view.selection.baseBranch } : { kind: "default" } } },
                  input: [], preparationOnly: true, title: `Workflow preparation · ${persistence.store.tasks.getTask(taskId)!.key} · ${role}`,
                  providerId: profile.provider, model: profile.model, reasoningLevel: profile.reasoningLevel, permissionMode: profile.permissionMode,
                  executionContextId: profile.executionContextId, modelConnectionId: profile.modelConnectionId,
                  ...(profile.serviceTier === null ? {} : { serviceTier: profile.serviceTier }),
                  pluginMetadata: { workflowPreparation: view.id, role, preparationProfile: profileKey(view.selection, role) }, visibility: "hidden",
                });
                threadId = thread.id;
              } catch (error) {
                if (rejected.safeParse(error).success) {
                  store.database.prepare("UPDATE task_workflow_preparation_deliveries SET state = 'rejected' WHERE preparation_id = ? AND role = ?").run(view.id, receiptRole);
                  throw new Error(`${role}: ${failure(error)}`);
                }
                return save({ state: "uncertain", error: `${role}: preparation acknowledgement is uncertain (${failure(error)}). Native ownership will be reconciled; no replacement branch or context was created`, progress: "Preparation delivery needs reconciliation; no implementation started" });
              }
            }
            store.database.prepare("UPDATE task_workflow_preparation_deliveries SET state = 'confirmed' WHERE preparation_id = ? AND role = ?").run(view.id, receiptRole);
            save({ [column]: threadId, state: "preparing", error: null });
          }
          const thread = await bb.sdk.threads.get({ threadId });
          if (role === "writer" && thread.environmentId) {
            if (view.environmentId && view.environmentId !== thread.environmentId) throw new Error("Workspace: native preparation moved away from its owned environment");
            save({ environmentId: thread.environmentId });
          }
          if (thread.deletedAt !== null || thread.archivedAt !== null || thread.status === "error") throw new Error(`${role}: native preparation failed or context is unavailable; the existing receipt and workspace are retained`);
          if (thread.status !== "idle" || !thread.environmentId) return save({ state: "preparing", progress: `Preparing ${role} context and isolated workspace; no model turn` });
          if (role === "writer") save({ environmentId: thread.environmentId });
          else if (thread.environmentId !== view.environmentId) throw new Error("Reviewer context moved away from the owned workspace");
        }
        await validate(taskId, view.selection, view.environmentId!);
        const status = await bb.sdk.environments.status({ environmentId: view.environmentId! });
        if (status.outcome !== "available" || status.workspace.checkout.kind !== "branch" || status.workspace.workingTree.hasUncommittedChanges) throw new Error("Workspace: require an available clean committed branch before Start");
        const environment = await bb.sdk.environments.get({ environmentId: view.environmentId! });
        return save({ state: "ready", error: null, progress: "Ready. No implementation has started; Start is explicit", workspacePath: environment.path, branch: status.workspace.checkout.branchName, head: status.workspace.checkout.headSha });
      } catch (error) {
        const uncertain = store.database.prepare("SELECT 1 FROM task_workflow_preparation_deliveries WHERE preparation_id = ? AND state = 'sending'").get(view.id);
        return save({ state: uncertain ? "uncertain" : "failed", error: failure(error), progress: "Preparation stopped; draft and native receipts retained. No replacement workspace was created" });
      }
    })().finally(() => active.delete(taskId));
    active.set(taskId, work);
    return work;
  }
  const handlers: PluginRpcHandlers<typeof workflowSetupContract> = {
    async getTaskWorkflowProject({ taskId }) {
      const tracker = persistence.project(taskId);
      if (!tracker.linkedBbProjectId) return null;
      const project = await bb.sdk.projects.get({ projectId: tracker.linkedBbProjectId });
      return { id: project.id, name: project.name };
    },
    getTaskWorkflowDraft: ({ taskId }) => persistence.draft(taskId),
    saveTaskWorkflowDraft: ({ taskId, revision, selection }) => persistence.saveDraft(taskId, revision, selection),
    getProjectWorkflowSettings: ({ taskId, template }) => persistence.settings(taskId, template),
    saveProjectWorkflowSettings: ({ taskId, revision, selection }) => persistence.saveSettings(taskId, revision, selection),
    async prepareTaskWorkflow({ taskId, revision }) {
      return withTaskExecution(taskId, async () => {
        new RepositoryStore(store).assertSingleRootAllowed(taskId);
        const task = store.tasks.getTask(taskId);
        if (!task || ["done", "canceled"].includes(task.status)) throw new Error("Choose an open task before preparing a workflow");
        if (store.database.prepare("SELECT 1 FROM task_workflow_runs WHERE task_id = ?").get(taskId)) throw new Error("A workflow has already started. Use its retained Return action rather than preparing a replacement");
        if (active.has(taskId)) await active.get(taskId);
        const draft = persistence.draft(taskId);
        if (draft.revision !== revision) throw new Error("Draft changed; save and reload the current revision before preparing");
        const selected = await validate(taskId, draft.selection);
        const existing = persistence.preparation(taskId);
        if (existing && (existing.projectId !== selected.projectId || existing.selection.hostId !== draft.selection.hostId || existing.selection.baseBranch !== draft.selection.baseBranch)) throw new Error("Workspace machine and source branch are already reserved. Restore those workspace choices; no replacement branch was created");
        if (existing && JSON.stringify(existing.selection) !== JSON.stringify(draft.selection)) {
          const uncertain = store.database.prepare("SELECT 1 FROM task_workflow_preparation_deliveries WHERE preparation_id = ? AND state = 'sending'").get(existing.id);
          if (uncertain || existing.state === "uncertain" || existing.state === "creating" || existing.threadId && !existing.environmentId) throw new Error("Reconcile the existing native preparation before changing roles; no duplicate context or branch was created");
          persistence.savePreparation({ ...existing, selection: draft.selection, state: "reserved", error: null,
            threadId: profileKey(existing.selection, "writer") === profileKey(draft.selection, "writer") ? existing.threadId : null,
            reviewerThreadId: profileKey(existing.selection, "reviewer") === profileKey(draft.selection, "reviewer") ? existing.reviewerThreadId : null });
        }
        persistence.reserve(taskId, selected.projectId, draft.selection);
        void advance(taskId);
        return persistence.preparation(taskId)!;
      });
    },
    async getTaskWorkflowPreparation({ taskId }) {
      const view = persistence.preparation(taskId);
      if (!view) return null;
      if (["reserved", "creating", "preparing", "uncertain"].includes(view.state)) return advance(taskId);
      return view;
    },
  };
  bb.rpc.register(workflowSetupContract, handlers);
  return { handlers, persistence, validate, advance };
}
