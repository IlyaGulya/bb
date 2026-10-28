import { setTimeout as delay } from "node:timers/promises";
import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import {
  buildReviewRpcContract,
  type BuildReviewStart,
} from "./remote-contract.js";
import { publishTasksChanged, type TasksApiStore } from "../api/index.js";
import { withTaskExecution } from "../delegate/execution.js";
import {
  workflowRpcContract,
  type TaskWorkflow,
} from "../shared/workflow-contract.js";
import { TaskWorkflowStore, newTaskWorkflowId } from "./store.js";
import { RepositoryStore } from "../repositories/store.js";
import { createWorkflowPreparation, requireWorkflowSelection } from "./preparation.js";
import type { workflowSetupContract } from "../shared/workflow-preparation.js";

export type TaskWorkflowHandlers = PluginRpcHandlers<
  typeof workflowRpcContract & typeof workflowSetupContract
>;
export function registerTaskWorkflows(
  bb: BbPluginApi,
  store: TasksApiStore,
  options: { background?: boolean } = {},
): TaskWorkflowHandlers {
  const workflows = new TaskWorkflowStore(store);
  const preparation = createWorkflowPreparation(bb, store);
  const pending = new Map<string, Promise<TaskWorkflow>>();
  function publish(id: string) {
    const view = workflows.get(id);
    const task = store.tasks.getTask(view.taskId);
    if (task) publishTasksChanged(bb, task.id, task.projectId);
    bb.realtime.publish("workflows:changed", { taskId: view.taskId });
    bb.realtime.publish("comments:changed", { taskId: view.taskId });
    bb.realtime.publish("threads:changed", { taskId: view.taskId });
  }
  function reconcile(id: string) {
    const current = pending.get(id);
    if (current) return current;
    const work = (async () => {
      let view = workflows.get(id);
      if (view.state === "in_review" || view.state === "failed") return view;
      if (
        view.state === "accepted" &&
        store.database
          .prepare(
            "SELECT 1 FROM task_workflow_runs WHERE id = ? AND released = 1",
          )
          .get(id)
      )
        return view;
      try {
        const request = workflows.request(id);
        if (view.state === "accepted") {
          await bb.sdk.plugins.callRpc({
            pluginId: "workflows",
            method: "releaseBuildReviewContexts",
            input: { groups: [id] },
            outputSchema:
              buildReviewRpcContract.releaseBuildReviewContexts.output,
          });
          store.database
            .prepare("UPDATE task_workflow_runs SET released = 1 WHERE id = ?")
            .run(id);
          return view;
        }
        const native =
          view.state === "launching"
            ? await bb.sdk.plugins.callRpc({
                pluginId: "workflows",
                method: "startBuildReview",
                input: request,
                outputSchema: buildReviewRpcContract.startBuildReview.output,
              })
            : await bb.sdk.plugins.callRpc({
                pluginId: "workflows",
                method: "inspectBuildReview",
                input: { key: request.key },
                outputSchema: buildReviewRpcContract.inspectBuildReview.output,
              });
        if (!native)
          throw new Error(
            "Native workflow is unavailable; its receipt is retained and no replacement was launched",
          );
        view = workflows.publish(id, native);
        for (const worker of native.workers)
          store.tasks.upsertTaskThread({
            taskId: view.taskId,
            threadId: worker.threadId,
            presetName:
              worker.role === "writer"
                ? "Workflow writer"
                : "Independent reviewer",
            title: `${worker.role} · workflow ${id}`,
            liveStatus:
              native.status === "running"
                ? "working"
                : native.status === "queued"
                  ? "starting"
                  : "completed",
          });
      } catch (error) {
        view = workflows.save({
          ...workflows.get(id),
          error: error instanceof Error ? error.message : String(error),
        });
      }
      publish(id);
      return view;
    })().finally(() => pending.delete(id));
    pending.set(id, work);
    return work;
  }
  const handlers: PluginRpcHandlers<typeof workflowRpcContract> = {
    async launchTaskWorkflow(input) {
      return withTaskExecution(input.taskId, async () => {
        new RepositoryStore(store).assertSingleRootAllowed(input.taskId);
        const existing = store.database
          .prepare<[string], { id: string; task_id: string }>("SELECT id, task_id FROM task_workflow_runs WHERE launch_key = ?")
          .get(input.preparationId);
        if (existing) {
          if (existing.task_id !== input.taskId) throw new Error("Preparation belongs to another task");
          return reconcile(existing.id);
        }
        const task = store.tasks.getTask(input.taskId);
        if (!task || ["done", "canceled"].includes(task.status)) throw new Error("Choose an open task");
        const view = preparation.persistence.preparation(input.taskId);
        if (!view || view.id !== input.preparationId) throw new Error("Prepare this task's workspace first");
        const draft = preparation.persistence.draft(input.taskId);
        const expectedSelection = JSON.stringify(draft.selection);
        if (expectedSelection !== JSON.stringify(view.selection)) throw new Error("Draft differs from prepared choices; restore the prepared choices before Start");
        const ready = await preparation.advance(input.taskId);
        if (ready.state !== "ready" || !ready.threadId || !ready.environmentId) throw new Error(ready.error ?? ready.progress);
        await preparation.validate(input.taskId, ready.selection, ready.environmentId);
        const roles = requireWorkflowSelection(ready.selection);
        const id = newTaskWorkflowId();
        const request: BuildReviewStart = {
          key: `${id}:1`, group: id, projectId: ready.projectId, originThreadId: ready.threadId,
          task: `${task.key}: ${task.title}\n\n${task.description}`,
          template: ready.selection.template, writer: roles.writer, reviewer: roles.reviewer,
          smokeCommands: ready.selection.smokeCommands, uiRequired: ready.selection.uiRequired, feedback: "",
        };
        store.transaction(() => {
          const currentDraft = preparation.persistence.draft(input.taskId);
          if (
            currentDraft.revision !== draft.revision ||
            JSON.stringify(currentDraft.selection) !== expectedSelection ||
            JSON.stringify(ready.selection) !== expectedSelection
          ) throw new Error("Draft changed during preparation or readiness; reload the saved draft and confirm the prepared choices before Start");
          workflows.create(input.preparationId, task.id, request, JSON.stringify(input));
          store.tasks.updateTask(task.id, { status: "in_progress" });
        });
        return reconcile(id);
      });
    },
    async taskWorkflows({ taskId }) {
      const rows = store.database
        .prepare<[string], { id: string }>(
          "SELECT id FROM task_workflow_runs WHERE task_id = ? ORDER BY rowid DESC",
        )
        .all(taskId);
      return { runs: await Promise.all(rows.map((row) => reconcile(row.id))) };
    },
    async acceptTaskWorkflow({ id, revision }) {
      const current = workflows.get(id);
      return withTaskExecution(current.taskId, async () => {
        if (pending.has(id)) await pending.get(id);
        const view = workflows.get(id);
        if (view.state !== "accepted") {
          const request = workflows.request(id);
          const origin = await bb.sdk.threads.get({
            threadId: request.originThreadId,
          });
          if (!origin.environmentId || !view.native?.result)
            throw new Error("Reviewed workspace/result is unavailable");
          const status = await bb.sdk.environments.status({
            environmentId: origin.environmentId,
          });
          const build = view.native.result.build;
          if (
            status.outcome !== "available" ||
            status.workspace.checkout.kind !== "branch" ||
            status.workspace.checkout.headSha !== build.commit ||
            status.workspace.checkout.branchName !== build.branch ||
            status.workspace.workingTree.hasUncommittedChanges
          )
            throw new Error(
              "Workspace changed since review; Return to the same writer instead of accepting a stale result",
            );
        }
        workflows.accept(id, revision);
        publish(id);
        return reconcile(id);
      });
    },
    async returnTaskWorkflow({ id, revision, feedback }) {
      const current = workflows.get(id);
      return withTaskExecution(current.taskId, async () => {
        if (pending.has(id)) await pending.get(id);
        let retryProfiles:
          | Pick<BuildReviewStart, "writer" | "reviewer">
          | undefined;
        const latest = workflows.get(id);
        if (
          latest.revision === revision &&
          latest.state === "failed" &&
          latest.native?.contextStarted === false
        ) {
          const draft = preparation.persistence.savedDraft(current.taskId);
          if (draft) {
            const origin = await bb.sdk.threads.get({ threadId: workflows.request(id).originThreadId });
            if (!origin.environmentId) throw new Error("Prepared workspace is unavailable");
            await preparation.validate(current.taskId, draft.selection, origin.environmentId);
            const roles = requireWorkflowSelection(draft.selection);
            retryProfiles = { writer: roles.writer, reviewer: roles.reviewer };
          }
        }
        workflows.return(id, revision, feedback, retryProfiles);
        publish(id);
        return reconcile(id);
      });
    },
  };
  bb.rpc.register(workflowRpcContract, handlers);
  if (options.background !== false)
    bb.background.service("task-workflow-results", {
      async start(signal) {
        while (!signal.aborted) {
          const rows = store.database
            .prepare<[], { id: string }>(
              "SELECT id FROM task_workflow_runs WHERE state IN ('launching', 'running') OR (state = 'accepted' AND released = 0)",
            )
            .all();
          for (const row of rows) {
            if (signal.aborted) break;
            await reconcile(row.id);
          }
          try {
            await delay(5000, undefined, { signal });
          } catch (error) {
            if (!signal.aborted) throw error;
          }
        }
      },
    });
  return { ...preparation.handlers, ...handlers };
}

