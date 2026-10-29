import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const text = z.string().trim().min(1).max(100000);
const commit = z.string().regex(/^[a-f0-9]{40,64}$/);
const attachmentId = z.string().trim().min(1).max(200);
export const evidencePolicySchema = z.object({
  version: z.literal(1),
  requirement: z.enum(["technical", "ui", "video"]),
}).strict();
export const uiEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("screenshot"), location: text, description: text }).strict(),
  z.object({ kind: z.literal("preview"), location: text, description: text }).strict(),
  z.object({
    kind: z.literal("video"),
    attachmentId,
    description: text,
    recording: z.object({
      commit,
      runId: text,
      scenario: text,
      sourceAttachmentId: attachmentId,
      transformation: text.nullable(),
    }).strict(),
  }).strict(),
]);
export const buildReviewProfileSchema = z
  .object({
    provider: text,
    model: text,
    executionContextId: z.string().trim().min(1).optional(),
    modelConnectionId: z.string().trim().min(1).optional(),
    reasoningLevel: text,
    permissionMode: z.enum(["auto", "accept-edits", "full"]),
    serviceTier: text.nullable(),
    instructions: z.string().max(100000),
  })
  .strict();
export const buildEvidenceSchema = z
  .object({
    branch: text,
    commit,
    diff: text,
    regressionCommand: text.optional(),
    commands: z
      .array(
        z
          .object({ command: text, exitCode: z.number().int(), output: text })
          .strict(),
      )
      .min(1),
    uiEvidence: z.array(uiEvidenceSchema),
    limitations: z.array(text),
    nextDecision: text,
  })
  .strict();
export const buildReviewResultSchema = z
  .object({
    plan: text,
    build: buildEvidenceSchema,
    review: z
      .object({
        verdict: z.enum(["ready", "changes_requested"]),
        findings: z.array(text),
        summary: text,
      })
      .strict(),
  })
  .strict();
export const buildReviewStartSchema = z
  .object({
    key: z.string().min(1).max(200),
    group: z.string().min(1).max(200),
    projectId: text,
    originThreadId: text,
    task: text,
    template: z.enum(["development-review", "bugfix"]).default("development-review"),
    writer: buildReviewProfileSchema,
    reviewer: buildReviewProfileSchema,
    smokeCommands: z.array(text).min(1).max(30),
    uiRequired: z.boolean(),
    evidencePolicy: evidencePolicySchema.optional(),
    evidenceTaskId: attachmentId.optional(),
    feedback: z.string().max(100000),
  })
  .strict();
export type BuildReviewStart = z.infer<typeof buildReviewStartSchema>;
export type BuildReviewResult = z.infer<typeof buildReviewResultSchema>;
export function evidenceRequirement(input: { uiRequired: boolean; evidencePolicy?: z.infer<typeof evidencePolicySchema> }): "technical" | "ui" | "video" {
  return input.evidencePolicy?.requirement ?? (input.uiRequired ? "ui" : "technical");
}
export function assertBuildEvidencePolicy(input: { uiRequired: boolean; evidencePolicy?: z.infer<typeof evidencePolicySchema> }, build: z.infer<typeof buildEvidenceSchema>): void {
  const requirement = evidenceRequirement(input);
  if (requirement === "video" && !build.uiEvidence.some(evidence => evidence.kind === "video"))
    throw new Error("Video is required: attach a real recording to this task. Screenshot, preview and local paths are not substitutes; unavailable safe recording is a blocker.");
  if (requirement === "ui" && build.uiEvidence.length === 0)
    throw new Error("UI screenshot or preview evidence is required");
  for (const evidence of build.uiEvidence) {
    if (evidence.kind !== "video") continue;
    if (evidence.recording.commit !== build.commit)
      throw new Error("Video recording must identify the exact reviewed commit");
    if (evidence.recording.transformation === null && evidence.recording.sourceAttachmentId !== evidence.attachmentId)
      throw new Error("An edited recording must disclose its transformation and original attachment");
    if (evidence.recording.transformation !== null && evidence.recording.sourceAttachmentId === evidence.attachmentId)
      throw new Error("An edited recording must retain a separate original attachment");
  }
}
export const taskBuildEvidenceContract = defineRpcContract({
  validateTaskBuildEvidence: {
    input: z.object({ taskId: attachmentId, uiRequired: z.boolean(), evidencePolicy: evidencePolicySchema.optional(), build: buildEvidenceSchema }).strict(),
    output: z.object({ verified: z.literal(true) }).strict(),
  },
});
export const buildReviewInspectionSchema = z.object({
  runId: z.string(),
  key: z.string(),
  contextStarted: z.boolean().default(true),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  phase: z.string().nullable(),
  error: z.string().nullable(),
  result: buildReviewResultSchema.nullable(),
  evidencePolicy: evidencePolicySchema.optional(),
  uiRequired: z.boolean().optional(),
  workers: z.array(
    z.object({
      threadId: z.string(),
      role: z.enum(["writer", "reviewer"]),
      callIndex: z.number().int(),
    }),
  ),
  policyLimitations: z.array(z.string()),
});
export const buildReviewRpcContract = defineRpcContract({
  startBuildReview: {
    input: buildReviewStartSchema,
    output: buildReviewInspectionSchema,
  },
  inspectBuildReview: {
    input: z.object({ key: text }),
    output: buildReviewInspectionSchema.nullable(),
  },
  releaseBuildReviewContexts: {
    input: z.object({ groups: z.array(z.string().min(1).max(200)).min(1) }),
    output: z.object({ released: z.boolean() }),
  },
});
export const BUILD_REVIEW_POLICY_LIMITATIONS = [
  "Provider-native tools are governed by the selected provider permission mode. BB does not expose an OS read-only sandbox or a denylist for those tools here; reviewer instructions are not a security boundary.",
  "Workflows grants only its structured-result plugin tool to workers. Other installed plugin and native-provider tools remain subject to their own policy. No external publication or automatic human acceptance is part of this workflow.",
];
