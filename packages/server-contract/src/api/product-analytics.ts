import { productAnalyticsModeSchema } from "@bb/domain";
export { productAnalyticsModeSchema } from "@bb/domain";
import { z } from "zod";

export const PRODUCT_ANALYTICS_VERSION = 1;
export const productAnalyticsActorSchema = z.enum(["human", "agent", "system", "unknown"]);
export const productAnalyticsSurfaceSchema = z.enum(["web", "compact", "mobile", "desktop", "cli", "sdk", "agent", "mcp", "api", "system"]);
export const productAnalyticsOutcomeSchema = z.enum(["none", "succeeded", "failed", "denied", "cancelled", "unavailable", "accepted"]);
export const productAnalyticsStageSchema = z.enum(["exposed", "opened", "started", "completed"]);
export const productAnalyticsErrorSchema = z.enum(["none", "invalid", "forbidden", "not_found", "conflict", "unavailable", "cancelled", "internal"]);
const identifier = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,119}$/);
export const productAnalyticsScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("instance") }).strict(),
  z.object({ kind: z.literal("project"), projectId: z.string().regex(/^proj_[a-zA-Z0-9_-]{1,100}$/) }).strict(),
]);
export const productAnalyticsEventSchema = z.object({
  operationId: z.string().uuid(),
  featureId: identifier,
  action: identifier,
  version: z.literal(PRODUCT_ANALYTICS_VERSION),
  scope: productAnalyticsScopeSchema,
  actorKind: productAnalyticsActorSchema,
  actorSessionId: z.string().uuid().nullable(),
  surface: productAnalyticsSurfaceSchema,
  mode: productAnalyticsModeSchema,
  stage: productAnalyticsStageSchema,
  outcome: productAnalyticsOutcomeSchema,
  errorCode: productAnalyticsErrorSchema,
  timestamp: z.number().int().nonnegative(),
  durationMs: z.number().int().min(0).max(86_400_000).nullable(),
}).strict().superRefine((event, context) => {
  if ((event.stage === "completed") === (event.outcome === "none")) {
    context.addIssue({ code: "custom", message: "Only completed events have an outcome" });
  }
  if (event.stage !== "completed" && event.errorCode !== "none") {
    context.addIssue({ code: "custom", message: "Only completed events have an error code" });
  }
});
export type ProductAnalyticsEvent = z.infer<typeof productAnalyticsEventSchema>;
export type ProductAnalyticsScope = z.infer<typeof productAnalyticsScopeSchema>;
export type ProductAnalyticsActor = z.infer<typeof productAnalyticsActorSchema>;
export type ProductAnalyticsMode = z.infer<typeof productAnalyticsModeSchema>;
export type ProductAnalyticsSurface = z.infer<typeof productAnalyticsSurfaceSchema>;
export const productAnalyticsActionDeclarationSchema = z.object({
  action: identifier,
  surfaces: z.array(productAnalyticsSurfaceSchema).min(1).max(10),
  completionSource: z.enum(["client", "server"]),
}).strict();
export type ProductAnalyticsActionDeclaration = z.infer<typeof productAnalyticsActionDeclarationSchema>;
export const productAnalyticsBatchSchema = z.object({ events: z.array(productAnalyticsEventSchema).min(1).max(50) }).strict();
export type ProductAnalyticsBatch = z.infer<typeof productAnalyticsBatchSchema>;
export interface ProductAnalyticsReceipt {
  operationId: string;
  featureId: string;
  action: string;
  stage: ProductAnalyticsEvent["stage"];
  scope: ProductAnalyticsScope;
  mode: ProductAnalyticsMode;
  status: "accepted" | "duplicate" | "retry" | "rejected";
  code: "none" | "queue_full" | "storage_unavailable" | "invalid" | "unknown_feature" | "scope_denied" | "server_authoritative" | "expired";
}
export interface ProductAnalyticsAck { receipts: ProductAnalyticsReceipt[] }
export const productAnalyticsAckSchema = z.object({ receipts: z.array(z.object({
  operationId: z.string().uuid(), featureId: identifier, action: identifier, stage: productAnalyticsStageSchema,
  scope: productAnalyticsScopeSchema, mode: productAnalyticsModeSchema,
  status: z.enum(["accepted", "duplicate", "retry", "rejected"]),
  code: z.enum(["none", "queue_full", "storage_unavailable", "invalid", "unknown_feature", "scope_denied", "server_authoritative", "expired"]),
}).strict().superRefine((receipt, context) => {
  if ((receipt.status === "accepted" || receipt.status === "duplicate") && receipt.code !== "none") context.addIssue({ code: "custom", message: "Committed acknowledgements cannot carry a failure code" });
})).max(50) }).strict();
export const productAnalyticsReportQuerySchema = z.object({
  projectId: z.string().regex(/^proj_[a-zA-Z0-9_-]{1,100}$/).optional(),
  mode: productAnalyticsModeSchema.default("production"),
  actorKind: productAnalyticsActorSchema.optional(),
  surface: productAnalyticsSurfaceSchema.optional(),
  release: z.string().min(1).max(100).optional(),
  days: z.coerce.number().int().min(1).max(30).default(7),
}).strict();
export type ProductAnalyticsReportQuery = z.infer<typeof productAnalyticsReportQuerySchema>;
export interface ProductAnalyticsFeature {
  featureId: string;
  action: string;
  version: 1;
  label: string;
  entrypoints: string[];
  surfaces: ProductAnalyticsSurface[];
  coverage: "lifecycle" | "admission" | "observation" | "gap";
  availability: "available" | "unavailable" | "unknown";
  limitation: string | null;
}
export interface ProductAnalyticsRow extends ProductAnalyticsFeature {
  exposures: number;
  opens: number;
  attempts: number;
  successes: number;
  failures: number;
  denied: number;
  cancelled: number;
  accepted: number;
  human: number;
  agent: number;
  system: number;
  unknown: number;
  repeatActors: number;
  averageDurationMs: number | null;
  lastUsedAt: number | null;
}
export interface ProductAnalyticsDiagnostics {
  pending: number;
  failed: number;
  gaps: number;
  instanceGaps: number;
  expired: number;
  lastAcceptedAt: number | null;
  lastProjectedAt: number | null;
  storage: "healthy" | "unavailable";
  retentionDays: 30;
  maxPending: 10000;
  maxEvents: 100000;
}
export interface ProductAnalyticsReport {
  scope: ProductAnalyticsScope;
  mode: ProductAnalyticsMode;
  release: string;
  instanceId: string;
  generatedAt: number;
  since: number;
  diagnostics: ProductAnalyticsDiagnostics;
  rows: ProductAnalyticsRow[];
}
export const PRODUCT_ANALYTICS_HEADERS = {
  operation: "x-bb-product-operation",
  actor: "x-bb-product-actor",
  session: "x-bb-product-session",
  surface: "x-bb-product-surface",
  origin: "x-bb-product-origin",
  mode: "x-bb-product-mode",
  intent: "x-bb-product-intent",
  project: "x-bb-product-project",
} as const;
