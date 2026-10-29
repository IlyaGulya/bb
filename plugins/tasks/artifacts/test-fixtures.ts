import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createStore } from "../api/index.js";
import { registerAttachments, saveAttachmentFromBytes } from "../attachments/index.js";
import { registerTaskArtifacts } from "./index.js";
import type { TaskArtifactCreate } from "../shared/artifacts.js";

export const FAKE_SCREENSHOT = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVR4nGMQ0bABAADMAHm9FcOvAAAAAElFTkSuQmCC", "base64");
export const FAKE_QUOTE = "Make the button readable.";

export async function createArtifactFixture(database?: Database) {
  const state = {
    projectId: "proj_fixture",
    sourceMissing: false,
    sourceDeleted: false,
    sourceArchived: false,
    sourceText: FAKE_QUOTE,
    contextEnabled: true,
    projectMember: true,
    agentContextId: "context-personal",
    modelConnectionId: "connection-personal",
  };
  const context = (id: string) => ({ id, name: id === "context-personal" ? "Personal" : "Work", enabled: state.contextEnabled, projectIds: state.projectMember ? [state.projectId] : [] });
  const { bb: hostBb, harness } = createFakePluginHost({
    pluginId: "tasks",
    sdk: {
      threads: {
        get: ({ threadId }) => {
          if (threadId === "thr_source" && state.sourceMissing) throw Object.assign(new Error("Source removed"), { code: "thread_not_found" });
          return makeThreadResponse({ id: threadId, projectId: state.projectId, title: "Owned fake UI decision", archivedAt: threadId === "thr_source" && state.sourceArchived ? 10 : null, deletedAt: threadId === "thr_source" && state.sourceDeleted ? 20 : null });
        },
        message: ({ seq }) => ({ message: { messageSeq: seq, role: "assistant", text: state.sourceText }, before: [], after: [] }),
      },
      experimental_executionContexts: {
        get: ({ id }) => context(id),
        list: () => [context("context-personal"), context("context-work")],
        getThreadBinding: ({ threadId }) => ({ threadId, executionContext: context(threadId === "thr_source" ? "context-personal" : state.agentContextId), modelConnection: { id: state.modelConnectionId }, createdAt: 0 }),
      },
    },
  });
  const bb = database ? { ...hostBb, storage: { ...hostBb.storage, database: () => database } } : hostBb;
  const store = createStore(bb);
  let project = store.tasks.listProjects()[0];
  if (!project) project = store.tasks.createProject({ name: "Owned fake artifacts", prefix: "FAKE", color: "blue", linkedBbProjectId: "proj_fixture" });
  let task = store.tasks.listTasks({ projectId: project.id })[0];
  if (!task) task = store.tasks.createTask({ projectId: project.id, title: "Owned fake screenshot decision" });
  registerAttachments(bb, store.tasks);
  const service = registerTaskArtifacts(bb, store);
  const imageAttachment = database ? store.tasks.listAttachmentsForTask(task.id).find(attachment => attachment.isImage) : await saveAttachmentFromBytes(store.tasks, FAKE_SCREENSHOT, { taskId: task.id, fileName: "owned-fake.png", mime: "image/png" });
  if (!imageAttachment) throw new Error("Owned fake screenshot is missing");
  const scope = { taskId: task.id, executionContextId: "context-personal" };
  const image = await service.handlers.inspectTaskArtifactImage({ ...scope, attachmentId: imageAttachment.id });
  const input = (annotated = true): TaskArtifactCreate => ({
    ...scope,
    artifactId: randomUUID(),
    source: { threadId: "thr_source", eventSeq: 7, quote: FAKE_QUOTE },
    decision: "Improve the owned fake button contrast",
    annotation: annotated ? { image, coordinateFrame: "decoded-image-pixels", region: { x: 0, y: 0, width: 1, height: 1 }, comment: "Use the normal foreground token on this button" } : null,
    retentionConfirmed: true,
  });
  return { bb, harness, store, task, project, service, scope, image, imageAttachment, state, input };
}
