import { z } from "zod";

export const CAPTURE_CHUNK_BYTES = 262144;
export const CAPTURE_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const CAPTURE_MAX_SESSION_BYTES = 256 * 1024 * 1024;
export const CAPTURE_MAX_ARTIFACTS = 512;
export const captureDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const captureScopeSchema = z.object({
  projectId: z.string().min(1).max(256),
  executionContextId: z.string().min(1).max(256),
}).strict();
export const captureSubjectSchema = captureScopeSchema.extend({
  hostId: z.string().min(1).max(256),
  threadId: z.string().min(1).max(256).nullable(),
  runId: z.string().min(1).max(256).nullable(),
  nativeSessionId: z.string().min(1).max(256).nullable(),
  runtimeId: z.string().min(1).max(128),
  runtimeVersion: z.string().min(1).max(128).nullable(),
  modelConnectionId: z.string().min(1).max(256).nullable(),
  model: z.string().min(1).max(256).nullable(),
}).strict();
export const capturePolicySchema = z.object({
  consent: z.literal("private-full-content"),
  payloadReview: z.literal("owner-approved-sensitive-application-data"),
  retentionHours: z.number().int().min(1).max(720),
  maxBytes: z.number().int().min(CAPTURE_CHUNK_BYTES).max(CAPTURE_MAX_SESSION_BYTES),
  maxArtifacts: z.number().int().min(1).max(CAPTURE_MAX_ARTIFACTS),
  syncIntervalSeconds: z.number().int().min(30).max(3600),
  bridgeRecorder: z.boolean(),
  nativeEvents: z.boolean(),
  cpaLogs: z.boolean(),
  offlineLeaseSeconds: z.number().int().min(30).max(3600),
  nativeExports: z.array(z.object({
    sourceId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u),
    relativePath: z.string().min(1).max(1024).refine(value => value.split("/").every(part => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(part) && part !== "." && part !== "..")),
    representation: z.enum(["transcript", "raw", "binary"]),
    binaryReview: z.literal("owner-reviewed-no-auth-material"),
  }).strict()).max(8),
}).strict().superRefine((policy, ctx) => {
  if (policy.offlineLeaseSeconds < policy.syncIntervalSeconds) ctx.addIssue({ code: "custom", message: "Offline admission lease must cover the sync interval" });
  if (new Set(policy.nativeExports.map(source => source.sourceId)).size !== policy.nativeExports.length ||
      new Set(policy.nativeExports.map(source => source.relativePath)).size !== policy.nativeExports.length) {
    ctx.addIssue({ code: "custom", message: "Capture export identities and paths must be unique" });
  }
});
export const captureSessionSchema = z.object({
  id: z.string().uuid(),
  subject: captureSubjectSchema,
  policy: capturePolicySchema,
  enabled: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
}).strict();
export const captureSourceSchema = z.enum(["cpa-request-log", "bridge-recorder", "native-events", "native-transcript", "owner-import"]);
export const captureManifestSchema = z.object({
  version: z.literal(1),
  captureId: z.string().uuid(),
  artifactId: captureDigestSchema,
  source: captureSourceSchema,
  sourceId: z.string().min(1).max(512),
  hostId: z.string().min(1).max(256).nullable(),
  runId: z.string().min(1).max(256).nullable(),
  nativeSessionId: z.string().min(1).max(256).nullable(),
  models: z.array(z.string().min(1).max(256)).max(32),
  indexLimited: z.boolean(),
  destinations: z.array(z.url().max(2048).refine(value => {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash;
  })).max(32),
  transport: z.enum(["http", "sse", "websocket", "stdio", "native", "file", "unknown"]),
  requestId: z.string().min(1).max(256).nullable(),
  observedAt: z.number().int().nonnegative().nullable(),
  sourceOffset: z.number().int().nonnegative(),
  sourceBytes: z.number().int().min(1).max(CAPTURE_MAX_ARTIFACT_BYTES),
  sourceSha256: captureDigestSchema,
  storedBytes: z.number().int().min(1).max(CAPTURE_MAX_ARTIFACT_BYTES),
  storedSha256: captureDigestSchema,
  representation: z.enum(["raw", "normalized", "transcript", "binary"]),
  streamState: z.enum(["complete", "interrupted", "unknown"]),
  fidelity: z.enum(["source-bytes", "redacted-source", "normalized-source"]),
  redactionPolicy: z.enum(["headers-json-credentials-v1", "owner-reviewed-binary-v1"]),
  redacted: z.boolean(),
  payloadSecrets: z.literal("not-guaranteed"),
  chunks: z.array(z.object({
    sequence: z.number().int().min(0).max(255),
    bytes: z.number().int().min(1).max(CAPTURE_CHUNK_BYTES),
    sha256: captureDigestSchema,
  }).strict()).min(1).max(256),
}).strict().superRefine((value, ctx) => {
  if (value.chunks.some((chunk, index) => chunk.sequence !== index) ||
      value.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0) !== value.storedBytes ||
      value.chunks.slice(0, -1).some(chunk => chunk.bytes !== CAPTURE_CHUNK_BYTES)) {
    ctx.addIssue({ code: "custom", message: "Invalid contiguous capture chunk manifest" });
  }
  if ((value.representation === "binary") !== (value.redactionPolicy === "owner-reviewed-binary-v1")) {
    ctx.addIssue({ code: "custom", message: "Binary content requires explicit owner review" });
  }
  if (value.fidelity === "source-bytes" && (value.redacted || value.sourceBytes !== value.storedBytes || value.sourceSha256 !== value.storedSha256)) {
    ctx.addIssue({ code: "custom", message: "Source-byte fidelity requires identical unmodified source and stored bytes" });
  }
});
export const captureChunkSchema = z.object({
  captureId: z.string().uuid(),
  artifactId: captureDigestSchema,
  sequence: z.number().int().min(0).max(255),
  sha256: captureDigestSchema,
  base64: z.string().min(4).max(4 * Math.ceil(CAPTURE_CHUNK_BYTES / 3)),
}).strict();
export const captureAckSchema = z.object({
  captureId: z.string().uuid(),
  artifactId: captureDigestSchema,
  sequence: z.number().int().min(0).max(255),
  sha256: captureDigestSchema,
  receiptId: captureDigestSchema,
  committedAt: z.number().int().nonnegative(),
  status: z.enum(["accepted", "duplicate"]),
}).strict();
export const captureGapSchema = z.enum(["none", "source_unavailable", "source_changed", "source_limit", "quota", "disk_pressure", "storage_unavailable", "scope_denied", "host_unavailable", "integrity", "expired", "stopped", "partial_source", "lease_expired", "privacy_rejected"]);
export const captureOutboxStatusSchema = z.object({
  pendingBytes: z.number().int().nonnegative(),
  pendingChunks: z.number().int().nonnegative(),
  artifacts: z.number().int().nonnegative(),
  lastAckAt: z.number().int().nonnegative().nullable(),
  gap: captureGapSchema,
  droppedBytes: z.number().int().nonnegative(),
}).strict();
export type CaptureScope = z.infer<typeof captureScopeSchema>;
export type CaptureSubject = z.infer<typeof captureSubjectSchema>;
export type CapturePolicy = z.infer<typeof capturePolicySchema>;
export type CaptureSession = z.infer<typeof captureSessionSchema>;
export type CaptureManifest = z.infer<typeof captureManifestSchema>;
export type CaptureChunk = z.infer<typeof captureChunkSchema>;
export type CaptureAck = z.infer<typeof captureAckSchema>;
export type CaptureGap = z.infer<typeof captureGapSchema>;
export type CaptureOutboxStatus = z.infer<typeof captureOutboxStatusSchema>;
