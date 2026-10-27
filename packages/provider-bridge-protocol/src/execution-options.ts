import {
  executionContextSnapshotSchema,
  modelConnectionSnapshotSchema,
  promptModeSchema,
  reasoningLevelSchema,
  runtimePermissionPolicySchema,
  sessionOptionSelectionsSchema,
  serviceTierSchema,
} from "@bb/domain";
import { z } from "zod";

export const bridgeProviderOptionsSchema = z
  .object({
    executionContext: executionContextSnapshotSchema.nullable().optional(),
    modelConnection: modelConnectionSnapshotSchema.nullable().optional(),
  })
  .catchall(z.unknown());

export const bridgeExecutionOptionsSchema = z
  .object({
    model: z.string().min(1).optional(),
    serviceTier: serviceTierSchema.optional(),
    reasoningLevel: reasoningLevelSchema.optional(),
    promptMode: promptModeSchema.optional(),
    sessionOptions: sessionOptionSelectionsSchema.optional(),
    instructions: z.string().optional(),
    envVars: z.record(z.string(), z.string()).optional(),
    providerOptions: bridgeProviderOptionsSchema.optional(),
  })
  .and(runtimePermissionPolicySchema);

export type BridgeExecutionOptions = z.infer<
  typeof bridgeExecutionOptionsSchema
>;
