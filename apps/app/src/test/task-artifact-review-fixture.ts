import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { ExecutionContext } from "@get-bb/plugin-sdk";
import tasksPlugin from "../../../../plugins/tasks/server";
import { createStore } from "../../../../plugins/tasks/api";
import { tasksRpcContract } from "../../../../plugins/tasks/shared/contract";
import {
  artifactImageSchema,
  taskArtifactCreateSchema,
  taskArtifactSchema,
  taskArtifactViewSchema,
  type TaskArtifact,
  type TaskArtifactImage,
} from "../../../../plugins/tasks/shared/artifacts";
import { TaskArtifactStore } from "../../../../plugins/tasks/artifacts/store";

export const REVIEW_SOURCE = "Use the selected control.";
export const REVIEW_DECISION = "Retain this reviewed work decision";
export const IMAGE_FORMATS = ["png", "jpeg", "webp", "gif"] as const;
export type ReviewImageFormat = (typeof IMAGE_FORMATS)[number];
export const IMAGE_MIMES = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" } as const;
export const STRICT_IMAGE_INPUT = { failOn: "warning", limitInputPixels: 256, animated: true } as const;
export const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

export async function staticReviewImage(format: ReviewImageFormat = "png") {
  const pixels = Buffer.from([255, 0, 0, 0, 0, 255]);
  const image = sharp(pixels, { raw: { width: 2, height: 1, channels: 3 } });
  const bytes = format === "webp" ? await image.webp({ lossless: true }).toBuffer() : await image.toFormat(format).toBuffer();
  return { bytes, mime: IMAGE_MIMES[format], width: 2, height: 1 };
}

function executionContext(id: string, name: string, projectIds: string[]): ExecutionContext {
  return {
    id, name, projectIds, enabled: true, instructions: "", skillRoots: [], commandRoots: [], pluginRoots: [], settingsPaths: [],
    mcpServers: [], hooksPath: null, autoMemory: false, gitIdentity: null, defaultModelConnectionId: null, createdAt: 0, updatedAt: 0,
  };
}

type ThreadFact = { projectId: string; contextId: string; text: string };

