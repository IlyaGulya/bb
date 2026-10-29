import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { TasksApiStore } from "../api/index.js";
import { InboxStore } from "../inbox/store.js";
import { linkTaskFromInbox, createTaskFromInbox } from "../inbox/actions.js";
import { ExecutionStore } from "../delegate/execution-store.js";
import { resolveTaskExecution, requireIdleTask, withTaskExecution } from "../delegate/execution.js";
import { validateTaskExecutionSelection } from "../delegate/selection.js";
import { TaskWorkflowStore, assertTaskWorkflowExecutionAvailable } from "../workflow/store.js";
import { WorkflowPreparationStore } from "../workflow/preparation-store.js";
import { RepositoryStore } from "../repositories/store.js";
import { isSideChatShapedThread } from "../shared/side-chat.js";
import type { ExecutionTarget } from "../shared/execution.js";
import type { Task } from "../db/index.js";
import { LOCAL_AWAY_BOUNDARY, routingRpcContract, routeJournalSchema, type RouteOutcome, type RouteProposal } from "../shared/routing.js";
import { errorMessage } from "../shared/errors.js";
import { RoutingStore, fingerprint } from "./store.js";
import { resolveRouteReferences } from "./references.js";

export type RoutingHandlers = PluginRpcHandlers<typeof routingRpcContract>;

