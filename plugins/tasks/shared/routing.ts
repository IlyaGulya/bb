import { defineRpcContract, experimental_taskRouteDecisionSchema } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { inboxEntrySchema } from "./inbox-contract.js";
import { executionTargetSchema } from "./execution.js";
import { workflowSelectionSchema } from "./workflow-preparation.js";

const id = z.string().trim().min(1).max(200);
export const LOCAL_AWAY_BOUNDARY = "Local-action away only: preview, link/create a native task, save an execution target or workflow draft within an explicit grant. No thread send, native execution, workspace preparation, external/Jira/production/governance action or Accept. Action-attempt limits are not physical model-call limits. No automatic queue or grant renewal. This grant governs routing actions only; it does not sandbox existing native sessions, full-access tools or full-trust plugins.";
export const localRouteActionSchema = z.enum(["preview", "link", "create", "target", "workflow-draft"]);
const knownRouteActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("link") }).strict(),
  z.object({ kind: z.literal("create") }).strict(),
  z.object({ kind: z.literal("target"), target: executionTargetSchema.nullable() }).strict(),
  z.object({ kind: z.literal("workflow-draft"), draftRevision: z.number().int().nonnegative(), selection: workflowSelectionSchema }).strict(),
  z.object({ kind: z.enum(["native", "external", "irreversible", "production", "governance", "jira", "accept", "unknown"]), reason: z.string().trim().min(1).max(2000) }).strict(),
]);
export const routeActionSchema = z.preprocess(input => {
  const parsed = knownRouteActionSchema.safeParse(input);
  return parsed.success ? parsed.data : { kind: "unknown", reason: "Unrecognized routing action shape. No fields were interpreted as execution authority and no effect was performed." };
}, knownRouteActionSchema);
export type RouteAction = z.infer<typeof routeActionSchema>;
export const routeProposalSchema = z.object({
  id,
  revision: z.number().int().positive(),
  sourceRevision: id,
  snapshot: id,
  decision: experimental_taskRouteDecisionSchema,
  candidates: z.array(z.object({ id, key: z.string(), title: z.string(), projectId: id })),
  projects: z.array(z.object({ id, name: z.string() })),
  taskId: id.nullable(),
  taskKey: z.string().nullable(),
  threadId: id.nullable(),
  workerThreadIds: z.array(id),
  owner: z.enum(["none", "ordinary", "managed", "prepared", "unavailable"]),
  ownerReason: z.string(),
  target: executionTargetSchema.nullable(),
  targetSummary: z.string(),
  targetIssue: z.string().nullable(),
  callbackInvocations: z.union([z.literal(0), z.literal(1)]),
  classifierService: z.string().nullable(),
  limitation: z.string(),
});
export type RouteProposal = z.infer<typeof routeProposalSchema>;
export const localAwayGrantSchema = z.object({
  id, projectId: id, inboxIds: z.array(id), taskIds: z.array(id), actions: z.array(localRouteActionSchema),
  expiresAt: z.number().int(), maxAttempts: z.number().int(), attempts: z.number().int(),
  revokedAt: z.number().int().nullable(), createdAt: z.number().int(),
  state: z.enum(["active", "revoked", "expired", "exhausted"]),
});
export type LocalAwayGrant = z.infer<typeof localAwayGrantSchema>;
export const routeOutcomeSchema = z.object({
  state: z.enum(["applied", "parked"]), reason: z.string(),
  proposal: routeProposalSchema.nullable(), item: inboxEntrySchema.nullable(),
});
export type RouteOutcome = z.infer<typeof routeOutcomeSchema>;
export const routeJournalSchema = z.object({
  operationId: id, grantId: id.nullable(), kind: z.string(), state: z.enum(["reserved", "applied", "parked"]),
  reason: z.string(), createdAt: z.number().int(), finishedAt: z.number().int().nullable(),
  callbackState: z.enum(["none", "requested", "invoked", "not-invoked"]),
});
const attempt = { id, operationId: id, grantId: id.nullable() };
export const routingRpcContract = defineRpcContract({
  getInboxRoute: {
    input: z.object({ id }).strict(),
    output: z.object({ source: inboxEntrySchema, proposal: routeProposalSchema.nullable(), stale: z.boolean(), grants: z.array(localAwayGrantSchema), journal: z.array(routeJournalSchema), boundary: z.string() }),
  },
  previewInboxRoute: {
    input: z.object({ ...attempt, sourceRevision: id, expectedRevision: z.number().int().nonnegative(), projectId: id.nullable(), taskRef: z.string().trim().max(200), newTask: z.boolean(), semantic: z.boolean() }).strict(),
    output: routeOutcomeSchema,
  },
  applyInboxRoute: {
    input: z.object({ ...attempt, expectedRevision: z.number().int().positive(), action: routeActionSchema }).strict(),
    output: routeOutcomeSchema,
  },
  enableLocalAway: {
    input: z.object({ operationId: id, projectId: id, inboxIds: z.array(id).min(1).max(20), taskIds: z.array(id).max(20), actions: z.array(localRouteActionSchema).min(1).max(5), maxAttempts: z.number().int().min(1).max(100), durationSeconds: z.number().int().min(1).max(3600), acknowledgedBoundary: z.literal(true) }).strict(),
    output: localAwayGrantSchema,
  },
  revokeLocalAway: { input: z.object({ id }).strict(), output: localAwayGrantSchema },
});
export type RoutingRpcContract = typeof routingRpcContract;
