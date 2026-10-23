import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type {
  Attachment,
  Comment,
  Preset,
  Project,
  Task,
  TasksStore,
  TaskThreadLiveStatus,
} from "../db";
import {
  publishCommentsChanged,
  publishTasksChanged,
  type TasksApiStore,
} from "../api";
import {
  presetPermissionModeSchema,
  presetReasoningLevelSchema,
  presetServiceTierSchema,
  type ThreadsChangedEvent,
} from "../shared/contract";
import { errorMessage } from "../shared/errors";
import { truncateToWidth } from "../shared/text-measure";
import { delegationRpcContract } from "./contract";
import { storedJiraContext } from "../jira/store";
import { ExecutionStore } from "./execution-store";
import { continuationHandlers } from "./continuation";
import { requireIdleTask, resolveTaskExecution, targetSpawnEnvironment, withTaskExecution } from "./execution";

const MAX_DELEGATED_THREAD_TITLE_WIDTH = 120;
const SYSTEM_AUTHOR_NAME = "Tasks";
const MANUAL_PRESET_NAME = "Attached";

const presetExecutionSchema = z
  .object({
    providerId: z.string().trim().min(1),
    model: z.string().trim().min(1),
    reasoningLevel: presetReasoningLevelSchema,
    serviceTier: presetServiceTierSchema.nullable(),
    permissionMode: presetPermissionModeSchema,
  })
  .strict();

type DelegationErrorCode = "project_not_linked" | "spawn_target_invalid";

class DelegationError extends Error {
  constructor(
    readonly code: DelegationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DelegationError";
  }
}

interface SeedPromptInput {
  task: Task;
  project: Project;
  subtasks: readonly Task[];
  attachments: readonly Pick<Attachment, "id" | "fileName">[];
  recentComments: readonly Comment[];
  presetInstructions: string;
  extraInstructions?: string;
  jiraContext?: string | null;
}

function markdownSection(title: string, body: string): string {
  return `## ${title}\n\n${body}`;
}

function formatSubtasks(subtasks: readonly Task[]): string {
  if (subtasks.length === 0) return "None.";
  return subtasks
    .map((subtask) => `- ${subtask.key} · ${subtask.title} (${subtask.status})`)
    .join("\n");
}

function formatAttachments(
  attachments: readonly Pick<Attachment, "id" | "fileName">[],
): string {
  if (attachments.length === 0) return "None.";
  return attachments
    .map(
      (attachment) =>
        `- ${attachment.fileName} · ${attachment.id}\n` +
        `  Fetch with: bb tasks attachment get ${attachment.id} --out <path>`,
    )
    .join("\n");
}

function formatComments(comments: readonly Comment[]): string {
  if (comments.length === 0) return "None.";
  return comments
    .map(
      (comment) =>
        `### ${comment.authorName} · ${comment.kind} · ${comment.createdAt}\n\n${comment.body}`,
    )
    .join("\n\n");
}

export function buildSeedPrompt(input: SeedPromptInput): string {
  const sections = [
    `# ${input.task.key} · ${input.task.title}`,
    markdownSection(
      "Description",
      input.task.description.trim() || "No description provided.",
    ),
    markdownSection(
      "Project context",
      `- Name: ${input.project.name}\n- Linked bb project: ${input.project.linkedBbProjectId ?? "Not linked"}`,
    ),
    markdownSection("Sub-tasks", formatSubtasks(input.subtasks)),
    markdownSection("Attachments", formatAttachments(input.attachments)),
    markdownSection("Recent comments", formatComments(input.recentComments)),
    markdownSection(
      "Report-back contract",
      `You are working on task ${input.task.key}. Use the bb tasks CLI: comment substantive updates (bb tasks comment ${input.task.key} --body ...), attach result artifacts, set status when done (bb tasks update ${input.task.key} --status in_review) or explain blockage in a comment. Your thread is already attached to the task.`,
    ),
  ];

  if (input.jiraContext) {
    sections.push(markdownSection("Jira source snapshot", input.jiraContext));
  }

  if (input.presetInstructions.trim()) {
    sections.push(
      markdownSection("Preset instructions", input.presetInstructions.trim()),
    );
  }
  if (input.extraInstructions?.trim()) {
    sections.push(
      markdownSection(
        "Additional instructions",
        input.extraInstructions.trim(),
      ),
    );
  }

  return `${sections.join("\n\n")}\n`;
}

