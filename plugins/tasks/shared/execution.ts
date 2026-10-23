import { z } from "zod";
import { idSchema } from "./contract";

const nonBlank = z.string().trim().min(1);
export const executionTargetSchema = z
  .object({
    bbProjectId: z.string().startsWith("proj_"),
    hostId: nonBlank,
    workspace: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("managed-worktree"),
          baseBranch: nonBlank.optional(),
        })
        .strict(),
      z.object({ kind: z.literal("project-checkout") }).strict(),
      z
        .object({
          kind: z.literal("existing-environment"),
          environmentId: nonBlank,
        })
        .strict(),
    ]),
    presetId: idSchema,
  })
  .strict();
export type ExecutionTarget = z.infer<typeof executionTargetSchema>;

export const taskExecutionSchema = z
  .object({
    override: executionTargetSchema.nullable(),
    resolved: executionTargetSchema.nullable(),
    inherited: z.boolean(),
    summary: z.string(),
  })
  .strict();
export type TaskExecution = z.infer<typeof taskExecutionSchema>;

export const taskContinuationSchema = z
  .object({
    operationId: nonBlank,
    taskId: idSchema,
    sourceThreadId: nonBlank,
    bbProjectId: nonBlank,
    sourceEnvironmentId: nonBlank,
    targetHostId: nonBlank,
    targetPath: nonBlank,
    presetId: idSchema,
    environmentId: nonBlank,
    state: z.enum(["ready", "spawning", "started"]),
    threadId: nonBlank.nullable(),
    lastError: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict();
export type TaskContinuation = z.infer<typeof taskContinuationSchema>;
