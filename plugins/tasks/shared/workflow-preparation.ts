import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { buildReviewStartSchema } from "../workflow/remote-contract.js";

const id = z.string().min(1).max(200);
export const workflowTemplateSchema = z.enum(["development-review", "bugfix"]);
export const WORKFLOW_TEMPLATES = [
  { id: "development-review", name: "Development with review", description: "Plan → build → platform smoke → independent review → human review" },
  { id: "bugfix", name: "Bug fix", description: "Reproduce → fix and regression → platform smoke → independent review → human review" },
] as const;
const draftRoleSchema = buildReviewStartSchema.shape.writer.extend({ provider: z.string().max(200), model: z.string().max(1000), reasoningLevel: z.string().max(200), executionContextId: z.string().max(200), modelConnectionId: z.string().max(200) });
export const workflowSelectionSchema = z.object({
  template: workflowTemplateSchema,
  hostId: id.nullable(),
  baseBranch: z.string().trim().max(300),
  writer: draftRoleSchema.nullable(),
  reviewer: draftRoleSchema.nullable(),
  smokeCommands: z.array(z.string().trim().min(1).max(4000)).max(30),
  uiRequired: z.boolean(),
}).strict();
export type WorkflowSelection = z.infer<typeof workflowSelectionSchema>;
export const EMPTY_WORKFLOW_ROLE: NonNullable<WorkflowSelection["writer"]> = { provider: "", model: "", executionContextId: "", modelConnectionId: "", reasoningLevel: "medium", permissionMode: "auto", serviceTier: null, instructions: "" };
export const workflowDraftSchema = z.object({
  taskId: id,
  revision: z.number().int().nonnegative(),
  selection: workflowSelectionSchema,
  updatedAt: z.string(),
});
export type WorkflowDraft = z.infer<typeof workflowDraftSchema>;
export const workflowPreparationSchema = z.object({
  id,
  taskId: id,
  projectId: id,
  selection: workflowSelectionSchema,
  state: z.enum(["reserved", "creating", "preparing", "ready", "failed", "uncertain"]),
  threadId: id.nullable(),
  environmentId: id.nullable(),
  reviewerThreadId: id.nullable(),
  error: z.string().nullable(),
  progress: z.string(),
  workspacePath: z.string().nullable(),
  branch: z.string().nullable(),
  head: z.string().nullable(),
});
export type WorkflowPreparation = z.infer<typeof workflowPreparationSchema>;
export const workflowSetupContract = defineRpcContract({
  getTaskWorkflowProject: { input: z.object({ taskId: id }), output: z.object({ id, name: z.string() }).nullable() },
  getTaskWorkflowDraft: { input: z.object({ taskId: id }), output: workflowDraftSchema },
  saveTaskWorkflowDraft: {
    input: z.object({ taskId: id, revision: z.number().int().nonnegative(), selection: workflowSelectionSchema }).strict(),
    output: workflowDraftSchema,
  },
  getProjectWorkflowSettings: {
    input: z.object({ taskId: id, template: workflowTemplateSchema }),
    output: z.object({ revision: z.number().int().nonnegative(), selection: workflowSelectionSchema.nullable() }),
  },
  saveProjectWorkflowSettings: {
    input: z.object({ taskId: id, revision: z.number().int().nonnegative(), selection: workflowSelectionSchema }).strict(),
    output: z.object({ revision: z.number().int().positive(), selection: workflowSelectionSchema }),
  },
  prepareTaskWorkflow: {
    input: z.object({ taskId: id, revision: z.number().int().positive() }).strict(),
    output: workflowPreparationSchema,
  },
  getTaskWorkflowPreparation: {
    input: z.object({ taskId: id }),
    output: workflowPreparationSchema.nullable(),
  },
});
export type WorkflowSetupContract = typeof workflowSetupContract;
