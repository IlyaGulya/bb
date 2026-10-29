import {
  experimental_providerExecutionReadinessBlocker,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import type { Preset, Project, TasksStore } from "../db";
import type { ExecutionTarget, TaskExecution } from "../shared/execution";
import type { ExecutionStore } from "./execution-store";

type SpawnEnvironment = Parameters<
  BbPluginApi["sdk"]["threads"]["spawn"]
>[0]["environment"];

export function taskExecutionSelection(
  preset: Pick<Preset, "executionContextId" | "modelConnectionId">,
  target?: Pick<
    ExecutionTarget,
    "executionContextId" | "modelConnectionId"
  > | null,
  request?: { executionContextId?: string; modelConnectionId?: string },
): { executionContextId?: string; modelConnectionId?: string } {
  const executionContextId =
    request?.executionContextId ??
    target?.executionContextId ??
    preset.executionContextId ??
    undefined;
  const modelConnectionId =
    request?.modelConnectionId ??
    target?.modelConnectionId ??
    preset.modelConnectionId ??
    undefined;
  return {
    ...(executionContextId === undefined ? {} : { executionContextId }),
    ...(modelConnectionId === undefined ? {} : { modelConnectionId }),
  };
}

export async function resolveTaskExecution(
  bb: BbPluginApi,
  tasks: TasksStore,
  executions: ExecutionStore,
  taskId: string,
  project: Project,
  presetId?: string,
): Promise<TaskExecution> {
  const override = executions.target(taskId);
  let resolved = override && presetId ? { ...override, presetId } : override;
  if (!resolved) {
    const preset = presetId
      ? tasks.getPreset(presetId)
      : tasks.firstPreset();
    if (preset && project.linkedBbProjectId) {
      const codeProject = await bb.sdk.projects.get({
        projectId: project.linkedBbProjectId,
      });
      const source = codeProject.sources.find(
        (candidate) => candidate.isDefault,
      );
      const hostId =
        preset.environmentKind === "project-default"
          ? source?.hostId
          : (preset.machineId ?? (await bb.sdk.system.config()).primaryHostId);
      if (hostId) {
        resolved = {
          bbProjectId: project.linkedBbProjectId,
          hostId,
          presetId: preset.id,
          workspace:
            preset.environmentKind === "project-default"
              ? { kind: "project-checkout" }
              : {
                  kind: "managed-worktree",
                  ...(preset.baseBranch
                    ? { baseBranch: preset.baseBranch }
                    : {}),
                },
        };
      }
    }
  }
  const preset = resolved ? tasks.getPreset(resolved.presetId) : undefined;
  const workspace = resolved?.workspace;
  if (resolved && preset) {
    resolved = { ...resolved, ...taskExecutionSelection(preset, resolved) };
  }
  const workspaceSummary =
    workspace?.kind === "managed-worktree"
      ? `isolated worktree (${workspace.baseBranch ?? "default branch"})`
      : workspace?.kind === "existing-environment"
        ? `existing workspace ${workspace.environmentId}`
        : "project checkout";
  return {
    override,
    resolved,
    inherited: override === null,
    summary: resolved
      ? `${override ? "Task override" : "Inherited"}: ${resolved.bbProjectId} · ${resolved.hostId} · ${workspaceSummary} · ${preset?.name ?? "Missing profile"}${resolved.executionContextId ? ` · context ${resolved.executionContextId}` : ""}${resolved.modelConnectionId ? ` · connection ${resolved.modelConnectionId}` : ""}`
      : "Inherited: select a linked code project and an execution profile, or configure a task override",
  };
}

export async function validateTargetHost(
  bb: BbPluginApi,
  hostId: string,
): Promise<void> {
  const hosts = await bb.sdk.hosts.list();
  if (!hosts.some((host) => host.id === hostId))
    throw new Error(`Machine is not enrolled: ${hostId}`);
}

export async function validateProfileAvailability(
  bb: BbPluginApi,
  preset: Preset,
  hostId: string,
  environmentId?: string,
): Promise<void> {
  const scope = environmentId ? { environmentId } : { hostId };
  const providers = await bb.sdk.providers.list({
    ...scope,
    providerId: preset.providerId,
  });
  const provider = providers.find(
    (candidate) => candidate.id === preset.providerId,
  );
  if (!provider)
    throw new Error(
      `Profile "${preset.name}" requires unregistered provider ${preset.providerId} on ${hostId}. Check provider settings.`,
    );
  const states =
    provider.available && provider.readiness?.verification !== "unsupported"
      ? await bb.sdk.system.providerStates({
          ...scope,
          providerId: preset.providerId,
        })
      : null;
  const blocker = experimental_providerExecutionReadinessBlocker(
    provider,
    states?.providers.find(
      (candidate) => candidate.providerId === preset.providerId,
    )?.readiness ?? null,
    environmentId ? "environment" : "host",
  );
  if (blocker) throw new Error(`Profile "${preset.name}": ${blocker}`);
}

export async function targetSpawnEnvironment(
  bb: BbPluginApi,
  target: ExecutionTarget,
  preset: Preset,
): Promise<SpawnEnvironment> {
  await validateTargetHost(bb, target.hostId);
  if (target.workspace.kind === "existing-environment") {
    const environment = await bb.sdk.environments.get({
      environmentId: target.workspace.environmentId,
    });
    if (
      environment.projectId !== target.bbProjectId ||
      environment.hostId !== target.hostId
    ) {
      throw new Error(
        "Selected workspace does not belong to the selected code project and machine",
      );
    }
    if (
      environment.status !== "ready" ||
      environment.lifecycle.phase !== "active" ||
      environment.hostLifecycle !== "active"
    ) {
      throw new Error("Selected workspace is not ready and active");
    }
    const threads = await environmentThreads(bb, environment.id);
    if (
      threads.some(
        (thread) => thread.status !== "idle" && thread.status !== "error",
      )
    ) {
      throw new Error("Selected workspace has running or pending agent work");
    }
    await validateProfileAvailability(
      bb,
      preset,
      target.hostId,
      environment.id,
    );
    return { type: "reuse", environmentId: environment.id };
  }
  const project = await bb.sdk.projects.get({ projectId: target.bbProjectId });
  const sources = project.sources.filter(
    (source) => source.type === "local_path" && source.hostId === target.hostId,
  );
  const source = sources.find((candidate) => candidate.isDefault) ?? sources[0];
  if (!source) {
    throw new Error(
      `Code project ${target.bbProjectId} has no prepared source on ${target.hostId}. Add the project to that machine first.`,
    );
  }
  await validateProfileAvailability(bb, preset, target.hostId);
  return {
    type: "host",
    hostId: target.hostId,
    workspace:
      target.workspace.kind === "project-checkout"
        ? { type: "unmanaged", path: source.path }
        : {
            type: "managed-worktree",
            baseBranch: target.workspace.baseBranch
              ? { kind: "named", name: target.workspace.baseBranch }
              : { kind: "default" },
          },
  };
}

const activeTasks = new Set<string>();
export async function withTaskExecution<T>(
  taskId: string,
  action: () => Promise<T>,
): Promise<T> {
  if (activeTasks.has(taskId))
    throw new Error("Task execution operation is already in progress");
  activeTasks.add(taskId);
  try {
    return await action();
  } finally {
    activeTasks.delete(taskId);
  }
}

export async function requireIdleTask(
  bb: BbPluginApi,
  tasks: TasksStore,
  taskId: string,
): Promise<void> {
  for (const attached of tasks.listTaskThreads(taskId)) {
    const thread = await bb.sdk.threads.get({ threadId: attached.threadId });
    if (
      thread.deletedAt == null &&
      thread.status !== "idle" &&
      thread.status !== "error"
    ) {
      throw new Error(
        `Task already has running or pending work in ${attached.threadId}. Stop it before dispatching or continuing.`,
      );
    }
  }
}
export async function environmentThreads(
  bb: BbPluginApi,
  environmentId: string,
) {
  const result: Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>> = [];
  const pageSize = 100;
  for (let offset = 0; ; offset += pageSize) {
    const page = await bb.sdk.threads.list({
      environmentId,
      includeHidden: true,
      limit: pageSize,
      offset,
    });
    result.push(...page);
    if (page.length < pageSize) return result;
  }
}
