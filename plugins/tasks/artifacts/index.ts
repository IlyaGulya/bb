import { createHash } from "node:crypto";
import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { TasksApiStore } from "../api/index.js";
import { readAttachmentContent, withAttachmentLock } from "../attachments/index.js";
import { escapeLike } from "../db/index.js";
import {
  artifactAnnotationSchema,
  artifactSourceUrl,
  taskArtifactCreateSchema,
  taskArtifactRpcContract,
  type TaskArtifact,
  type TaskArtifactCreate,
  type TaskArtifactRpcContract,
  type TaskArtifactView,
} from "../shared/artifacts.js";
import { inspectArtifactImage } from "./image.js";
import { TaskArtifactStore } from "./store.js";

type Scope = { taskId: string; executionContextId: string };
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const unavailable = () => new Error("Task artifact is unavailable in this execution context");

export function taskArtifactHandlers(bb: BbPluginApi, store: TasksApiStore) {
  const artifacts = new TaskArtifactStore(store);

  async function contextProject(contextId: string, projectId: string) {
    const context = await bb.sdk.experimental_executionContexts.get({ id: contextId });
    if (!context.enabled || !context.projectIds.includes(projectId)) throw unavailable();
    return context;
  }

  async function taskScope(scope: Scope): Promise<string> {
    const task = store.tasks.getTask(scope.taskId);
    const project = task && store.tasks.getProject(task.projectId);
    if (!project?.linkedBbProjectId) throw unavailable();
    await contextProject(scope.executionContextId, project.linkedBbProjectId);
    return project.linkedBbProjectId;
  }

  async function threadScope(threadId: string) {
    const [thread, binding] = await Promise.all([
      bb.sdk.threads.get({ threadId }),
      bb.sdk.experimental_executionContexts.getThreadBinding({ threadId }),
    ]);
    if (thread.deletedAt !== null || !binding?.executionContext) throw unavailable();
    const context = await contextProject(binding.executionContext.id, thread.projectId);
    return { thread, context };
  }

  async function retained(scope: Scope & { artifactId: string }) {
    const projectId = await taskScope(scope);
    const artifact = artifacts.get(scope.artifactId);
    if (!artifact || artifact.taskId !== scope.taskId || artifact.executionContextId !== scope.executionContextId || artifact.bbProjectId !== projectId) throw unavailable();
    return artifact;
  }

  async function inspectImage(scope: Scope & { attachmentId: string }) {
    await taskScope(scope);
    const attachment = store.tasks.getAttachment(scope.attachmentId);
    if (!attachment || attachment.taskId !== scope.taskId || !attachment.isImage) throw unavailable();
    const { content } = await readAttachmentContent(store.tasks, attachment.id);
    const image = inspectArtifactImage(attachment.id, content);
    if (image.mime !== attachment.mime) throw new Error("The attachment MIME type does not match its image bytes");
    return { image, content };
  }

  async function sourceView(artifact: TaskArtifact): Promise<TaskArtifactView> {
    try {
      const thread = await bb.sdk.threads.get({ threadId: artifact.source.threadId });
      if (thread.deletedAt !== null) return { artifact, sourceStatus: "deleted", sourceUrl: null };
      const { context } = await threadScope(thread.id);
      if (context.id !== artifact.executionContextId || thread.projectId !== artifact.bbProjectId) return { artifact, sourceStatus: "unavailable", sourceUrl: null };
      const { message } = await bb.sdk.threads.message({ threadId: thread.id, seq: artifact.source.eventSeq, before: 0, after: 0 });
      if (message.messageSeq !== artifact.source.eventSeq || sha256(message.text) !== artifact.source.textSha256) return { artifact, sourceStatus: "changed", sourceUrl: null };
      return { artifact, sourceStatus: thread.archivedAt === null ? "available" : "archived", sourceUrl: artifactSourceUrl(artifact) };
    } catch (error) {
      const missing = error !== null && typeof error === "object" && "code" in error && error.code === "thread_not_found";
      return { artifact, sourceStatus: missing ? "deleted" : "unavailable", sourceUrl: null };
    }
  }

  function matches(artifact: TaskArtifact, input: TaskArtifactCreate): boolean {
    return artifact.taskId === input.taskId && artifact.executionContextId === input.executionContextId &&
      artifact.source.threadId === input.source.threadId && artifact.source.eventSeq === input.source.eventSeq &&
      artifact.source.quote === input.source.quote && artifact.decision === input.decision &&
      JSON.stringify(artifact.annotation) === JSON.stringify(input.annotation);
  }

  const handlers = {
    async taskArtifactTargets({ threadId, search }) {
      const { thread, context } = await threadScope(threadId);
      const tasks = store.database.prepare<{ project: string; search: string }, { id: string; key: string; title: string }>(`
        SELECT t.id, p.prefix || '-' || t.number AS key, t.title
        FROM tasks t JOIN projects p ON p.id = t.project_id
        WHERE p.linked_bb_project_id = @project
          AND ((p.prefix || '-' || t.number) LIKE @search ESCAPE '\\' OR t.title LIKE @search ESCAPE '\\')
        ORDER BY t.updated_at DESC, t.id LIMIT 100
      `).all({ project: thread.projectId, search: `%${escapeLike(search)}%` });
      return { executionContextId: context.id, contextName: context.name, tasks };
    },
    async inspectTaskArtifactImage(input) {
      return withAttachmentLock(store.tasks, input.attachmentId, async () => (await inspectImage(input)).image);
    },
    async createTaskArtifact(request) {
      const input = taskArtifactCreateSchema.parse(request);
      const projectId = await taskScope(input);
      const existing = artifacts.get(input.artifactId);
      if (existing) {
        if (!matches(existing, input) || existing.bbProjectId !== projectId) throw new Error("Artifact ID is already used by another retained selection");
        return existing;
      }
      const { thread, context } = await threadScope(input.source.threadId);
      if (thread.projectId !== projectId || context.id !== input.executionContextId) throw unavailable();
      const { message } = await bb.sdk.threads.message({ threadId: thread.id, seq: input.source.eventSeq, before: 0, after: 0 });
      if (message.messageSeq !== input.source.eventSeq || !message.text.includes(input.source.quote)) throw new Error("Select a bounded quote from the actual source message");
      const artifact: TaskArtifact = {
        id: input.artifactId,
        taskId: input.taskId,
        bbProjectId: projectId,
        executionContextId: input.executionContextId,
        source: { ...input.source, role: message.role, textSha256: sha256(message.text) },
        decision: input.decision,
        annotation: input.annotation,
        createdAt: new Date().toISOString(),
      };
      const persist = () => store.transaction(() => {
        const found = artifacts.get(artifact.id);
        if (found) {
          if (!matches(found, input)) throw new Error("Artifact ID is already used by another retained selection");
          return found;
        }
        const task = store.tasks.getTask(input.taskId);
        if (!task || store.tasks.getProject(task.projectId)?.linkedBbProjectId !== projectId) throw unavailable();
        return artifacts.create(artifact);
      });
      let saved: TaskArtifact;
      if (input.annotation) {
        const annotation = input.annotation;
        saved = await withAttachmentLock(store.tasks, annotation.image.attachmentId, async () => {
          const { image } = await inspectImage({ ...input, attachmentId: annotation.image.attachmentId });
          if (JSON.stringify(image) !== JSON.stringify(annotation.image)) throw new Error("Screenshot bytes or dimensions changed; inspect the image again");
          artifact.annotation = artifactAnnotationSchema.parse({ ...annotation, image });
          await contextProject(input.executionContextId, projectId);
          return persist();
        });
      } else {
        await contextProject(input.executionContextId, projectId);
        saved = persist();
      }
      bb.realtime.publish("task-artifacts:changed", { taskId: saved.taskId, executionContextId: saved.executionContextId });
      return saved;
    },
    async listTaskArtifacts(input) {
      const projectId = await taskScope(input);
      return artifacts.list(input.taskId, input.executionContextId, projectId);
    },
    async getTaskArtifact(input) {
      return sourceView(await retained(input));
    },
    async deleteTaskArtifact(input) {
      const artifact = await retained(input);
      const deleted = artifacts.delete(artifact.id);
      if (deleted) bb.realtime.publish("task-artifacts:changed", { taskId: artifact.taskId, executionContextId: artifact.executionContextId });
      return { deleted };
    },
  } satisfies PluginRpcHandlers<TaskArtifactRpcContract>;

  async function readForThread(artifactId: string, threadId: string) {
    const artifact = artifacts.get(artifactId);
    if (!artifact) throw unavailable();
    const { thread, context } = await threadScope(threadId);
    if (thread.projectId !== artifact.bbProjectId || context.id !== artifact.executionContextId) throw unavailable();
    const view = await handlers.getTaskArtifact({ taskId: artifact.taskId, executionContextId: context.id, artifactId });
    const annotation = artifact.annotation;
    const image = annotation
      ? await withAttachmentLock(store.tasks, annotation.image.attachmentId, async () => {
          const inspected = await inspectImage({ taskId: artifact.taskId, executionContextId: context.id, attachmentId: annotation.image.attachmentId });
          if (inspected.image.sha256 !== annotation.image.sha256) throw new Error("Retained screenshot integrity check failed");
          return inspected;
        })
      : null;
    return { view, image };
  }

  return { handlers, readForThread };
}
export type TaskArtifactService = ReturnType<typeof taskArtifactHandlers>;

export function registerTaskArtifacts(bb: BbPluginApi, store: TasksApiStore): TaskArtifactService {
  const service = taskArtifactHandlers(bb, store);
  bb.rpc.register(taskArtifactRpcContract, service.handlers);
  bb.agents.registerTool({
    name: "bb_task_artifact_read",
    description: "Read a retained task decision or screenshot annotation, including the actual image and original-pixel coordinates. Uses this thread's logical context, never its model account. Does not launch a writer or change task status.",
    parameters: z.object({ artifactId: z.uuid() }).strict(),
    async execute({ artifactId }, ctx) {
      try {
        ctx.signal.throwIfAborted();
        const { view, image } = await service.readForThread(artifactId, ctx.threadId);
        ctx.signal.throwIfAborted();
        return { content: [
          { type: "text" as const, text: JSON.stringify(view) },
          ...(image ? [{ type: "image" as const, data: image.content.toString("base64"), mimeType: image.image.mime }] : []),
        ] };
      } catch {
        return { isError: true, content: [{ type: "text", text: "Task artifact could not be read in this thread's current context. Check the retained task, context permission and screenshot availability." }] };
      }
    },
  });
  return service;
}
