import { z } from "zod";
import { nativeDiscoverSchema, nativeSessionSourceSchema } from "@bb/host-daemon-contract";

export const nativeImportDiscoverSchema = nativeDiscoverSchema.extend({ hostId: z.string().min(1) }).strict();
export const nativeImportPreviewSchema = z.object({ hostId: z.string().min(1), source: nativeSessionSourceSchema, offset: z.number().int().nonnegative(), length: z.number().int().min(1).max(256 * 1024) }).strict();
export const nativeImportThreadSchema = z.object({ threadId: z.string().min(1) }).strict();
export const nativeImportFileSchema = z.object({ importId: z.string().regex(/^[a-f0-9]{64}$/), file: z.string().regex(/^(?:native|artifact-[a-f0-9]{64})$/) }).strict();
export const nativeImportSelectionSchema = z.object({
  hostId: z.string().min(1),
  projectId: z.string().min(1),
  source: nativeSessionSourceSchema,
}).strict();
export const nativeImportStartSchema = z.object({ selections: z.array(nativeImportSelectionSchema).min(1).max(100) }).strict();
export const nativeImportIdSchema = z.object({ importId: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const nativeImportPageSchema = nativeImportIdSchema.extend({
  after: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(100),
  query: z.string().max(1024),
}).strict();
export const nativeImportBytesSchema = nativeImportIdSchema.extend({
  file: z.string().regex(/^(?:native|artifact-[a-f0-9]{64})$/),
  offset: z.number().int().nonnegative(),
  length: z.number().int().min(1).max(256 * 1024),
}).strict();
export const nativeImportContinueSchema = nativeImportIdSchema.extend({
  environmentId: z.string().min(1),
  executionContextId: z.string().min(1).nullable(),
  modelConnectionId: z.string().min(1),
  model: z.string().min(1),
  permissionMode: z.enum(["accept-edits", "auto", "full"]),
}).strict();
export const nativeImportHandoffSchema = nativeImportContinueSchema.extend({ input: z.string().min(1).max(100_000) }).strict();
export const nativeImportManifestSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  hostId: z.string(),
  projectId: z.string(),
  source: nativeSessionSourceSchema,
  threadId: z.string().nullable(),
  status: z.enum(["paused", "importing", "ready", "cancelled", "failed"]),
  mode: z.enum(["archive", "native-admitted", "new-handoff"]),
  continuationThreadId: z.string().nullable(),
  reason: z.string(),
  error: z.string().nullable(),
  bytes: z.number().int().nonnegative(),
  records: z.number().int().nonnegative(),
  nextSequence: z.number().int().positive(),
  sha256: z.string().nullable(),
  boundaryBytes: z.number().int().nonnegative(),
  boundarySha256: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  artifacts: z.array(z.object({
    reference: z.string(), recordOrdinal: z.number().int().positive(), file: z.string(), bytes: z.number().int().nonnegative(), sha256: z.string().nullable(),
    status: z.enum(["ready", "unavailable"]), reason: z.string().nullable(),
  }).strict()),
}).strict();
export const nativeImportRecordSchema = z.object({
  ordinal: z.number(), offset: z.number(), length: z.number(), sha256: z.string(),
  nativeId: z.string().nullable(), parentId: z.string().nullable(), type: z.string(),
  timestamp: z.number().nullable(), sourceSeqStart: z.number(), sourceSeqEnd: z.number(),
  preview: z.string(), artifactReferences: z.array(z.string()),
}).strict();
export const nativeImportPageResponseSchema = z.object({
  records: z.array(nativeImportRecordSchema), nextAfter: z.number().nullable(),
}).strict();
export type NativeImportSelection = z.infer<typeof nativeImportSelectionSchema>;
export type NativeImportStart = z.infer<typeof nativeImportStartSchema>;
export type NativeImportManifest = z.infer<typeof nativeImportManifestSchema>;
export type NativeImportRecord = z.infer<typeof nativeImportRecordSchema>;
export type NativeImportPage = z.infer<typeof nativeImportPageSchema>;
export type NativeImportPageResponse = z.infer<typeof nativeImportPageResponseSchema>;
export type NativeImportBytes = z.infer<typeof nativeImportBytesSchema>;
export type NativeImportContinue = z.infer<typeof nativeImportContinueSchema>;
export type NativeImportHandoff = z.infer<typeof nativeImportHandoffSchema>;
export interface NativeImportBatch {
  imports: NativeImportManifest[];
  failures: { index: number; message: string }[];
}
