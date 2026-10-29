import { z } from "zod";
import { captureAckSchema, captureChunkSchema, captureManifestSchema, captureOutboxStatusSchema, captureSessionSchema } from "@bb/domain";

export const captureExchangeCommandSchema = z.object({
  type: z.literal("capture.exchange"),
  session: captureSessionSchema,
  leaseUntil: z.number().int().nonnegative(),
  ack: captureAckSchema.nullable(),
  poll: z.boolean(),
}).strict();
export const captureExchangeResultSchema = z.object({
  enabled: z.boolean(),
  status: captureOutboxStatusSchema,
  manifest: captureManifestSchema.nullable(),
  chunk: captureChunkSchema.nullable(),
}).strict();
export type CaptureExchangeCommand = z.infer<typeof captureExchangeCommandSchema>;
export type CaptureExchangeResult = z.infer<typeof captureExchangeResultSchema>;
