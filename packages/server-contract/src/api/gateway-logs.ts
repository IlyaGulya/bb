import { z } from "zod";

export const gatewayLogListQuerySchema = z.object({
  threadId: z.string().min(1).max(256),
});
export const gatewayLogDownloadQuerySchema = gatewayLogListQuerySchema;
export const gatewayLogReadQuerySchema = gatewayLogListQuerySchema.extend({
  previewBytes: z.coerce.number().int().min(1).max(262144).default(65536),
});

export const gatewayLogEntrySchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  sizeBytes: z.number().int().nonnegative(),
});
export const gatewayLogListSchema = z.object({
  entries: z.array(gatewayLogEntrySchema),
  scanTruncated: z.boolean(),
  unavailableFiles: z.number().int().nonnegative(),
});
export const gatewayLogPreviewSchema = z.object({
  id: z.string(),
  raw: z.string(),
  truncated: z.boolean(),
  sizeBytes: z.number().int().nonnegative(),
  previewBytes: z.number().int().nonnegative(),
});

export type GatewayLogListQuery = z.infer<typeof gatewayLogListQuerySchema>;
export type GatewayLogReadQuery = z.infer<typeof gatewayLogReadQuerySchema>;
export type GatewayLogEntry = z.infer<typeof gatewayLogEntrySchema>;
export type GatewayLogList = z.infer<typeof gatewayLogListSchema>;
export type GatewayLogPreview = z.infer<typeof gatewayLogPreviewSchema>;

export const gatewayLogCoverageSchema = z.object({
  evidence: z.literal("source-contract-only"),
  threadId: z.string(),
  executionContextId: z.string().nullable(),
  modelConnectionId: z.string().nullable(),
  providerId: z.string().nullable(),
  sources: z.array(z.object({
    source: z.enum(["cpa-request-log", "bridge-recorder", "native-events", "native-transcript", "bypass-network", "standalone", "stdio-mcp", "local-tools"]),
    state: z.enum(["captured", "metadata-only", "unsupported", "uninstrumented"]),
    representation: z.enum(["raw", "normalized", "transcript", "unknown"]),
    reason: z.string(),
  }).strict()),
  delivery: z.object({
    state: z.literal("uninstrumented"),
    lastSyncAt: z.null(),
    lastAckAt: z.null(),
    backlogBytes: z.null(),
    backlogEvents: z.null(),
    reason: z.string(),
  }).strict(),
  privacy: z.object({
    scope: z.literal("execution-context"),
    redaction: z.literal("unverified"),
    retention: z.literal("source-owned"),
    authorization: z.literal("existing-owner-api"),
  }).strict(),
}).strict();

export type GatewayLogCoverage = z.infer<typeof gatewayLogCoverageSchema>;

export const gatewayLogManifestSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  source: z.literal("cpa-request-log"),
  representation: z.literal("raw"),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  integrity: z.literal("retained-file-only"),
  completeness: z.literal("unverified"),
  redaction: z.literal("unverified"),
  deliveryAck: z.null(),
}).strict();

export type GatewayLogManifest = z.infer<typeof gatewayLogManifestSchema>;
