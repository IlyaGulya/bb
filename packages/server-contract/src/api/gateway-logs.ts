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