export function assertTaskWorkflowStatusTransition(
  store: TasksApiStore,
  taskId: string,
  status: string | undefined,
): void {
  if (
    status === "done" &&
    store.database
      .prepare(
        "SELECT 1 FROM task_workflow_runs WHERE task_id = ? AND state <> 'accepted' LIMIT 1",
      )
      .get(taskId)
  )
    throw new Error(
      "This task has a pending workflow result. Use explicit workflow Accept for its exact revision; changing task status is not acceptance.",
    );
}

export async function releaseTaskWorkflowContexts(
  bb: BbPluginApi,
  store: TasksApiStore,
  taskIds: readonly string[],
): Promise<void> {
  const find = store.database.prepare<[string], { id: string }>(
    "SELECT id FROM task_workflow_runs WHERE task_id = ? AND released = 0",
  );
  const groups = new Set<string>();
  for (const taskId of taskIds) {
    for (const { id } of find.all(taskId)) groups.add(id);
  }
  if (groups.size === 0) return;
  await bb.sdk.plugins.callRpc({
    pluginId: "workflows",
    method: "releaseBuildReviewContexts",
    input: { groups: [...groups] },
    outputSchema: buildReviewRpcContract.releaseBuildReviewContexts.output,
  });
  store.transaction(() => {
    const release = store.database.prepare(
      "UPDATE task_workflow_runs SET released = 1 WHERE id = ?",
    );
    for (const id of groups) release.run(id);
  });
}
