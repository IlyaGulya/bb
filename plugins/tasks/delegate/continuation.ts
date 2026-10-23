import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { TasksApiStore } from "../api";
import type { Preset, Task, TaskThreadLiveStatus } from "../db";
import { errorMessage } from "../shared/errors";
import { delegationRpcContract } from "./contract";
import { ExecutionStore, type StoredContinuation } from "./execution-store";
import {
  environmentThreads,
  requireIdleTask,
  targetSpawnEnvironment,
  validateProfileAvailability,
  validateTargetHost,
  withTaskExecution,
} from "./execution";

interface ContinuationEffects {
  prompt(task: Task, preset: Preset, extraInstructions?: string): string;
  title(task: Task): string;
  readLiveStatus(threadId: string): Promise<TaskThreadLiveStatus>;
  comment(input: {
    taskId: string;
    presetName: string;
    threadId: string;
    body: string;
  }): void;
  publish(task: Task): void;
}

async function sourceEnvironment(
  bb: BbPluginApi,
  store: TasksApiStore,
  executions: ExecutionStore,
  taskId: string,
  threadId: string,
) {
  if (!store.tasks.getTask(taskId))
    throw new Error(`Task not found: ${taskId}`);
  if (!store.tasks.getTaskThreadByThreadId(taskId, threadId))
    throw new Error("Source thread is not attached to this task");
  if (executions.hasStartedSource(taskId, threadId)) {
    throw new Error(
      "This source session has already been continued. Use its new attached executor thread; the source remains available for inspection.",
    );
  }
  const thread = await bb.sdk.threads.get({ threadId });
  if (thread.deletedAt != null || thread.status !== "idle")
    throw new Error(
      "Source thread must be idle and not deleted before continuing",
    );
  if (!thread.environmentId)
    throw new Error("Source thread has no current workspace");
  const environment = await bb.sdk.environments.get({
    environmentId: thread.environmentId,
  });
  if (
    environment.projectId !== thread.projectId ||
    environment.status !== "ready" ||
    environment.lifecycle.phase !== "active" ||
    environment.hostLifecycle !== "active"
  ) {
    throw new Error(
      "Source thread's current workspace is not ready and active in its code project",
    );
  }
  await requireIdleTask(bb, store.tasks, taskId);
  return environment;
}

export function continuationHandlers(
  bb: BbPluginApi,
  store: TasksApiStore,
  executions: ExecutionStore,
  effects: ContinuationEffects,
): Pick<
  PluginRpcHandlers<typeof delegationRpcContract>,
  "previewTaskContinuation" | "continueTask" | "getTaskContinuations"
