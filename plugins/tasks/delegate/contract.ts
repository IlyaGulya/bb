import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { idSchema } from "../shared/contract";
import { executionTargetSchema, taskExecutionSchema, taskContinuationSchema } from "../shared/execution";

const threadIdSchema = z.string().startsWith("thr_");

export const delegationRpcContract = defineRpcContract({
  delegate: {
    input: z
      .object({
        taskId: idSchema,
        presetId: idSchema.optional(),
        executionTarget: executionTargetSchema.optional(),
        executionContextId: z.string().trim().min(1).optional(),
        modelConnectionId: z.string().trim().min(1).optional(),
        extraInstructions: z.string().optional(),
      })
      .strict(),
    output: z.object({ threadId: threadIdSchema }).strict(),
  },
  getTaskExecution: {
    input: z.object({ taskId: idSchema, presetId: idSchema.optional() }).strict(),
    output: taskExecutionSchema,
  },
  setTaskExecution: {
    input: z.object({ taskId: idSchema, target: executionTargetSchema.nullable() }).strict(),
    output: taskExecutionSchema,
  },
  listTaskExecutionEnvironments: {
    input: z.object({ bbProjectId: z.string().startsWith("proj_"), hostId: z.string().optional() }).strict(),
    output: z.object({ environments: z.array(z.object({ id: z.string(), hostId: z.string(), path: z.string(), name: z.string() }).strict()) }).strict(),
  },
  previewTaskContinuation: {
    input: z.object({ taskId: idSchema, sourceThreadId: threadIdSchema, targetHostId: z.string().trim().min(1) }).strict(),
    output: z.object({
      projectId: z.string(),
      sourceEnvironmentId: z.string(),
      sourceHostId: z.string(),
      head: z.string(),
      branch: z.string().nullable(),
      files: z.array(z.object({
        path: z.string(),
        kind: z.string(),
        tracked: z.boolean(),
        selectedByDefault: z.boolean(),
        excludedReason: z.string().optional(),
      }).strict()),
      activeThreadIds: z.array(z.string()),
    }).strict(),
  },
  continueTask: {
    input: z.object({
      taskId: idSchema,
      sourceThreadId: threadIdSchema,
      targetHostId: z.string().trim().min(1),
      targetPath: z.string().trim().min(1),
      presetId: idSchema,
      includePaths: z.array(z.string()),
      extraInstructions: z.string().optional(),
      branch: z.string().trim().min(1).optional(),
      operationId: z.string().trim().min(1).optional(),
    }).strict(),
    output: z.object({ threadId: threadIdSchema, operationId: z.string(), environmentId: z.string() }).strict(),
  },
  getTaskContinuations: {
    input: z.object({ taskId: idSchema }).strict(),
    output: z.object({ continuations: z.array(taskContinuationSchema) }).strict(),
  },
  taskThreadsAttach: {
    input: z.object({ taskId: idSchema, threadId: threadIdSchema }).strict(),
    output: z.object({ threadId: threadIdSchema }).strict(),
  },
  taskThreadsDetach: {
    input: z.object({ taskId: idSchema, threadId: threadIdSchema }).strict(),
    output: z.object({ threadId: threadIdSchema }).strict(),
  },
});

export type DelegationRpcContract = typeof delegationRpcContract;
