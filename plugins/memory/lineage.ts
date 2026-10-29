import { z } from "zod";
import { idSchema } from "../tasks/shared/contract.js";

export const taskScopeSchema = z.object({
  taskId: idSchema,
  context: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/),
}).strict();
export type TaskScope = z.infer<typeof taskScopeSchema>;

export const memorySelectionSchema = z.object({
  projectId: z.string().startsWith("proj_").nullable(),
  task: taskScopeSchema.nullable(),
}).strict().refine((value) => value.task === null || value.projectId !== null, {
  message: "Task memory requires a Core project",
});
export type MemorySelection = z.infer<typeof memorySelectionSchema>;

export const memoryLinkSchema = z.object({
  id: z.string().min(1).max(100),
  version: z.number().int().positive(),
}).strict();

export const sourceSelectionSchema = z.object({
  kind: z.enum(["task", "comment"]),
  commentId: idSchema.nullable(),
  revision: z.string().min(1).max(80),
  observedAt: z.number().int().nonnegative(),
  quote: z.string().max(600),
}).strict().refine((value) => (value.kind === "comment") === (value.commentId !== null), {
  message: "Only comment sources require a comment identifier",
});

export const lineageSchema = z.object({
  taskKey: z.string().regex(/^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]*$/),
  classification: z.enum(["observation", "decision", "assumption"]),
  state: z.enum(["current", "obsolete", "replaced"]),
  source: sourceSelectionSchema,
  replaces: memoryLinkSchema.nullable(),
  replacedBy: memoryLinkSchema.nullable(),
}).strict().refine((value) => (value.state === "replaced") === (value.replacedBy !== null), {
  message: "Replaced records require their replacement revision",
});
export type MemoryLineage = z.infer<typeof lineageSchema>;

export const taskMemoryDraftSchema = z.object({
  name: z.string().min(1).max(80),
  summary: z.string().min(1).max(400),
  details: z.string().min(1).max(16000),
  classification: z.enum(["observation", "decision", "assumption"]),
  source: sourceSelectionSchema,
  reason: z.string().min(1).max(500),
  replaces: memoryLinkSchema.nullable(),
}).strict();

export const reflectionChangeSchema = z.object({
  id: z.string().min(1).max(100),
  expectedVersion: z.number().int().positive(),
  summary: z.string().min(1).max(400),
  details: z.string().min(1).max(16000),
  classification: z.enum(["observation", "decision", "assumption"]),
  state: z.enum(["current", "obsolete"]),
  source: sourceSelectionSchema,
  reason: z.string().min(1).max(500),
}).strict();
export type ReflectionChange = z.infer<typeof reflectionChangeSchema>;

export const reflectionDiffSchema = z.object({
  before: z.object({
    id: z.string(), version: z.number().int().positive(), summary: z.string(),
    details: z.string(), lineage: lineageSchema,
  }).strict(),
  after: reflectionChangeSchema,
}).strict();
export const reflectionProposalSchema = z.object({
  id: z.string(),
  selection: memorySelectionSchema,
  state: z.enum(["pending", "applied", "rejected"]),
  createdAt: z.number().int().nonnegative(),
  decidedAt: z.number().int().nonnegative().nullable(),
  diffs: z.array(reflectionDiffSchema).min(1).max(20),
}).strict();
export type ReflectionProposal = z.infer<typeof reflectionProposalSchema>;

export const bindingStateSchema = z.object({
  version: z.number().int().nonnegative(),
  tasks: z.array(taskScopeSchema).max(20),
}).strict();
