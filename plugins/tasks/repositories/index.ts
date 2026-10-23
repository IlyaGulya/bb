import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { TasksApiStore } from "../api";
import type { Preset, Task } from "../db";
import {
  environmentThreads,
  requireIdleTask,
  targetSpawnEnvironment,
  validateProfileAvailability,
  withTaskExecution,
} from "../delegate/execution";
import { errorMessage } from "../shared/errors";
import {
  repositoryBindingsSchema,
  repositoryRpcContract,
  type RepositoryBinding,
  type RepositoryCheckpoint,
  type RepositoryReceipt,
} from "../shared/repositories";
import { RepositoryStore } from "./store";

export interface RepositoryEffects {
  prompt(task: Task, preset: Preset, instructions?: string): string;
  title(task: Task): string;
  publish(task: Task): void;
}
export type RepositoryHandlers = PluginRpcHandlers<
  typeof repositoryRpcContract
>;
const transferFailureSchema = z.object({
  body: z.object({
    code: z.literal("workspace_transfer_failed"),
    details: z.object({ operationId: z.string().min(1) }),
  }),
});
export function repositoryHandlers(
  bb: BbPluginApi,
  store: TasksApiStore,
  effects: RepositoryEffects,
): RepositoryHandlers {
  const checkpoints = new RepositoryStore(store);
  const requireTask = (id: string) => {
    const task = store.tasks.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    return task;
  };
  const profile = (id: string) => {
    const preset = store.tasks.getPreset(id);
    if (!preset) throw new Error(`Profile not found: ${id}`);
    return preset;
  };
  const inspectSource = async (
    binding: RepositoryBinding,
    signal?: AbortSignal,
  ) => {
    const source = await bb.sdk.environments.get({
      environmentId: binding.sourceEnvironmentId,
      ...(signal ? { signal } : {}),
    });
    if (
      source.projectId !== binding.bbProjectId ||
      source.hostId !== binding.sourceHostId ||
      source.path !== binding.sourcePath ||
      source.status !== "ready" ||
      source.lifecycle.phase !== "active" ||
      source.hostLifecycle !== "active"
    )
      throw new Error(
        "Source environment no longer matches the explicit repository binding",
      );
    const preview = await bb.sdk.projects.previewWorkspaceTransfer({
      projectId: binding.bbProjectId,
      sourceEnvironmentId: source.id,
      targetHostId: binding.targetHostId,
      timeoutMs: 20 * 60 * 1000,
      ...(signal ? { signal } : {}),
    });
    if (
      preview.head !== binding.sourceHead ||
      preview.branch !== binding.sourceBranch
    )
      throw new Error(
        "Source HEAD or branch changed; review the binding before preparing",
      );
    if (preview.activeThreadIds.length)
      throw new Error(
        `Stop source writers before preparing: ${preview.activeThreadIds.join(", ")}`,
      );
    for (const file of preview.files) {
      if (
        file.kind === "untracked" &&
        !file.excludedReason?.startsWith("Sensitive") &&
        !binding.includePaths.includes(file.path)
      )
        throw new Error(
          `Dirty checkpoint would omit ${file.path}; explicitly select every portable dirty file`,
        );
      if (file.excludedReason?.startsWith("Sensitive")) {
        if (
          file.tracked &&
          (!binding.remoteBase || !binding.includePaths.includes(file.path))
        )
          throw new Error(
            `Flagged tracked source context requires explicit source-owner selection and a published base: ${file.path}`,
          );
        if (!file.tracked && binding.includePaths.includes(file.path))
          throw new Error(
            `Untracked credentials/session material cannot be copied: ${file.path}`,
          );
      }
    }
    for (const name of binding.instructionPaths) {
      const file = preview.files.find((candidate) => candidate.path === name);
      if (
        !file ||
        (file.excludedReason?.startsWith("Sensitive") &&
          !(
            file.tracked &&
            binding.remoteBase &&
            binding.includePaths.includes(name)
          )) ||
        (!file.tracked && !binding.includePaths.includes(name))
      )
        throw new Error(
          `Required instruction/configuration file is unavailable or unselected: ${name}`,
        );
    }
    await validateProfileAvailability(
      bb,
      profile(binding.presetId),
      binding.targetHostId,
    );
  };
  const inspectTarget = async (
    root: RepositoryReceipt,
    signal?: AbortSignal,
  ) => {
    if (
      !root.environmentId ||
      !root.transferOperationId ||
      root.head !== root.binding.sourceHead
    )
      throw new Error("Repository has no verified checkpoint");
    const result = await bb.sdk.projects.getWorkspaceTransfer({
      operationId: root.transferOperationId,
    });
    if (
      result.status !== "ready" ||
      result.environmentId !== root.environmentId ||
      result.head !== root.binding.sourceHead ||
      result.branch !== root.binding.branch ||
      result.rootPath !== root.binding.targetPath ||
      result.hostId !== root.binding.targetHostId
    )
      throw new Error(
        "Repository transfer receipt no longer matches its binding",
      );
    const environment = await bb.sdk.environments.get({
      environmentId: root.environmentId,
    });
    if (
      environment.path !== root.binding.targetPath ||
      environment.projectId !== root.binding.bbProjectId ||
      environment.hostId !== root.binding.targetHostId ||
      environment.status !== "ready" ||
      environment.lifecycle.phase !== "active" ||
      environment.hostLifecycle !== "active"
    )
      throw new Error("Prepared repository is no longer ready");
    const preview = await bb.sdk.projects.previewWorkspaceTransfer({
      projectId: root.binding.bbProjectId,
      sourceEnvironmentId: root.environmentId,
      targetHostId: root.binding.targetHostId,
      timeoutMs: 20 * 60 * 1000,
      ...(signal ? { signal } : {}),
    });
    if (preview.head !== root.head || preview.branch !== root.binding.branch)
      throw new Error(
        "Prepared repository HEAD or branch changed before continuation",
      );
    for (const name of root.binding.instructionPaths)
      if (
        !preview.files.some(
          (file) =>
            file.path === name &&
            (!file.excludedReason?.startsWith("Sensitive") ||
              (file.tracked &&
                root.binding.remoteBase &&
                root.binding.includePaths.includes(name))),
        )
      )
        throw new Error(
          `Required target instructions/configuration unavailable: ${name}`,
        );
    await validateProfileAvailability(
      bb,
      profile(root.binding.presetId),
      root.binding.targetHostId,
      environment.id,
    );
  };
  let wakePreparation: (() => void) | undefined;
  const reconciling = new Map<string, Promise<void>>();
  const reconcileInterrupted = async (checkpoint: RepositoryCheckpoint) => {
    if (checkpoint.state === "preparing") return;
    let changed = false;
    for (const root of checkpoint.roots) {
      if (root.state !== "interrupted" || !root.transferOperationId) continue;
      try {
        const result = await bb.sdk.projects.getWorkspaceTransfer({
          operationId: root.transferOperationId,
        });
        if (result.status === "ready") {
          root.environmentId = result.environmentId;
          root.head = result.head;
          root.handoff = result.handoff;
          if (
            result.projectId !== root.binding.bbProjectId ||
            result.sourceEnvironmentId !== root.binding.sourceEnvironmentId ||
            result.head !== root.binding.sourceHead ||
            result.branch !== root.binding.branch ||
            result.rootPath !== root.binding.targetPath ||
            result.hostId !== root.binding.targetHostId
          )
            throw new Error(
              "Recovered native receipt does not match the agreed binding",
            );
          const environment = await bb.sdk.environments.get({
            environmentId: result.environmentId,
          });
          if (
            environment.status !== "ready" ||
            environment.lifecycle.phase !== "active" ||
            environment.path !== root.binding.targetPath ||
            environment.hostId !== root.binding.targetHostId
          )
            throw new Error("Recovered target is not available");
          root.state = "ready";
          root.error = null;
        } else {
          root.state =
            result.status === "failed" || result.status === "interrupted"
              ? "failed"
              : "interrupted";
          root.error =
            result.error ??
            `Native transfer is ${result.status}; inspect this operation before choosing a fresh retry path. No transfer was replayed.`;
        }
      } catch (error) {
        root.error = `Preparation outcome requires inspection: ${errorMessage(error)}. No transfer was replayed.`;
      }
      changed = true;
    }
    if (changed) {
      checkpoint.state = checkpoint.roots.every(
        (root) => root.state === "ready",
      )
        ? "ready"
        : "partial";
      checkpoints.save(checkpoint);
      effects.publish(requireTask(checkpoint.taskId));
    }
  };
  bb.background.service("repository-preparation", {
    async start(signal) {
      let active: RepositoryCheckpoint | null = null;
      const interrupt = () => {
        wakePreparation?.();
        if (!active) return;
        for (const root of active.roots)
          if (root.state === "preparing") {
            root.state = "interrupted";
            root.error =
              "Plugin preparation stopped while an operation may still be running. Inspect its native transfer ID and target; no automatic replay is permitted.";
          }
        active.state = active.roots.every((root) => root.state === "ready")
          ? "ready"
          : "partial";
        checkpoints.save(active);
        effects.publish(requireTask(active.taskId));
      };
      signal.addEventListener("abort", interrupt, { once: true });
      try {
        for (const checkpoint of checkpoints.preparing()) {
          if (!checkpoint.roots.some((root) => root.state === "preparing"))
            continue;
          for (const root of checkpoint.roots)
            if (root.state === "preparing") {
              root.state = "interrupted";
              root.error =
                "Preparation was interrupted before a verified response; inspect the native operation and target before retrying.";
            }
          checkpoint.state = "partial";
          checkpoints.save(checkpoint);
          effects.publish(requireTask(checkpoint.taskId));
        }
        while (!signal.aborted) {
          const checkpoint = checkpoints.preparing()[0];
          if (!checkpoint) {
            await new Promise<void>((resolve) => {
              wakePreparation = resolve;
              if (signal.aborted) resolve();
            });
            wakePreparation = undefined;
            continue;
          }
          active = checkpoint;
          const task = requireTask(checkpoint.taskId);
          for (const root of checkpoint.roots) {
            if (signal.aborted) return;
            if (root.state !== "pending") continue;
            root.state = "preparing";
            checkpoints.save(checkpoint);
            effects.publish(task);
            try {
              await requireIdleTask(bb, store.tasks, task.id);
              await inspectSource(root.binding, signal);
              if (signal.aborted) return;
              root.transferOperationId = `wtx_${randomUUID()}`;
              checkpoints.save(checkpoint);
              effects.publish(task);
              const result = await bb.sdk.projects.transferWorkspace({
                projectId: root.binding.bbProjectId,
                sourceEnvironmentId: root.binding.sourceEnvironmentId,
                targetHostId: root.binding.targetHostId,
                targetPath: root.binding.targetPath,
                branch: root.binding.branch,
                includePaths: root.binding.includePaths,
                operationId: root.transferOperationId,
                signal,
                timeoutMs: 45 * 60 * 1000,
                ...(root.binding.remoteBase
                  ? { remoteBase: root.binding.remoteBase }
                  : {}),
              });
              if (signal.aborted) return;
              if (result.operationId !== root.transferOperationId)
                throw new Error(
                  "Native transfer returned a different operation identity",
                );
              root.environmentId = result.environmentId;
              root.head = result.head;
              root.handoff = result.handoff;
              await inspectTarget(root, signal);
              if (signal.aborted) return;
              root.state = "ready";
              root.error = null;
            } catch (error) {
              if (signal.aborted) return;
              const transferFailure = transferFailureSchema.safeParse(error);
              root.state =
                root.transferOperationId && !transferFailure.success
                  ? "interrupted"
                  : "failed";
              root.error = errorMessage(error);
              if (transferFailure.success)
                root.transferOperationId =
                  transferFailure.data.body.details.operationId;
            }
            checkpoints.save(checkpoint);
            effects.publish(task);
          }
          checkpoint.state = checkpoint.roots.every(
            (root) => root.state === "ready",
          )
            ? "ready"
            : "partial";
          checkpoints.save(checkpoint);
          effects.publish(task);
          active = null;
        }
      } finally {
        signal.removeEventListener("abort", interrupt);
        wakePreparation = undefined;
      }
    },
  });
  return {
    async inspectTaskRepository(input) {
      requireTask(input.taskId);
      const source = await bb.sdk.environments.get({
        environmentId: input.sourceEnvironmentId,
      });
      if (source.projectId !== input.bbProjectId || !source.path)
        throw new Error(
          "Source environment does not belong to this repository project",
        );
      const preview = await bb.sdk.projects.previewWorkspaceTransfer({
        projectId: input.bbProjectId,
        sourceEnvironmentId: source.id,
        targetHostId: input.targetHostId,
        timeoutMs: 20 * 60 * 1000,
      });
      return {
        sourceHostId: source.hostId,
        sourcePath: source.path,
        sourceBranch: preview.branch,
        sourceHead: preview.head,
        activeThreadIds: preview.activeThreadIds,
        ...(preview.remoteBaseCandidates
          ? { remoteBaseCandidates: preview.remoteBaseCandidates }
          : {}),
        files: preview.files.map((file) => ({
          path: file.path,
          kind: file.kind,
          tracked: file.tracked,
          selectedByDefault: file.selectedByDefault,
          excludedReason: file.excludedReason ?? null,
        })),
      };
    },
    async getTaskRepositories({ taskId }) {
      requireTask(taskId);
      for (const checkpoint of checkpoints.list(taskId)) {
        if (
          checkpoint.state === "preparing" ||
          !checkpoint.roots.some((root) => root.state === "interrupted")
        )
          continue;
        let pending = reconciling.get(checkpoint.id);
        if (!pending) {
          pending = withTaskExecution(taskId, () =>
            reconcileInterrupted(checkpoints.get(checkpoint.id)),
          );
          reconciling.set(checkpoint.id, pending);
        }
        try {
          await pending;
        } finally {
          if (reconciling.get(checkpoint.id) === pending)
            reconciling.delete(checkpoint.id);
        }
      }
      return { checkpoints: checkpoints.list(taskId) };
    },
    async prepareTaskRepositories(input) {
      return withTaskExecution(input.taskId, async () => {
        const task = requireTask(input.taskId);
        const bindings = repositoryBindingsSchema.parse(input.bindings);
        await requireIdleTask(bb, store.tasks, task.id);
        const checkpoint: RepositoryCheckpoint = input.checkpointId
          ? checkpoints.get(input.checkpointId)
          : {
              id: `mrc_${randomUUID()}`,
              taskId: task.id,
              state: "preparing",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              roots: bindings.map((binding) => ({
                binding,
                state: "pending",
                transferOperationId: null,
                environmentId: null,
                threadId: null,
                head: null,
                handoff: "",
                error: null,
                attempts: [],
              })),
            };
        if (input.checkpointId) {
          if (checkpoint.state === "preparing")
            throw new Error(
              "Repository preparation is already in progress; inspect its per-root state instead of replaying it",
            );
          if (
            checkpoint.roots.some(
              (root) => root.state === "started" || root.state === "spawning",
            )
          )
            throw new Error(
              "The coherent executor's root set is fixed once continuation begins; do not add repositories to a live native session",
            );
          if (
            checkpoint.taskId !== task.id ||
            checkpoint.roots.length !== bindings.length
          )
            throw new Error("Retry must use the same task and repository set");
          for (const root of checkpoint.roots) {
            const binding = bindings.find(
              (entry) => entry.id === root.binding.id,
            );
            if (!binding)
              throw new Error("Retry must preserve repository identities");
            if (
              root.state === "ready" ||
              root.state === "started" ||
              root.state === "spawning"
            ) {
              if (JSON.stringify(binding) !== JSON.stringify(root.binding))
                throw new Error(
                  "Verified repositories cannot be changed by a retry",
                );
            } else {
              if (
                binding.bbProjectId !== root.binding.bbProjectId ||
                binding.sourceEnvironmentId !==
                  root.binding.sourceEnvironmentId ||
                binding.sourceHostId !== root.binding.sourceHostId ||
                binding.sourcePath !== root.binding.sourcePath ||
                binding.required !== root.binding.required
              )
                throw new Error(
                  "Retry must preserve source identity and required-root policy",
                );
              if (
                binding.targetPath === root.binding.targetPath &&
                binding.targetHostId === root.binding.targetHostId
              )
                throw new Error(
                  "Use a fresh destination for failed or interrupted transfers; old targets are preserved",
                );
              root.attempts.push({
                targetHostId: root.binding.targetHostId,
                targetPath: root.binding.targetPath,
                transferOperationId: root.transferOperationId,
                environmentId: root.environmentId,
                error:
                  root.error ??
                  (root.state === "preparing"
                    ? "Preparation interrupted; source and target preserved"
                    : null),
              });
              root.binding = binding;
              root.state = "pending";
              root.environmentId = null;
              root.transferOperationId = null;
              root.head = null;
              root.handoff = "";
              root.error = null;
            }
          }
          checkpoint.state = "preparing";
          checkpoints.reserveRetry(checkpoint);
        } else checkpoints.create(checkpoint);
        wakePreparation?.();
        effects.publish(task);
        return checkpoint;
      });
    },
    async continueTaskRepositories({ taskId, checkpointId }) {
      return withTaskExecution(taskId, async () => {
        const task = requireTask(taskId);
        const checkpoint = checkpoints.get(checkpointId);
        if (checkpoint.taskId !== taskId)
          throw new Error("Checkpoint belongs to another task");
        if (checkpoint.state === "preparing")
          throw new Error(
            "Repository preparation is still in progress; wait for its per-root outcomes before continuation",
          );
        if (
          checkpoint.roots.some(
            (root) =>
              root.binding.required &&
              !["ready", "spawning", "started"].includes(root.state),
          )
        )
          throw new Error(
            "Every required repository must be verified before starting any executor",
          );
        const readyRoots = checkpoint.roots.filter((root) =>
          ["ready", "spawning", "started"].includes(root.state),
        );
        const primary = readyRoots[0];
        if (!primary?.binding.required || !primary.environmentId)
          throw new Error("The primary required repository must be ready");
        const preset = profile(primary.binding.presetId);
        const candidates = await environmentThreads(bb, primary.environmentId);
        let recovered: string | null = null;
        for (const candidate of candidates) {
          const metadata = await bb.sdk.threads.getPluginMetadata({
            threadId: candidate.id,
          });
          if (
            metadata.repositoryCheckpointId === checkpoint.id &&
            metadata.taskId === taskId
          )
            recovered = candidate.id;
          else if (candidate.deletedAt == null)
            throw new Error(
              `Primary repository already has another writer/context: ${candidate.id}`,
            );
        }
        if (recovered) {
          for (const root of readyRoots) {
            root.threadId = recovered;
            root.state = "started";
            root.error = null;
          }
          store.tasks.upsertTaskThread({
            taskId,
            threadId: recovered,
            presetName: preset.name,
            title: effects.title(task),
            liveStatus: "starting",
          });
        } else {
          await requireIdleTask(bb, store.tasks, taskId);
          for (const root of readyRoots) {
            try {
              await inspectTarget(root);
              if (
                (await environmentThreads(bb, root.environmentId!)).some(
                  (thread) => thread.deletedAt == null,
                )
              )
                throw new Error(
                  "Bound repository already contains another native writer context",
                );
            } catch (error) {
              root.error = errorMessage(error);
              checkpoint.state = "partial";
              checkpoints.save(checkpoint);
              throw error;
            }
          }
          checkpoint.state = "starting";
          for (const root of readyRoots) root.state = "spawning";
          checkpoints.save(checkpoint);
          try {
            const environment = await targetSpawnEnvironment(
              bb,
              {
                bbProjectId: primary.binding.bbProjectId,
                hostId: primary.binding.targetHostId,
                presetId: preset.id,
                workspace: {
                  kind: "existing-environment",
                  environmentId: primary.environmentId,
                },
              },
              preset,
            );
            const thread = await bb.sdk.threads.spawn({
              projectId: primary.binding.bbProjectId,
              environment,
              transferOperationId: primary.transferOperationId!,
              ...(readyRoots.length > 1
                ? {
                    repositoryTransferOperationIds: readyRoots.map(
                      (root) => root.transferOperationId!,
                    ),
                  }
                : {}),
              providerId: preset.providerId,
              model: preset.modelId,
              reasoningLevel: preset.reasoningLevel,
              ...(preset.serviceTier === null
                ? {}
                : { serviceTier: preset.serviceTier }),
              permissionMode: preset.permissionMode,
              title: effects.title(task),
              prompt: effects.prompt(
                task,
                preset,
                [
                  `Coherent multi-repository checkpoint: ${checkpoint.id}. You are the single writer for ALL verified roots below.`,
                  "Use each repository's own Git history and isolated branch. Never create an umbrella Git repository. Source paths are preserved and must not be edited.",
                  ...readyRoots.flatMap((root) => [
                    `Repository ${root.binding.id}: ${root.binding.role}`,
                    `Owner: ${root.binding.owner}; writable root: ${root.binding.targetPath}; branch: ${root.binding.branch}`,
                    root.binding.instructions,
                    `Read required context: ${root.binding.instructionPaths.map((name) => `${root.binding.targetPath}/${name}`).join(", ")}`,
                    root.handoff,
                  ]),
                  ...checkpoint.roots
                    .filter((root) => !readyRoots.includes(root))
                    .map(
                      (root) =>
                        `Unavailable optional repository ${root.binding.id}: ${root.error ?? root.state}. Do not claim it migrated or modify its source.`,
                    ),
                ].join("\n"),
              ),
              pluginMetadata: {
                taskId,
                repositoryCheckpointId: checkpoint.id,
                repositoryBindingIds: readyRoots.map((root) => root.binding.id),
              },
            });
            for (const root of readyRoots) {
              root.threadId = thread.id;
              root.state = "started";
              root.error = null;
            }
            store.tasks.upsertTaskThread({
              taskId,
              threadId: thread.id,
              presetName: preset.name,
              title: effects.title(task),
              liveStatus: "starting",
            });
          } catch (error) {
            for (const root of readyRoots) root.error = errorMessage(error);
            checkpoint.state = "partial";
            checkpoints.save(checkpoint);
            effects.publish(task);
            return checkpoint;
          }
        }
        checkpoint.state = checkpoint.roots.every(
          (root) => root.state === "started",
        )
          ? "started"
          : "partial";
        checkpoints.save(checkpoint);
        effects.publish(task);
        return checkpoint;
      });
    },
  };
}
