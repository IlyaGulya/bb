import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { buildReviewInspectionSchema } from "../workflow/remote-contract.js";

const id = z.string().min(1).max(200);
export const taskWorkflowLaunchSchema = z
  .object({
    taskId: id,
    preparationId: id,
  })
  .strict();
export const taskWorkflowSchema = z.object({
  id,
  taskId: id,
  revision: z.number().int().positive(),
  state: z.enum(["launching", "running", "in_review", "failed", "accepted"]),
  error: z.string().nullable(),
  native: buildReviewInspectionSchema.nullable(),
  feedback: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TaskWorkflow = z.infer<typeof taskWorkflowSchema>;
export const workflowRpcContract = defineRpcContract({
  launchTaskWorkflow: {
    input: taskWorkflowLaunchSchema,
    output: taskWorkflowSchema,
  },
  taskWorkflows: {
    input: z.object({ taskId: id }),
    output: z.object({ runs: z.array(taskWorkflowSchema) }),
  },
  acceptTaskWorkflow: {
    input: z.object({ id, revision: z.number().int().positive() }),
    output: taskWorkflowSchema,
  },
  returnTaskWorkflow: {
    input: z.object({
      id,
      revision: z.number().int().positive(),
      feedback: z.string().trim().min(1).max(100000),
    }),
    output: taskWorkflowSchema,
  },
});
export type TaskWorkflowRpcContract = typeof workflowRpcContract;