function delegatedThreadTitle(task: Task): string {
  return truncateToWidth(
    `${task.key} · ${task.title}`,
    MAX_DELEGATED_THREAD_TITLE_WIDTH,
  );
}

function requireTask(store: TasksStore, taskId: string): Task {
  const task = store.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  return task;
}

function requireProject(store: TasksStore, projectId: string): Project {
  const project = store.getProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  return project;
}

function requirePreset(store: TasksStore, presetId: string): Preset {
  const preset = store.getPreset(presetId);
  if (!preset) throw new Error(`Preset not found: ${presetId}`);
  return preset;
}

function requireLinkedBbProject(project: Project): string {
  if (project.linkedBbProjectId) return project.linkedBbProjectId;
  throw new DelegationError(
    "project_not_linked",
    `Task project "${project.name}" is not linked to a bb project`,
  );
}

function collectAttachments(
  store: TasksStore,
  taskId: string,
  comments: readonly Comment[],
): Attachment[] {
  const attachments = new Map<string, Attachment>();
  for (const attachment of store.listAttachmentsForTask(taskId)) {
    attachments.set(attachment.id, attachment);
  }
  for (const comment of comments) {
    for (const attachment of store.listAttachmentsForComment(comment.id)) {
      attachments.set(attachment.id, attachment);
    }
  }
  return [...attachments.values()];
}

type SpawnEnvironment = Parameters<
  BbPluginApi["sdk"]["threads"]["spawn"]
>[0]["environment"];

async function presetSpawnEnvironment(
  bb: BbPluginApi,
  preset: Preset,
  projectId: string,
): Promise<SpawnEnvironment> {
  if (preset.environmentKind === "project-default") {
    const project = await bb.sdk.projects.get({ projectId });
    const source = project.sources.find((candidate) => candidate.isDefault);
    if (!source) {
      throw new DelegationError(
        "spawn_target_invalid",
        "Could not dispatch task because the linked bb project has no default local-path source",
      );
    }
    return {
      type: "host",
      hostId: source.hostId,
      workspace: { type: "unmanaged", path: source.path },
    };
  }

  const hostId =
    preset.machineId ?? (await bb.sdk.system.config()).primaryHostId;
  if (hostId === null) {
    throw new DelegationError(
      "spawn_target_invalid",
      "Could not create a worktree because BB has no default machine",
    );
  }
  return {
    type: "host",
    hostId,
    workspace: {
      type: "managed-worktree",
      baseBranch:
        preset.baseBranch === null
          ? { kind: "default" }
          : { kind: "named", name: preset.baseBranch },
    },
  };
}

function isBbHttpError(
  error: unknown,
): error is Error & { code: string | null; status: number } {
  return (
    error instanceof Error &&
    "code" in error &&
    (typeof error.code === "string" || error.code === null) &&
    "status" in error &&
    typeof error.status === "number"
  );
}

const SPAWN_TARGET_ERROR_CODES = new Set([
  "host_not_found",
  "host_unavailable",
  "invalid_request",
  "project_unavailable",
  "unsupported_host",
  "workspace_unavailable",
]);

function mapSpawnTargetError(error: unknown, preset: Preset): never {
  if (
    preset.environmentKind === "new-worktree" &&
    isBbHttpError(error) &&
    error.code !== null &&
    SPAWN_TARGET_ERROR_CODES.has(error.code)
  ) {
    const machine = preset.machineId ?? "the default machine";
    const branch = preset.baseBranch ?? "the default branch";
    const detail = error.message.replace(/^HTTP \d+:\s*/u, "");
    throw new DelegationError(
      "spawn_target_invalid",
      `Could not create a worktree on ${machine} from ${branch}: ${detail}`,
    );
  }
  throw error;
}

