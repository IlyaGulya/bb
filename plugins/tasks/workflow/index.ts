import { setTimeout as delay } from "node:timers/promises";
import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import {
  buildReviewRpcContract,
  type BuildReviewStart,
} from "./remote-contract.js";
import { publishTasksChanged, type TasksApiStore } from "../api/index.js";
import {
  validateProfileAvailability,
  withTaskExecution,
  requireIdleTask,
  environmentThreads,
} from "../delegate/execution.js";
import {
  workflowRpcContract,
  taskWorkflowLaunchSchema,
  type TaskWorkflow,
} from "../shared/workflow-contract.js";
import { TaskWorkflowStore, newTaskWorkflowId } from "./store.js";
import { RepositoryStore } from "../repositories/store.js";

export type TaskWorkflowHandlers = PluginRpcHandlers<
  typeof workflowRpcContract
>;
export function registerTaskWorkflows(
  bb: BbPluginApi,
  store: TasksApiStore,
  options: { background?: boolean } = {},
): TaskWorkflowHandlers {
  const workflows = new TaskWorkflowStore(store);
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
  const handlers: TaskWorkflowHandlers = {
    async launchTaskWorkflow(input) {
      return withTaskExecution(input.taskId, async () => {
        new RepositoryStore(store).assertSingleRootAllowed(input.taskId);
        const existing = store.database
          .prepare<[string], { id: string; launch_json: string }>(
            "SELECT id, launch_json FROM task_workflow_runs WHERE launch_key = ?",
          )
          .get(input.launchKey);
        if (existing) {
          if (existing.launch_json !== JSON.stringify(input))
            throw new Error("Launch key already has different input");
          return reconcile(existing.id);
        }
        const task = store.tasks.getTask(input.taskId);
        if (!task || ["done", "canceled"].includes(task.status))
          throw new Error("Choose an open task");
        const project = store.tasks.getProject(task.projectId);
        const writer = store.tasks.getPreset(input.writerPresetId);
        const reviewer = store.tasks.getPreset(input.reviewerPresetId);
        if (!writer || !reviewer)
          throw new Error("Choose two existing allowed execution profiles");
        if (
          writer.providerId === reviewer.providerId &&
          writer.modelId === reviewer.modelId
        )
          throw new Error(
            "Independent review requires another runtime/provider or model",
          );
        const origin = await bb.sdk.threads.get({
          threadId: input.originThreadId,
        });
        if (
          origin.archivedAt != null ||
          origin.deletedAt != null ||
          origin.status !== "idle" ||
          !origin.environmentId
        )
          throw new Error(
            "Choose an idle live origin thread with a prepared single-root workspace",
          );
        const environment = await bb.sdk.environments.get({
          environmentId: origin.environmentId,
        });
        if (
          !project?.linkedBbProjectId ||
          environment.projectId !== project.linkedBbProjectId
        )
          throw new Error(
            "Origin workspace must belong to the task's linked BB code project",
          );
        if (
          environment.status !== "ready" ||
          environment.lifecycle.phase !== "active" ||
          environment.hostLifecycle !== "active"
        )
          throw new Error("Origin workspace is not ready");
        await requireIdleTask(bb, store.tasks, task.id);
        if (
          (await environmentThreads(bb, environment.id)).some(
            (thread) => !["idle", "error"].includes(thread.status),
          )
        )
          throw new Error(
            "Workspace already has active work; one-writer workflow requires an idle workspace",
          );
        const baseline = await bb.sdk.environments.status({
          environmentId: environment.id,
        });
        if (
          baseline.outcome !== "available" ||
          baseline.workspace.workingTree.hasUncommittedChanges ||
          baseline.workspace.checkout.kind !== "branch"
        )
          throw new Error(
            "Start from a clean committed branch so unrelated source changes are preserved",
          );
        await validateProfileAvailability(
          bb,
          writer,
          environment.hostId,
          environment.id,
        );
        await validateProfileAvailability(
          bb,
          reviewer,
          environment.hostId,
          environment.id,
        );
        const id = newTaskWorkflowId();
        const request: BuildReviewStart = {
          key: `${id}:1`,
          group: id,
          projectId: environment.projectId,
          originThreadId: origin.id,
          task: `${task.key}: ${task.title}\n\n${task.description}`,
          writer: {
            provider: writer.providerId,
            model: writer.modelId,
            reasoningLevel: writer.reasoningLevel,
            permissionMode: writer.permissionMode,
            serviceTier: writer.serviceTier,
            instructions: writer.instructions,
          },
          reviewer: {
            provider: reviewer.providerId,
            model: reviewer.modelId,
            reasoningLevel: reviewer.reasoningLevel,
            permissionMode: reviewer.permissionMode,
            serviceTier: reviewer.serviceTier,
            instructions: reviewer.instructions,
          },
          smokeCommands: input.smokeCommands,
          uiRequired: input.uiRequired,
          feedback: "",
        };
        store.transaction(() => {
          workflows.create(
            input.launchKey,
            task.id,
            request,
            JSON.stringify(input),
          );
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
          const row = store.database
            .prepare<[string], { launch_json: string }>(
              "SELECT launch_json FROM task_workflow_runs WHERE id = ?",
            )
            .get(id);
          if (!row) throw new Error("Unknown task workflow");
          const launch = taskWorkflowLaunchSchema.parse(
            JSON.parse(row.launch_json),
          );
          const writer = store.tasks.getPreset(launch.writerPresetId);
          const reviewer = store.tasks.getPreset(launch.reviewerPresetId);
          if (!writer || !reviewer)
            throw new Error(
              "Restore the selected execution profiles before retrying the first writer launch",
            );
          if (
            writer.providerId === reviewer.providerId &&
            writer.modelId === reviewer.modelId
          )
            throw new Error(
              "Independent review requires another runtime/provider or model",
            );
          retryProfiles = {
            writer: {
              provider: writer.providerId,
              model: writer.modelId,
              reasoningLevel: writer.reasoningLevel,
              permissionMode: writer.permissionMode,
              serviceTier: writer.serviceTier,
              instructions: writer.instructions,
            },
            reviewer: {
              provider: reviewer.providerId,
              model: reviewer.modelId,
              reasoningLevel: reviewer.reasoningLevel,
              permissionMode: reviewer.permissionMode,
              serviceTier: reviewer.serviceTier,
              instructions: reviewer.instructions,
            },
          };
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
  return handlers;
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