> {
  const attach = async (
    task: Task,
    preset: Preset,
    continuation: StoredContinuation,
    threadId: string,
  ) => {
    let liveStatus: TaskThreadLiveStatus = "starting";
    try {
      liveStatus = await effects.readLiveStatus(threadId);
    } catch (error) {
      bb.log.warn(
        `Could not read continued thread ${threadId} after spawn: ${errorMessage(error)}`,
      );
    }
    store.transaction(() => {
      store.tasks.upsertTaskThread({
        taskId: task.id,
        threadId,
        presetName: preset.name,
        title: effects.title(task),
        liveStatus,
      });
      executions.state(
        continuation.receipt.operationId,
        "started",
        threadId,
        null,
      );
      executions.setTarget(task.id, {
        bbProjectId: continuation.receipt.bbProjectId,
        hostId: continuation.receipt.targetHostId,
        workspace: {
          kind: "existing-environment",
          environmentId: continuation.receipt.environmentId,
        },
        presetId: preset.id,
      });
      effects.comment({
        taskId: task.id,
        presetName: preset.name,
        threadId,
        body: `Continued in new native session ${threadId} on ${continuation.receipt.targetHostId}. Source ${continuation.receipt.sourceThreadId} retained. Verified workspace transfer ${continuation.receipt.operationId}; workspace ${continuation.receipt.environmentId}.`,
      });
    });
    effects.publish(task);
    return {
      threadId,
      operationId: continuation.receipt.operationId,
      environmentId: continuation.receipt.environmentId,
    };
  };
  const recoverSpawn = async (continuation: StoredContinuation) => {
    const threads = await environmentThreads(
      bb,
      continuation.receipt.environmentId,
    );
    for (const thread of threads) {
      const metadata = await bb.sdk.threads.getPluginMetadata({
        threadId: thread.id,
      });
      if (
        metadata.continuationOperationId === continuation.receipt.operationId &&
        metadata.taskId === continuation.receipt.taskId
      )
        return thread.id;
    }
    return null;
  };
  return {
    async getTaskContinuations({ taskId }) {
      if (!store.tasks.getTask(taskId))
        throw new Error(`Task not found: ${taskId}`);
      return {
        continuations: executions.list(taskId).map((entry) => entry.receipt),
      };
    },
    async previewTaskContinuation(input) {
      return withTaskExecution(input.taskId, async () => {
        const environment = await sourceEnvironment(
          bb,
          store,
          executions,
          input.taskId,
          input.sourceThreadId,
        );
        await validateTargetHost(bb, input.targetHostId);
        if (environment.hostId === input.targetHostId)
          throw new Error("Choose another machine for continuation");
        const preview = await bb.sdk.projects.previewWorkspaceTransfer({
          projectId: environment.projectId,
          sourceEnvironmentId: environment.id,
          targetHostId: input.targetHostId,
        });
        return {
          projectId: environment.projectId,
          sourceEnvironmentId: preview.sourceEnvironmentId,
          sourceHostId: preview.sourceHostId,
          head: preview.head,
          branch: preview.branch,
          activeThreadIds: preview.activeThreadIds,
          files: preview.files.map((file) => ({
            path: file.path,
            kind: file.kind,
            tracked: file.tracked,
            selectedByDefault: file.selectedByDefault,
            ...(file.excludedReason === undefined
              ? {}
              : { excludedReason: file.excludedReason }),
          })),
        };
      });
    },
    async continueTask(input) {
      return withTaskExecution(input.taskId, async () => {
        const task = store.tasks.getTask(input.taskId);
        if (!task) throw new Error(`Task not found: ${input.taskId}`);
        const preset = store.tasks.getPreset(input.presetId);
        if (!preset) throw new Error(`Profile not found: ${input.presetId}`);
        let continuation = input.operationId
          ? executions.get(input.operationId)
          : executions.pending(task.id);
        if (input.operationId && !continuation)
          throw new Error(
            "Continuation operation is not attached to this task",
          );
        if (continuation) {
          const receipt = continuation.receipt;
          if (
            receipt.taskId !== task.id ||
            receipt.sourceThreadId !== input.sourceThreadId ||
            receipt.targetHostId !== input.targetHostId ||
            receipt.targetPath !== input.targetPath ||
            receipt.presetId !== input.presetId
          ) {
            throw new Error(
              "Continuation operation belongs to a different task, source, target, or profile. Retry with its original inputs.",
            );
          }
          if (receipt.state === "started" && receipt.threadId)
            return {
              threadId: receipt.threadId,
              operationId: receipt.operationId,
              environmentId: receipt.environmentId,
            };
          if (
            !input.operationId &&
            (JSON.stringify([...continuation.request.includePaths].sort()) !==
              JSON.stringify([...new Set(input.includePaths)].sort()) ||
              continuation.request.branch !== input.branch)
          ) {
            throw new Error(
              "A ready transfer must be retried with its original selected files and branch",
            );
          }
          if (receipt.state === "spawning") {
            const recovered = await recoverSpawn(continuation);
            if (recovered) return attach(task, preset, continuation, recovered);
            executions.state(
              receipt.operationId,
              "ready",
              null,
              receipt.lastError,
            );
          }
        }
        const source = await sourceEnvironment(
          bb,
          store,
          executions,
          task.id,
          input.sourceThreadId,
        );
        await validateTargetHost(bb, input.targetHostId);
        if (source.hostId === input.targetHostId)
          throw new Error("Choose another machine for continuation");
        await validateProfileAvailability(bb, preset, input.targetHostId);
        if (!continuation) {
          const preview = await bb.sdk.projects.previewWorkspaceTransfer({
            projectId: source.projectId,
            sourceEnvironmentId: source.id,
            targetHostId: input.targetHostId,
          });
          if (preview.activeThreadIds.length)
            throw new Error(
              "Source workspace has running or pending agent work",
            );
          const selected = [...new Set(input.includePaths)];
          for (const path of selected) {
            const file = preview.files.find(
              (candidate) => candidate.path === path,
            );
            const ignoredDescendant =
              !file &&
              preview.files.some(
                (candidate) =>
                  candidate.kind === "ignored" &&
                  !candidate.tracked &&
                  path.startsWith(`${candidate.path}/`),
              );
            if (
              (!file && !ignoredDescendant) ||
              (file?.tracked && file.kind !== "sensitive-tracked")
            )
              throw new Error(
                `Additional file is unavailable or unsafe to transfer: ${path}`,
              );
          }
          for (const file of preview.files) {
            if (
              file.tracked &&
              !file.selectedByDefault &&
              !selected.includes(file.path)
            ) {
              throw new Error(
                `Tracked file requires explicit consent before transfer: ${file.path}. ${file.excludedReason ?? ""}`,
              );
            }
          }
          const transfer = await bb.sdk.projects
            .transferWorkspace({
              projectId: source.projectId,
              sourceEnvironmentId: source.id,
              targetHostId: input.targetHostId,
              targetPath: input.targetPath,
              includePaths: selected,
              ...(input.branch ? { branch: input.branch } : {}),
            })
            .catch((error: unknown) => {
              const details = z
                .object({ details: z.object({ operationId: z.string() }) })
                .safeParse(
                  error instanceof Error && "body" in error ? error.body : null,
                );
              effects.comment({
                taskId: task.id,
                presetName: preset.name,
                threadId: input.sourceThreadId,
                body: `Workspace transfer${details.success ? ` ${details.data.details.operationId}` : ""} failed: ${errorMessage(error)}. Source retained; target native session was not started.`,
              });
              effects.publish(task);
              throw error;
            });
          if (transfer.status !== "ready")
            throw new Error(
              "Workspace transfer is not ready; target agent was not started",
            );
          if (
            transfer.projectId !== source.projectId ||
            transfer.sourceEnvironmentId !== source.id ||
            transfer.hostId !== input.targetHostId ||
            transfer.rootPath !== input.targetPath
          ) {
            throw new Error(
              "Verified transfer does not match the requested source and target",
            );
          }
          continuation = {
            receipt: {
              operationId: transfer.operationId,
              taskId: task.id,
              sourceThreadId: input.sourceThreadId,
              bbProjectId: source.projectId,
              sourceEnvironmentId: source.id,
              targetHostId: input.targetHostId,
              targetPath: input.targetPath,
              presetId: preset.id,
              environmentId: transfer.environmentId,
              state: "ready",
              threadId: null,
              lastError: null,
              createdAt: new Date().toISOString(),
            },
            request: {
              includePaths: selected,
              ...(input.branch ? { branch: input.branch } : {}),
              ...(input.extraInstructions === undefined
                ? {}
                : { extraInstructions: input.extraInstructions }),
            },
            handoff: transfer.handoff,
          };
          const prepared = continuation;
          store.transaction(() => {
            executions.create(prepared);
            effects.comment({
              taskId: task.id,
              presetName: preset.name,
              threadId: input.sourceThreadId,
              body: `Workspace transfer ${transfer.operationId} ready on ${input.targetHostId} at ${transfer.rootPath}. Source session retained; target native session has not started yet.`,
            });
          });
          effects.publish(task);
        } else {
          if (
            source.id !== continuation.receipt.sourceEnvironmentId ||
            source.projectId !== continuation.receipt.bbProjectId
          )
            throw new Error(
              "Source thread's current workspace changed after transfer",
            );
          const transfer = await bb.sdk.projects.getWorkspaceTransfer({
            operationId: continuation.receipt.operationId,
          });
          if (
            transfer.status !== "ready" ||
            transfer.environmentId !== continuation.receipt.environmentId ||
            transfer.hostId !== input.targetHostId ||
            transfer.projectId !== source.projectId
          ) {
            throw new Error(
              "Stored workspace transfer is not ready or no longer matches this continuation",
            );
          }
        }
        const ready = continuation;
        let spawning = false;
        try {
          await sourceEnvironment(
            bb,
            store,
            executions,
            task.id,
            input.sourceThreadId,
          );
          const environment = await targetSpawnEnvironment(
            bb,
            {
              bbProjectId: ready.receipt.bbProjectId,
              hostId: ready.receipt.targetHostId,
              workspace: {
                kind: "existing-environment",
                environmentId: ready.receipt.environmentId,
              },
              presetId: preset.id,
            },
            preset,
          );
          const prompt =
            effects.prompt(
              task,
              preset,
              input.extraInstructions ?? ready.request.extraInstructions,
            ) +
            `\n## Verified workspace continuation\n\nTransfer operation: ${ready.receipt.operationId}\nSource session: ${input.sourceThreadId} (retained; this is a NEW native session, not a live process resume).\n\n${ready.handoff}\n`;
          executions.state(ready.receipt.operationId, "spawning", null, null);
          spawning = true;
          const thread = await bb.sdk.threads.spawn({
            projectId: ready.receipt.bbProjectId,
            environment,
            transferOperationId: ready.receipt.operationId,
            providerId: preset.providerId,
            model: preset.modelId,
            reasoningLevel: preset.reasoningLevel,
            ...(preset.serviceTier === null
              ? {}
              : { serviceTier: preset.serviceTier }),
            permissionMode: preset.permissionMode,
            title: effects.title(task),
            prompt,
            pluginMetadata: {
              continuationOperationId: ready.receipt.operationId,
              taskId: task.id,
              sourceThreadId: input.sourceThreadId,
            },
          });
          return attach(task, preset, ready, thread.id);
        } catch (error) {
          let state: "ready" | "spawning" = "ready";
          if (spawning) {
            try {
              const recovered = await recoverSpawn(ready);
              if (recovered) return attach(task, preset, ready, recovered);
            } catch {
              state = "spawning";
            }
          }
          executions.state(
            ready.receipt.operationId,
            state,
            null,
            errorMessage(error),
          );
          effects.comment({
            taskId: task.id,
            presetName: preset.name,
            threadId: input.sourceThreadId,
            body: `Continuation ${ready.receipt.operationId} did not complete: ${errorMessage(error)}. Verified target workspace retained. Retry this operation; do not transfer onto its prepared path again.`,
          });
          effects.publish(task);
          throw new Error(
            `Continuation ${ready.receipt.operationId}: ${errorMessage(error)}. Verified workspace retained; retry with operationId ${ready.receipt.operationId}.`,
          );
        }
      });
    },
  };
}