export async function createTaskArtifactReviewFixture() {
  const directory = await mkdtemp(join(tmpdir(), "bb-task-artifact-review-"));
  const contexts = new Map([
    ["context_work", executionContext("context_work", "Work", ["proj_work", "proj_shared"])],
    ["context_personal", executionContext("context_personal", "Personal", ["proj_personal", "proj_shared"])],
  ]);
  const threads = new Map<string, ThreadFact>([
    ["thr_work_source", { projectId: "proj_work", contextId: "context_work", text: REVIEW_SOURCE }],
    ["thr_work_reader", { projectId: "proj_work", contextId: "context_work", text: REVIEW_SOURCE }],
    ["thr_personal_reader", { projectId: "proj_personal", contextId: "context_personal", text: REVIEW_SOURCE }],
    ["thr_shared_work_source", { projectId: "proj_shared", contextId: "context_work", text: REVIEW_SOURCE }],
    ["thr_shared_work_reader", { projectId: "proj_shared", contextId: "context_work", text: REVIEW_SOURCE }],
    ["thr_shared_personal_reader", { projectId: "proj_shared", contextId: "context_personal", text: REVIEW_SOURCE }],
  ]);
  const fact = (threadId: string) => {
    const value = threads.get(threadId);
    if (!value) throw new Error("Unknown synthetic thread");
    return value;
  };
  const context = (id: string) => {
    const value = contexts.get(id);
    if (!value) throw new Error("Unknown synthetic context");
    return value;
  };
  const { bb, harness } = createFakePluginHost({
    pluginId: "tasks",
    sdk: {
      threads: {
        get: ({ threadId }) => makeThreadResponse({ id: threadId, projectId: fact(threadId).projectId, title: "Synthetic source decision", environmentId: null }),
        message: ({ threadId, seq }) => {
          if (seq !== 7) throw new Error("Unknown synthetic message anchor");
          return { message: { messageSeq: 7, sourceSeqStart: 7, sourceSeqEnd: 11, role: "assistant", text: fact(threadId).text }, before: [], after: [] };
        },
      },
      experimental_executionContexts: {
        get: ({ id }) => context(id),
        list: () => [...contexts.values()],
        getThreadBinding: ({ threadId }) => ({ threadId, executionContext: context(fact(threadId).contextId), modelConnection: null, createdAt: 0 }),
      },
      files: {
        write: async ({ path, content, contentEncoding, createParents }) => {
          const destination = resolve(path);
          const within = relative(directory, destination);
          if (within.startsWith("..") || resolve(directory, within) !== destination) throw new Error("Download escaped the synthetic fixture directory");
          if (createParents) await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, Buffer.from(content, contentEncoding ?? "utf8"));
          return { outcome: "written", path: destination };
        },
      },
    },
  });
  try {
    await tasksPlugin(bb);
    const store = createStore(bb);
    const workProject = store.tasks.createProject({ name: "Work tracker", prefix: "WRK", color: "blue", linkedBbProjectId: "proj_work" });
    const personalProject = store.tasks.createProject({ name: "Personal tracker", prefix: "PER", color: "green", linkedBbProjectId: "proj_personal" });
    const sharedProject = store.tasks.createProject({ name: "Shared code tracker", prefix: "SHR", color: "blue", linkedBbProjectId: "proj_shared" });
    const workTask = store.tasks.createTask({ projectId: workProject.id, title: "Retain work evidence" });
    const personalTask = store.tasks.createTask({ projectId: personalProject.id, title: "Ordinary personal attachment" });
    const sharedTask = store.tasks.createTask({ projectId: sharedProject.id, title: "Work evidence in a shared code project" });
    const scope = { taskId: workTask.id, executionContextId: "context_work" };
    const target = (artifact: TaskArtifact) => ({ taskId: artifact.taskId, artifactId: artifact.id, executionContextId: artifact.executionContextId });
    const upload = async (taskId: string, image: { bytes: Buffer; mime: string }, fileName = "synthetic.png") => {
      const query = new URLSearchParams({ taskId, fileName, mime: image.mime });
      const response = await harness.fetchHttp("POST", `/attachments/upload?${query}`, { body: new Uint8Array(image.bytes), headers: { "content-type": image.mime } });
      if (response.status !== 201) throw new Error("Synthetic image upload failed");
      return z.object({ attachmentId: z.string() }).parse(await response.json()).attachmentId;
    };
    const readImage = async (attachmentId: string) => {
      const response = await harness.fetchHttp("GET", `/attachments/download?${new URLSearchParams({ attachmentId })}`);
      if (response.status !== 200) throw new Error("Synthetic image is unavailable");
      return Buffer.from(await response.arrayBuffer());
    };
    const imageProof = (attachmentId: string, image: { bytes: Buffer; mime: TaskArtifactImage["mime"]; width: number; height: number }) => artifactImageSchema.parse({ attachmentId, sha256: sha256(image.bytes), width: image.width, height: image.height, mime: image.mime });
    const request = (image: TaskArtifactImage | null, options: { taskId?: string; sourceThreadId?: string; quote?: string } = {}) => taskArtifactCreateSchema.parse({
      artifactId: randomUUID(), taskId: options.taskId ?? workTask.id, executionContextId: "context_work",
      source: { threadId: options.sourceThreadId ?? "thr_work_source", eventSeq: 7, quote: options.quote ?? REVIEW_SOURCE },
      decision: REVIEW_DECISION,
      annotation: image ? { image, coordinateFrame: "decoded-image-pixels", region: { x: 0, y: 0, width: 1, height: 1 }, comment: "Change the selected pixel's control" } : null,
      retentionConfirmed: true,
    });
    const retain = async (options: { taskId?: string; sourceThreadId?: string } = {}) => {
      const original = await staticReviewImage();
      const attachmentId = await upload(options.taskId ?? workTask.id, original);
      const image = artifactImageSchema.parse(await harness.callRpc("inspectTaskArtifactImage", { ...scope, taskId: options.taskId ?? workTask.id, attachmentId }));
      const saved = taskArtifactSchema.parse(await harness.callRpc("createTaskArtifact", request(image, options)));
      return { saved, image, original };
    };
    const relocate = async (operation: "move" | "relink") => {
      if (operation === "move") {
        const result = tasksRpcContract.moveTaskToProject.output.parse(await harness.callRpc("moveTaskToProject", { taskId: workTask.id, projectId: personalProject.id }));
        if (!result.ok) throw new Error(result.error.message);
        return result.task;
      }
      await harness.callRpc("updateProject", { projectId: workProject.id, linkedBbProjectId: "proj_personal" });
      const result = tasksRpcContract.getTask.output.parse(await harness.callRpc("getTask", { taskId: workTask.id }));
      if (!result.task) throw new Error("Synthetic task disappeared");
      return result.task;
    };
    const seedHeaderOnlyHistory = async (image: TaskArtifactImage) => {
      const input = request(image);
      const saved = taskArtifactSchema.parse({ id: input.artifactId, taskId: workTask.id, bbProjectId: "proj_work", executionContextId: "context_work", source: { ...input.source, role: "assistant", textSha256: sha256(REVIEW_SOURCE) }, decision: input.decision, annotation: input.annotation, createdAt: new Date(0).toISOString() });
      return new TaskArtifactStore(store).create(saved);
    };
    const view = async (artifact: TaskArtifact) => taskArtifactViewSchema.parse(await harness.callRpc("getTaskArtifact", target(artifact)));
    return {
      bb, harness, store, contexts, threads, directory, scope, target, upload, readImage, imageProof, request, retain, relocate, seedHeaderOnlyHistory, view,
      workTask, personalTask, sharedTask, workProject, personalProject, sharedProject,
      readDownload: (name: string) => readFile(join(directory, name)),
      dispose: async () => { try { await harness.dispose(); } finally { await rm(directory, { recursive: true, force: true }); } },
    };
  } catch (error) {
    try { await harness.dispose(); } finally { await rm(directory, { recursive: true, force: true }); }
    throw error;
  }
}

export type TaskArtifactReviewFixture = Awaited<ReturnType<typeof createTaskArtifactReviewFixture>>;

export async function withTaskArtifactReviewFixture(run: (fixture: TaskArtifactReviewFixture) => Promise<void>) {
  const fixture = await createTaskArtifactReviewFixture();
  try { await run(fixture); } finally { await fixture.dispose(); }
}