export function createSystemComment(
  store: TasksStore,
  input: {
    taskId: string;
    presetName: string;
    threadId: string;
    body: string;
  },
): void {
  store.createComment({
    taskId: input.taskId,
    kind: "system",
    authorName: SYSTEM_AUTHOR_NAME,
    presetName: input.presetName,
    threadId: input.threadId,
    body: input.body,
  });
}

export function publishThreadsChanged(bb: BbPluginApi, taskId: string): void {
  const payload: ThreadsChangedEvent = { taskId };
  bb.realtime.publish("threads:changed", payload);
}

type SdkThread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;

function taskThreadLiveStatus(thread: SdkThread): TaskThreadLiveStatus {
  if (thread.deletedAt != null) return "completed";
  switch (thread.status) {
    case "pending":
    case "starting":
      return "starting";
    case "active":
    case "stopping":
      return "working";
    case "idle":
      return "idle";
    case "error":
      return "failed";
  }
}

export function handlers(
  bb: BbPluginApi,
  store: TasksApiStore,
): PluginRpcHandlers<typeof delegationRpcContract> {
  const executions = new ExecutionStore(bb.storage.database());
  const seed = (task: Task, preset: Preset, extraInstructions?: string) => {
    const comments = store.tasks.listComments(task.id);
    return buildSeedPrompt({
      task,
      project: requireProject(store.tasks, task.projectId),
      subtasks: store.tasks.listSubtasks(task.id),
      attachments: collectAttachments(store.tasks, task.id, comments),
      recentComments: comments.slice(-5),
      presetInstructions: preset.instructions,
      extraInstructions,
      jiraContext: storedJiraContext(bb, task.id),
    });
  };
  return {
    ...continuationHandlers(bb, store, executions, {
      prompt: seed,
      title: delegatedThreadTitle,
      readLiveStatus: async (threadId) => taskThreadLiveStatus(await bb.sdk.threads.get({ threadId })),
      comment: (input) => createSystemComment(store.tasks, input),
      publish(task) {
        publishThreadsChanged(bb, task.id);
        publishTasksChanged(bb, task.id, task.projectId);
        publishCommentsChanged(bb, task.id);
      },
    }),
    async getTaskExecution(input) {
      const task = requireTask(store.tasks, input.taskId);
      return resolveTaskExecution(bb, store.tasks, executions, task.id, requireProject(store.tasks, task.projectId), input.presetId);
    },
    async setTaskExecution(input) {
      return withTaskExecution(input.taskId, async () => {
        const task = requireTask(store.tasks, input.taskId);
        if (input.target) {
          const preset = requirePreset(store.tasks, input.target.presetId);
          await targetSpawnEnvironment(bb, input.target, preset);
        }
        executions.setTarget(task.id, input.target);
        publishTasksChanged(bb, task.id, task.projectId);
        return resolveTaskExecution(bb, store.tasks, executions, task.id, requireProject(store.tasks, task.projectId));
      });
    },
    async listTaskExecutionEnvironments(input) {
      const environments = await bb.sdk.environments.list({ projectId: input.bbProjectId, ...(input.hostId ? { hostId: input.hostId } : {}) });
      return { environments: environments.filter((environment) => environment.projectId === input.bbProjectId && environment.path !== null && environment.status === "ready" && environment.lifecycle.phase === "active" && environment.hostLifecycle === "active").map((environment) => ({
        id: environment.id, hostId: environment.hostId, path: environment.path ?? "", name: environment.name ?? environment.path ?? environment.id,
      })) };
    },
    async delegate(input) {
      return withTaskExecution(input.taskId, async () => {
      const task = requireTask(store.tasks, input.taskId);
      const project = requireProject(store.tasks, task.projectId);
      const persisted = executions.target(task.id);
      const target = input.executionTarget ?? persisted;
      const presetId = input.presetId ?? target?.presetId;
      if (!presetId) throw new Error("Choose an execution profile or configure the task execution target");
      const preset = requirePreset(store.tasks, presetId);
      const linkedBbProjectId = target?.bbProjectId ?? requireLinkedBbProject(project);
      if (executions.pending(task.id)) throw new Error("Task has a prepared continuation. Retry its operation before dispatching new work.");
      await requireIdleTask(bb, store.tasks, task.id);
      const title = delegatedThreadTitle(task);
      const execution = presetExecutionSchema.parse({
        providerId: preset.providerId,
        model: preset.modelId,
        reasoningLevel: preset.reasoningLevel,
        serviceTier: preset.serviceTier,
        permissionMode: preset.permissionMode,
      });
      const prompt = seed(task, preset, input.extraInstructions);

      const environment = target
        ? await targetSpawnEnvironment(bb, { ...target, presetId: preset.id }, preset)
        : await presetSpawnEnvironment(bb, preset, linkedBbProjectId);
      const thread = await bb.sdk.threads
        .spawn({
          projectId: linkedBbProjectId,
          environment,
          providerId: execution.providerId,
          model: execution.model,
          reasoningLevel: execution.reasoningLevel,
          ...(execution.serviceTier === null
            ? {}
            : { serviceTier: execution.serviceTier }),
          permissionMode: execution.permissionMode,
          title,
          prompt,
        })
        .catch((error: unknown) => mapSpawnTargetError(error, preset));

      const taskThread = store.transaction(() => {
        const attached = store.tasks.upsertTaskThread({
          taskId: task.id,
          threadId: thread.id,
          presetName: preset.name,
          title,
          liveStatus: "starting",
        });

        if (task.status === "backlog" || task.status === "todo") {
          store.tasks.updateTask(task.id, { status: "in_progress" });
          createSystemComment(store.tasks, {
            taskId: task.id,
            presetName: preset.name,
            threadId: thread.id,
            body: `Status changed to In Progress · dispatched to ${preset.name}`,
          });
        }

        createSystemComment(store.tasks, {
          taskId: task.id,
          presetName: preset.name,
          threadId: thread.id,
          body: `Dispatched to ${preset.name}`,
        });
        return attached;
      });

      try {
        const currentThread = await bb.sdk.threads.get({ threadId: thread.id });
        const currentLiveStatus = taskThreadLiveStatus(currentThread);
        if (currentLiveStatus !== taskThread.liveStatus) {
          store.tasks.updateTaskThreadStatus(taskThread.id, currentLiveStatus);
        }
      } catch (error) {
        bb.log.warn(
          `Could not read delegated thread ${thread.id} after attach: ${errorMessage(
            error,
          )}`,
        );
      }

      publishThreadsChanged(bb, task.id);
      publishTasksChanged(bb, task.id, task.projectId);
      publishCommentsChanged(bb, task.id);
      return { threadId: thread.id };
      });
    },

    async taskThreadsAttach(input) {
      const task = requireTask(store.tasks, input.taskId);
      const thread = await bb.sdk.threads.get({ threadId: input.threadId });
      const title = truncateToWidth(
        thread.title ?? thread.titleFallback ?? delegatedThreadTitle(task),
        MAX_DELEGATED_THREAD_TITLE_WIDTH,
      );

      store.tasks.upsertTaskThread({
        taskId: task.id,
        threadId: thread.id,
        presetName: MANUAL_PRESET_NAME,
        title,
        liveStatus: taskThreadLiveStatus(thread),
      });

      publishThreadsChanged(bb, task.id);
      publishTasksChanged(bb, task.id, task.projectId);
      return { threadId: thread.id };
    },

    async taskThreadsDetach(input) {
      const task = requireTask(store.tasks, input.taskId);
      const taskThread = store.tasks.getTaskThreadByThreadId(
        task.id,
        input.threadId,
      );
      if (!taskThread) {
        throw new Error(
          `Thread ${input.threadId} is not attached to ${task.key}`,
        );
      }
      store.tasks.deleteTaskThread(taskThread.id);

      publishThreadsChanged(bb, task.id);
      publishTasksChanged(bb, task.id, task.projectId);
      return { threadId: taskThread.threadId };
    },
  };
}

export function registerDelegation(
  bb: BbPluginApi,
  store: TasksApiStore,
): void {
  bb.rpc.register(delegationRpcContract, handlers(bb, store));
}
