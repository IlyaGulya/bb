import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { idSchema } from "./contract.js";

const contextId = z.string().trim().min(1).max(200);
const threadId = z.string().regex(/^thr_[A-Za-z0-9_-]+$/);
const dimension = z.number().int().positive().max(32768);
export const artifactRegionSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: dimension,
  height: dimension,
}).strict();
export const artifactImageSchema = z.object({
  attachmentId: idSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  width: dimension,
  height: dimension,
  mime: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
}).strict();
export const artifactAnnotationSchema = z.object({
  image: artifactImageSchema,
  coordinateFrame: z.literal("decoded-image-pixels"),
  region: artifactRegionSchema,
  comment: z.string().trim().min(1).max(4000),
}).strict().superRefine((value, ctx) => {
  if (value.region.x + value.region.width > value.image.width ||
      value.region.y + value.region.height > value.image.height) {
    ctx.addIssue({ code: "custom", path: ["region"], message: "Selection must be inside the original image" });
  }
});
const sourceInput = z.object({
  threadId,
  eventSeq: z.number().int().nonnegative().safe(),
  quote: z.string().trim().min(1).max(4000),
}).strict();
const scope = z.object({ taskId: idSchema, executionContextId: contextId }).strict();
const target = scope.extend({ artifactId: z.uuid() }).strict();
export const taskArtifactCreateSchema = scope.extend({
  artifactId: z.uuid(),
  source: sourceInput,
  decision: z.string().trim().min(1).max(4000),
  annotation: artifactAnnotationSchema.nullable(),
  retentionConfirmed: z.literal(true),
}).strict();
export const taskArtifactSchema = z.object({
  id: z.uuid(),
  taskId: idSchema,
  bbProjectId: z.string().min(1),
  executionContextId: contextId,
  source: sourceInput.extend({
    role: z.enum(["user", "assistant"]),
    textSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  decision: z.string().trim().min(1).max(4000),
  annotation: artifactAnnotationSchema.nullable(),
  createdAt: z.iso.datetime(),
}).strict();
export const taskArtifactViewSchema = z.object({
  artifact: taskArtifactSchema,
  sourceStatus: z.enum(["available", "archived", "deleted", "changed", "unavailable"]),
  sourceUrl: z.string().nullable(),
}).strict();
export const taskArtifactRpcContract = defineRpcContract({
  taskArtifactTargets: {
    input: z.object({ threadId, search: z.string().trim().max(200) }).strict(),
    output: z.object({
      executionContextId: contextId,
      contextName: z.string(),
      tasks: z.array(z.object({ id: idSchema, key: z.string(), title: z.string() }).strict()),
    }).strict(),
  },
  inspectTaskArtifactImage: {
    input: scope.extend({ attachmentId: idSchema }).strict(),
    output: artifactImageSchema,
  },
  createTaskArtifact: { input: taskArtifactCreateSchema, output: taskArtifactSchema },
  listTaskArtifacts: { input: scope, output: z.array(taskArtifactSchema) },
  getTaskArtifact: { input: target, output: taskArtifactViewSchema },
  deleteTaskArtifact: { input: target, output: z.object({ deleted: z.boolean() }).strict() },
});
export type TaskArtifact = z.infer<typeof taskArtifactSchema>;
export type TaskArtifactAnnotation = z.infer<typeof artifactAnnotationSchema>;
export type TaskArtifactImage = z.infer<typeof artifactImageSchema>;
export type TaskArtifactView = z.infer<typeof taskArtifactViewSchema>;
export type TaskArtifactCreate = z.infer<typeof taskArtifactCreateSchema>;
export type TaskArtifactRpcContract = typeof taskArtifactRpcContract;

export function artifactSourceUrl(artifact: Pick<TaskArtifact, "source" | "bbProjectId">): string {
  const project = artifact.bbProjectId === "proj_personal" ? "" : `/projects/${encodeURIComponent(artifact.bbProjectId)}`;
  return `${project}/threads/${encodeURIComponent(artifact.source.threadId)}#msg=${artifact.source.eventSeq}`;
}