export function registerRouting(bb: BbPluginApi, store: TasksApiStore, options: { now?: () => number } = {}): RoutingHandlers {
  const persistence = new RoutingStore(store, options.now);
  const inbox = new InboxStore(store.database);
  const executions = new ExecutionStore(store.database);
  const preparations = new WorkflowPreparationStore(store);
  const publish = (id: string) => bb.realtime.publish("inbox:changed", { id });
  function snapshot(id: string, taskId: string | null) {
    const item = inbox.get(id);
    const task = taskId ? store.tasks.getTask(taskId) ?? null : null;
    const target = task ? executions.target(task.id) : null;
    return fingerprint({ item, task,
      project: task ? store.tasks.getProject(task.projectId) ?? null : null,
      threads: task ? store.tasks.listTaskThreads(task.id) : [],
      latestAgentThreadId: task ? store.tasks.getLatestAgentComment(task.id, "")?.threadId ?? null : null,
      target,
      profile: task ? target ? store.tasks.getPreset(target.presetId) ?? null : store.tasks.firstPreset() ?? null : null,
      workflows: task ? store.database.prepare("SELECT view_json, request_json, released FROM task_workflow_runs WHERE task_id = ? ORDER BY id").all(task.id) : [],
      continuations: task ? store.database.prepare("SELECT operation_id, state, thread_id FROM task_continuations WHERE task_id = ? ORDER BY operation_id").all(task.id) : [],
      draft: task ? preparations.draft(task.id) : null,
      preparation: task ? preparations.preparation(task.id) : null,
      repositories: task ? new RepositoryStore(store).list(task.id) : [],
    });
  }
  function park(id: string, operationId: string, reason: string, proposal: RouteProposal | null) {
    const source = inbox.get(id);
    const attention = inbox.upsert({ sourceKind: "task_route", sourceKey: operationId, revision: operationId,
      title: `Routing needs you · ${source.title}`, body: `${reason}\n\n${LOCAL_AWAY_BOUNDARY}`, context: source.context,
      sourceUrl: source.sourceUrl, active: true, lane: "needs_input", reason,
      taskId: proposal?.taskId ?? source.taskId, threadId: proposal?.threadId ?? null,
    }).item;
    publish(attention.id);
  }
  for (const row of persistence.recover()) {
    const prior = persistence.journal(row.inbox_id).find(entry => entry.operationId === row.operation_id);
    if (prior) park(row.inbox_id, row.operation_id, prior.reason, persistence.proposal(row.inbox_id));
  }
  async function owner(task: Task, selectedThreadId: string | null): Promise<Pick<RouteProposal, "owner" | "ownerReason" | "threadId" | "workerThreadIds"> & { question: string | null }> {
    const attached = store.tasks.listTaskThreads(task.id);
    const workerThreadIds = attached.map(link => link.threadId);
    const managed = store.database.prepare<[string], { id: string }>("SELECT id FROM task_workflow_runs WHERE task_id = ? AND (state <> 'accepted' OR released <> 1) ORDER BY rowid DESC LIMIT 1").get(task.id);
    if (managed) {
      const workflow = new TaskWorkflowStore(store).get(managed.id);
      const workers = workflow.native?.workers ?? [];
      return { owner: "managed", question: null, ownerReason: `Retained task workflow (${workflow.state.replaceAll("_", " ")}). Open its explicit Return rather than notifying a reviewer or replacing its writer.`, threadId: workers.find(worker => worker.role === "writer")?.threadId ?? null, workerThreadIds: [...new Set([...workers.map(worker => worker.threadId), ...workerThreadIds])] };
    }
    const preparation = preparations.preparation(task.id);
    const continuation = executions.pending(task.id);
    const repositories = new RepositoryStore(store).list(task.id);
    if (preparation || continuation || repositories.length) {
      const retained = [preparation?.threadId, preparation?.reviewerThreadId, continuation?.receipt.threadId, continuation?.receipt.sourceThreadId].filter((id): id is string => !!id);
      return { owner: "prepared", question: null, ownerReason: preparation ? "Workflow preparation already owns native contexts and its workspace. Inspect that preparation and use its explicit native Start; routing never prepares a replacement or starts implementation." : continuation ? "A prepared native workspace continuation is retained. Inspect or complete that same operation; its source remains history, not a second writer." : "An explicit repository workspace checkpoint owns this task. Inspect its existing coherent continuation rather than selecting separate repository writers.", threadId: preparation?.threadId ?? continuation?.receipt.threadId ?? null, workerThreadIds: [...new Set([...retained, ...workerThreadIds])] };
    }
    try {
      const current = [];
      for (const link of attached) {
        if (executions.hasStartedSource(task.id, link.threadId)) continue;
        const thread = await bb.sdk.threads.get({ threadId: link.threadId });
        if (thread.deletedAt !== null || thread.archivedAt !== null || isSideChatShapedThread(thread)) continue;
        current.push(thread);
      }
      const running = current.filter(thread => !["idle", "error"].includes(thread.status));
      if (running.length > 1) return { owner: "unavailable", question: `Which attached executor should retain write ownership for ${task.key} once the other active threads are stopped or reconciled?`, ownerReason: "Several native threads are active. Inspect their ownership before continuing; no duplicate writer will be started.", threadId: null, workerThreadIds };
      const latestReply = store.tasks.getLatestAgentComment(task.id, "");
      const chosen = selectedThreadId ? current.find(thread => thread.id === selectedThreadId) : undefined;
      if (selectedThreadId && (!chosen || running[0] && running[0].id !== selectedThreadId)) return { owner: "unavailable", question: null, ownerReason: "The selected executor is no longer an available current attachment, is a retired continuation source, or conflicts with an active writer. Preview again; no replacement was selected.", threadId: null, workerThreadIds };
      const selected = chosen ?? running[0] ?? current.find(thread => thread.id === latestReply?.threadId) ?? (current.length === 1 ? current[0] : undefined);
      if (!selected && current.length > 1) return { owner: "unavailable", question: `Which attached native thread is the intended executor for ${task.key}, given that no current agent responder identifies its writer?`, ownerReason: "Several idle sessions are attached without an authoritative current responder. No writer was selected or replaced.", threadId: null, workerThreadIds };
      return { owner: selected ? "ordinary" : "none", question: null, ownerReason: selected ? "Continue the attached ordinary executor through its native thread controls or existing task notification. Advice never sends a message or starts another writer." : "No available attached executor. Any future launch remains an explicit native Tasks operation, not a routing fallback.", threadId: selected?.id ?? null, workerThreadIds };
    } catch {
      return { owner: "unavailable", question: null, ownerReason: "Native ownership could not be read. Inspect the attached threads; no executor is assumed absent or replaced.", threadId: null, workerThreadIds };
    }
  }
  async function validateTarget(target: ExecutionTarget, inspectCatalog: boolean) {
    const preset = store.tasks.getPreset(target.presetId);
    if (!preset) throw new Error("Selected execution profile is unavailable");
    const profileSnapshot = fingerprint(preset);
    const executionContextId = target.executionContextId ?? preset.executionContextId;
    const modelConnectionId = target.modelConnectionId ?? preset.modelConnectionId;
    if (!executionContextId || !modelConnectionId) throw new Error("Explicitly select a real execution context and model account; routing never infers a payer.");
    const summary = await validateTaskExecutionSelection(bb, { projectId: target.bbProjectId, hostId: target.hostId, provider: preset.providerId, model: preset.modelId, reasoningLevel: preset.reasoningLevel, permissionMode: preset.permissionMode, executionContextId, modelConnectionId }, inspectCatalog);
    if (target.workspace.kind === "existing-environment") {
      const environment = await bb.sdk.environments.get({ environmentId: target.workspace.environmentId });
      if (environment.projectId !== target.bbProjectId || environment.hostId !== target.hostId || environment.status !== "ready" || environment.lifecycle.phase !== "active" || environment.hostLifecycle !== "active") throw new Error("Selected workspace no longer belongs to this project/machine or is unavailable");
    }
    return { summary, presetId: preset.id, profileSnapshot };
  }
  function assertCurrent(id: string, proposal: RouteProposal, revision: number) {
    if (persistence.proposal(id)?.revision !== revision || proposal.revision !== revision || proposal.snapshot !== snapshot(id, proposal.taskId)) throw new Error("Routing advice is stale: source, task, target, draft or ownership changed. Refresh and preview again; no action was applied.");
  }
  async function attempt(input: { id: string; operationId: string; grantId: string | null }, data: object, kind: string, projectId: string | null, taskId: string | null, action: () => Promise<RouteOutcome>) {
    if (inbox.get(input.id).sourceKind === "task_route") throw new Error("This is policy attention, not new intake. Inspect its original source with route show and apply using that source ID.");
    const hash = fingerprint(data);
    const prior = persistence.prior(input.operationId, hash);
    if (prior) return prior;
    let reserved = false;
    try {
      persistence.reserve(input, hash, kind, projectId, taskId);
      reserved = true;
      const result = await action();
      const finished = persistence.finish(input.operationId, result);
      if (finished.state === "parked") park(input.id, input.operationId, finished.reason, finished.proposal);
      publish(input.id);
      return finished;
    } catch (error) {
      const result: RouteOutcome = { state: "parked", reason: errorMessage(error), proposal: persistence.proposal(input.id), item: null };
      if (reserved) persistence.finish(input.operationId, result);
      else persistence.deny(input, hash, kind, result);
      park(input.id, input.operationId, result.reason, result.proposal);
      return result;
    }
  }
  const handlers: RoutingHandlers = {
    getInboxRoute(raw) {
      const { id } = routingRpcContract.getInboxRoute.input.parse(raw);
      let source = inbox.get(id);
      if (source.sourceKind === "task_route") {
        const receipt = store.database.prepare<[string], { inbox_id: string }>("SELECT inbox_id FROM task_route_journal WHERE operation_id = ?").get(source.sourceKey);
        if (!receipt) throw new Error("The original incoming source is unavailable. This retained reminder cannot create a replacement task or executor.");
        source = inbox.get(receipt.inbox_id);
      }
      const proposal = persistence.proposal(source.id);
      return { source, proposal, stale: proposal !== null && proposal.snapshot !== snapshot(source.id, proposal.taskId), grants: persistence.grants(source.id), journal: persistence.journal(source.id).map(entry => routeJournalSchema.parse(entry)), boundary: LOCAL_AWAY_BOUNDARY };
    },
    async previewInboxRoute(raw) {
      const input = routingRpcContract.previewInboxRoute.input.parse(raw);
      const source = inbox.get(input.id);
      const initialSourceSnapshot = fingerprint(source);
      const explicitTask = input.taskRef ? store.tasks.getTask(input.taskRef) ?? store.tasks.getTaskByKey(input.taskRef) : undefined;
      const initialTask = source.taskId ? store.tasks.getTask(source.taskId) : explicitTask;
      return attempt(input, input, "preview", initialTask?.projectId ?? input.projectId, initialTask?.id ?? null, async () => {
        if (input.grantId && input.semantic) throw new Error("Semantic classification is an external completion callback and is outside local-action away. Request it explicitly without an away grant.");
        if (source.revision !== input.sourceRevision || (persistence.proposal(input.id)?.revision ?? 0) !== input.expectedRevision) throw new Error("Incoming source or routing revision changed. Refresh before previewing.");
        const projectRows = store.database.prepare<[string | null, string | null], { id: string }>("SELECT id FROM projects WHERE (? IS NULL OR id = ?) ORDER BY prefix LIMIT 20").all(input.projectId, input.projectId);
        const projects = projectRows.map(row => store.tasks.getProject(row.id)).filter(project => project !== undefined).map(project => ({ id: project.id, name: `${project.prefix} · ${project.name}` }));
        if (input.projectId && !projects.length) throw new Error("Selected tracker project is unavailable");
        const separateTask = input.newTask && !input.taskRef && !source.taskId && !source.threadId;
        const references = separateTask ? { tasks: [], threads: [], missing: [], explicitThreadId: null } : await resolveRouteReferences(bb, store, source, input.taskRef);
        const exact = new Map(references.tasks.map(task => [task.id, task]));
        const missing = references.missing;
        const directThread = references.threads[0];
        const candidates = [...exact.values()];
        if (!candidates.length) candidates.push(...store.tasks.listTasksPage({ ...(input.projectId ? { projectId: input.projectId } : {}), activeOnly: true, limit: 20 }).tasks);
        const candidateViews = candidates.map(task => ({ id: task.id, key: task.key, title: task.title.slice(0, 1000), projectId: task.projectId }));
        const candidateFingerprints = candidates.map(task => [task.id, fingerprint(task)] as const);
        const before = snapshot(input.id, exact.size === 1 ? [...exact.values()][0]!.id : null);
        let decision: RouteProposal["decision"];
        let callbackInvocations: 0 | 1 = 0;
        let classifierService: string | null = null;
        let limitation = "Exact references resolve without a classifier. Semantic advice uses at most 20 candidate tasks and projects. No commands or worker messages are sent.";
        if (separateTask) {
          if (!input.projectId) throw new Error("Explicitly choose a tracker project before proposing a new task");
          decision = { kind: "new", projectId: input.projectId, reason: "You explicitly chose a separate new task in this tracker project; incoming task/thread references are context. Creating it will not start or replace an executor." };
        } else if (exact.size + references.threads.length > 1 || missing.length) {
          decision = { kind: "clarify", reason: missing.length ? `Unresolved explicit native references: ${missing.join(", ")}.` : "The incoming context names several different native task/thread owners.", question: `Which single existing task or native thread should own this request${exact.size ? `: ${[...exact.values()].map(task => task.key).join(", ")}` : ""}, or is this separate new work in a selected project?` };
        } else if (exact.size === 1) {
          const task = [...exact.values()][0]!;
          decision = { kind: "existing", taskId: task.id, reason: `Explicit native task reference ${task.key}${source.taskId === task.id ? " is already linked to this incoming item" : " resolves directly"}; continue its existing ownership rather than making a duplicate.` };
        } else if (directThread) {
          if (input.projectId && store.tasks.getProject(input.projectId)?.linkedBbProjectId !== directThread.projectId) throw new Error("The exact native thread belongs to another code project. Choose its actual tracker project; no context or payer was switched.");
          decision = { kind: "existing-thread", threadId: directThread.id, reason: `The exact native thread ${directThread.title ?? "reference"} already exists. Open and continue that thread with its frozen binding; do not create a duplicate writer.` };
        } else if (input.semantic) {
          persistence.callback(input.operationId, "requested");
          const result = await bb.sdk.system.experimental_classifyTaskRoute({ text: `${source.title}\n\n${source.body}`.slice(0, 16000), candidates: candidateViews, projects });
          decision = result.decision;
          callbackInvocations = result.callbackInvocations;
          persistence.callback(input.operationId, result.callbackInvocations === 1 ? "invoked" : "not-invoked");
          classifierService = result.service ? `${result.service.name} · ${result.service.pluginId}/${result.service.serviceId}` : null;
          limitation = result.limitation;
        } else {
          decision = { kind: "clarify", reason: "No exact task reference was supplied; no semantic callback was invoked.", question: "Which existing task should own this request, or should a new task be created in the selected project?" };
        }
        const task = decision.kind === "existing" ? store.tasks.getTask(decision.taskId) : undefined;
        if (decision.kind === "existing" && (!task || !candidateViews.some(candidate => candidate.id === task.id))) throw new Error("Routing returned an unavailable task outside the supplied candidates");
        if (decision.kind === "existing-thread" && decision.threadId !== directThread?.id) throw new Error("Only an exact, available native thread reference may route directly");
        if (task && input.projectId && task.projectId !== input.projectId) throw new Error("The explicit task belongs to a different tracker project. Choose its actual project; no cross-project route was applied.");
        const taskId = task?.id ?? null;
        const taskSnapshot = snapshot(input.id, taskId);
        const selectedThreadId = task && references.explicitThreadId && !executions.hasStartedSource(task.id, references.explicitThreadId) ? references.explicitThreadId : null;
        const ownership = task ? await owner(task, selectedThreadId) : decision.kind === "existing-thread" && directThread ? { owner: "ordinary" as const, question: null, ownerReason: "Existing native thread binding is retained. Open native thread controls; routing does not resume it or change its context/account.", threadId: directThread.id, workerThreadIds: [directThread.id] } : { owner: "none" as const, question: null, ownerReason: "New task advice never creates an executor.", threadId: null, workerThreadIds: [] };
        if (ownership.question) decision = { kind: "clarify", question: ownership.question, reason: ownership.ownerReason };
        else if (ownership.owner === "unavailable") decision = { kind: "unavailable", reason: ownership.ownerReason };
        let target: ExecutionTarget | null = null;
        let targetSummary = "No execution target selected; configure it on the native task. No account or host was inferred.";
        let targetIssue: string | null = null;
        if (task) {
          const tracker = store.tasks.getProject(task.projectId);
          if (!tracker) throw new Error("Task project is unavailable");
          const execution = await resolveTaskExecution(bb, store.tasks, executions, task.id, tracker);
          target = execution.resolved;
          targetSummary = execution.summary;
          if (target) {
            try { targetSummary = (await validateTarget(target, false)).summary; } catch (error) { targetIssue = errorMessage(error); }
          }
        }
        return store.transaction(() => {
          if (source.revision !== inbox.get(input.id).revision || before !== snapshot(input.id, exact.size === 1 ? [...exact.values()][0]!.id : null) || taskSnapshot !== snapshot(input.id, taskId)) throw new Error("Source or task changed during preview. Refresh and preview again.");
          if (initialSourceSnapshot !== fingerprint(inbox.get(input.id)) || candidateFingerprints.some(([id, hash]) => { const current = store.tasks.getTask(id); return !current || fingerprint(current) !== hash; })) throw new Error("Incoming ownership or candidate scope changed during preview. Refresh before selecting a route.");
          if (input.grantId) persistence.assertGrant(input.grantId, input.id, "preview", task?.projectId ?? input.projectId, taskId, true);
          const proposal = persistence.saveProposal({ id: input.id, revision: input.expectedRevision + 1, sourceRevision: source.revision, snapshot: taskSnapshot, decision, candidates: candidateViews, projects, taskId, taskKey: task?.key ?? null, ...ownership, target, targetSummary, targetIssue, callbackInvocations, classifierService, limitation }, input.expectedRevision);
          return { state: decision.kind === "clarify" || decision.kind === "unavailable" || ownership.owner === "unavailable" ? "parked" : "applied", reason: decision.kind === "clarify" ? decision.question : decision.reason, proposal, item: null };
        });
      });
    },
    async applyInboxRoute(raw) {
      const input = routingRpcContract.applyInboxRoute.input.parse(raw);
      const proposal = persistence.proposal(input.id);
      const task = proposal?.taskId ? store.tasks.getTask(proposal.taskId) : undefined;
      const projectId = task?.projectId ?? (proposal?.decision.kind === "new" ? proposal.decision.projectId : null);
      return attempt(input, input, input.action.kind, projectId, task?.id ?? null, async () => {
        if (!proposal) throw new Error("Preview this incoming item before applying a route");
        assertCurrent(input.id, proposal, input.expectedRevision);
        const action = input.action;
        if ("reason" in action) throw new Error(`${LOCAL_AWAY_BOUNDARY} Requested ${action.kind} remains parked. Request context (not authority): ${action.reason}`);
        if (proposal.decision.kind === "clarify" || proposal.decision.kind === "unavailable") throw new Error("Resolve the routing question and preview again before applying");
        const selectedTask = task;
        const apply = async (): Promise<RouteOutcome> => {
          let validatedTarget: Awaited<ReturnType<typeof validateTarget>> | null = null;
          if (selectedTask) {
            const currentOwner = await owner(selectedTask, proposal.threadId);
            if (currentOwner.owner === "unavailable") throw new Error(currentOwner.ownerReason);
            if (currentOwner.owner !== proposal.owner || currentOwner.threadId !== proposal.threadId) throw new Error("Retained executor ownership changed after preview. Refresh and preview again; no action was applied.");
            if (action.kind === "target" || action.kind === "workflow-draft") {
              assertTaskWorkflowExecutionAvailable(store, selectedTask.id);
              new RepositoryStore(store).assertSingleRootAllowed(selectedTask.id);
              if (executions.pending(selectedTask.id) || preparations.preparation(selectedTask.id)) throw new Error("Task already has a prepared continuation or workflow workspace. Inspect that owner rather than changing its route.");
              await requireIdleTask(bb, store.tasks, selectedTask.id);
            }
          }
          if (action.kind === "target") {
            if (!selectedTask) throw new Error("Link an existing task before saving its execution target");
            const tracker = store.tasks.getProject(selectedTask.projectId);
            if (action.target) {
              if (tracker?.linkedBbProjectId !== action.target.bbProjectId) throw new Error("Target must use this task's linked code project");
              validatedTarget = await validateTarget(action.target, !input.grantId);
            }
          }
          if (action.kind === "workflow-draft") {
            if (!selectedTask) throw new Error("Link an existing task before saving its workflow draft");
            const tracker = store.tasks.getProject(selectedTask.projectId);
            if (!tracker?.linkedBbProjectId || !action.selection.hostId) throw new Error("Select this task's real code project and machine before saving routing choices");
            const [hosts, codeProject] = await Promise.all([bb.sdk.hosts.list(), bb.sdk.projects.get({ projectId: tracker.linkedBbProjectId })]);
            if (!hosts.some(host => host.id === action.selection.hostId) || !codeProject.sources.some(source => source.hostId === action.selection.hostId)) throw new Error("Workflow draft machine or prepared code project source is unavailable");
            for (const role of [action.selection.writer, action.selection.reviewer]) {
              if (role) await validateTaskExecutionSelection(bb, { projectId: tracker.linkedBbProjectId, hostId: action.selection.hostId, provider: role.provider, model: role.model, reasoningLevel: role.reasoningLevel, permissionMode: role.permissionMode, executionContextId: role.executionContextId, modelConnectionId: role.modelConnectionId }, !input.grantId);
            }
          }
          if (proposal.decision.kind === "existing-thread") {
            if (input.grantId) throw new Error("Unbound native thread links are outside this task-scoped local-away grant. Open the exact thread or link it explicitly without an away grant.");
            const thread = await bb.sdk.threads.get({ threadId: proposal.decision.threadId });
            if (thread.deletedAt !== null || thread.archivedAt !== null) throw new Error("The exact native thread is no longer available; no replacement was created");
          }
          return store.transaction(() => {
            assertCurrent(input.id, proposal, input.expectedRevision);
            if (validatedTarget) {
              const currentProfile = store.tasks.getPreset(validatedTarget.presetId);
              if (!currentProfile || fingerprint(currentProfile) !== validatedTarget.profileSnapshot) throw new Error("The selected execution profile changed during validation. Preview and validate its current model/account binding before saving; no target was changed.");
            }
            if (input.grantId) persistence.assertGrant(input.grantId, input.id, action.kind, projectId, selectedTask?.id ?? null, true);
            let item = inbox.get(input.id);
            if (action.kind === "link") {
              if (proposal.decision.kind === "existing-thread") item = inbox.linkThread(input.id, proposal.decision.threadId);
              else {
                if (proposal.decision.kind !== "existing" || !selectedTask) throw new Error("This proposal does not select an existing native task/thread");
                item = linkTaskFromInbox(bb, store, inbox, input.id, selectedTask.id).item;
              }
            } else if (action.kind === "create") {
              if (proposal.decision.kind !== "new") throw new Error("This proposal does not select a new task");
              item = createTaskFromInbox(bb, store, inbox, input.id, proposal.decision.projectId).item;
            } else if (action.kind === "target" && selectedTask) {
              executions.setTarget(selectedTask.id, action.target);
              bb.realtime.publish("tasks:changed", { taskId: selectedTask.id, projectId: selectedTask.projectId });
            } else if (action.kind === "workflow-draft" && selectedTask) {
              preparations.saveDraft(selectedTask.id, action.draftRevision, action.selection);
              bb.realtime.publish("workflows:changed", { taskId: selectedTask.id });
            }
            const outcome: RouteOutcome = { state: "applied", reason: "Local routing action saved. No thread send, worker launch, workspace preparation or external action occurred.", proposal, item };
            persistence.finish(input.operationId, outcome);
            inbox.record(inbox.get(input.id), `route:${action.kind}:${input.operationId}`);
            return outcome;
          });
        };
        return selectedTask ? withTaskExecution(selectedTask.id, apply) : apply();
      });
    },
    enableLocalAway(raw) {
      const input = routingRpcContract.enableLocalAway.input.parse(raw);
      if (!store.tasks.getProject(input.projectId)) throw new Error("Tracker project is unavailable");
      for (const id of input.inboxIds) if (inbox.get(id).sourceKind === "task_route") throw new Error("Grant the original incoming source, not its policy reminder");
      for (const taskId of input.taskIds) if (store.tasks.getTask(taskId)?.projectId !== input.projectId) throw new Error("Every granted task must belong to the explicitly selected project");
      const { grant, created } = persistence.enable({ operationId: input.operationId, projectId: input.projectId, inboxIds: input.inboxIds, taskIds: input.taskIds, actions: [...new Set(input.actions)], durationSeconds: input.durationSeconds, maxAttempts: input.maxAttempts });
      if (created) for (const id of input.inboxIds) { inbox.record(inbox.get(id), `local_away_enabled:${grant.id}`); publish(id); }
      return grant;
    },
    revokeLocalAway(raw) {
      const { id } = routingRpcContract.revokeLocalAway.input.parse(raw);
      const previous = persistence.grant(id);
      const grant = persistence.revoke(id);
      if (previous.revokedAt === null) for (const inboxId of grant.inboxIds) {
        if (store.database.prepare("SELECT 1 FROM inbox_entries WHERE id = ?").get(inboxId)) { inbox.record(inbox.get(inboxId), `local_away_revoked:${id}`); publish(inboxId); }
      }
      return grant;
    },
  };
  bb.rpc.register(routingRpcContract, handlers);
  return handlers;
}
