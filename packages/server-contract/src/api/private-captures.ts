import { z } from "zod";
import {
  captureScopeSchema, capturePolicySchema, captureSubjectSchema, captureSessionSchema,
  captureManifestSchema, captureChunkSchema, captureAckSchema, captureGapSchema, captureOutboxStatusSchema,
} from "@bb/domain";

export const captureCreateSchema = captureSubjectSchema.extend({
  id: z.string().uuid(),
  policy: capturePolicySchema,
}).strict();
export const captureListQuerySchema = captureScopeSchema.extend({
  threadId: z.string().min(1).max(256).optional(),
  hostId: z.string().min(1).max(256).optional(),
  model: z.string().min(1).max(256).optional(),
  runtimeId: z.string().min(1).max(128).optional(),
  nativeSessionId: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  after: z.string().uuid().optional(),
}).strict();
export const captureQuerySchema = captureScopeSchema;
export const captureManifestRequestSchema = captureScopeSchema.extend({ manifest: captureManifestSchema }).strict();
export const captureChunkRequestSchema = captureScopeSchema.extend({ chunk: captureChunkSchema }).strict();
export const captureLinkRequestSchema = captureScopeSchema.extend({ threadId: z.string().min(1).max(256), runId: z.string().min(1).max(256).nullable() }).strict();
export const captureArtifactQuerySchema = captureScopeSchema.extend({
  source: captureManifestSchema.shape.source.optional(),
  destination: z.string().min(1).max(2048).optional(),
  hostId: z.string().min(1).max(256).optional(),
  runId: z.string().min(1).max(256).optional(),
  nativeSessionId: z.string().min(1).max(256).optional(),
  model: z.string().min(1).max(256).optional(),
  after: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();
export const captureViewSchema = z.object({
  session: captureSessionSchema,
  lastSyncAt: z.number().nullable(),
  lastAckAt: z.number().nullable(),
  gap: captureGapSchema,
  gapCount: z.number().int().nonnegative(),
  storedBytes: z.number().int().nonnegative(),
  committedChunks: z.number().int().nonnegative(),
  pendingBytes: z.number().int().nonnegative(),
  pendingChunks: z.number().int().nonnegative(),
  host: captureOutboxStatusSchema.nullable(),
  hostEnabled: z.boolean().nullable(),
  links: z.array(z.object({ threadId: z.string(), runId: z.string().nullable(), createdAt: z.number(), provenance: z.literal("owner-association") }).strict()),
  outcome: z.enum(["accepted", "succeeded", "failed"]),
  coverage: z.array(z.object({
    source: z.string(),
    state: z.enum(["captured", "metadata-only", "unsupported", "uninstrumented"]),
    evidence: z.string(),
  }).strict()),
}).strict();
export const captureArtifactViewSchema = z.object({
  manifest: captureManifestSchema,
  completedAt: z.number().nullable(),
  rejectedAt: z.number().nullable(),
  outcome: z.enum(["accepted", "succeeded", "failed"]),
  committedSequences: z.array(z.number().int().nonnegative()),
}).strict();
export type CaptureCreate = z.infer<typeof captureCreateSchema>;
export type CaptureLinkRequest = z.infer<typeof captureLinkRequestSchema>;
export type CaptureListQuery = z.infer<typeof captureListQuerySchema>;
export type CaptureArtifactQuery = z.infer<typeof captureArtifactQuerySchema>;
export type CaptureView = z.infer<typeof captureViewSchema>;
export type CaptureArtifactView = z.infer<typeof captureArtifactViewSchema>;
export type CaptureAckResponse = z.infer<typeof captureAckSchema>;

export const capturePreviewQuerySchema = captureScopeSchema.extend({ previewBytes: z.coerce.number().int().min(1).max(262144).default(65536) }).strict();
export const capturePreviewSchema = z.object({
  artifactId: z.string(),
  raw: z.string(),
  encoding: z.enum(["utf8", "base64"]),
  truncated: z.boolean(),
  previewBytes: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
  storedSha256: z.string(),
}).strict();
export type CapturePreviewQuery = z.infer<typeof capturePreviewQuerySchema>;
export type CapturePreview = z.infer<typeof capturePreviewSchema>;
