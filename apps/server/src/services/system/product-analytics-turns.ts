import { createHash } from "node:crypto";
import { appSettingsValues, threads, type DbConnection } from "@bb/db";
import type { TurnRequestTarget } from "@bb/domain";
import { productAnalyticsModeSchema, type ProductAnalyticsMode } from "@bb/server-contract";
import { and, count, eq, gte, like, lt } from "drizzle-orm";
import type { AppDeps } from "../../types.js";
import { ANALYTICS_MAX_PENDING, ANALYTICS_PENDING_TURN_MODE_PREFIX, ANALYTICS_RETENTION_MS, analyticsMode, getPrivateProductAnalytics, initializePrivateProductAnalytics, productAnalyticsContext } from "./product-analytics.js";
import { pluginAnalyticsAction } from "./product-analytics-plugin-catalog.js";
import { pluginAnalyticsFeature } from "./product-analytics-catalog.js";

const pendingModePrefix = ANALYTICS_PENDING_TURN_MODE_PREFIX;

function pendingModeKey(threadId: string): string {
  return `${pendingModePrefix}${createHash("sha256").update(threadId).digest("hex")}`;
}
function turnOperationId(threadId: string, turnId: string): string {
  const hash = createHash("sha256").update(`${threadId}:${turnId}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function analyticsTurnMode(db: DbConnection, threadId: string, turnId: string, projectId: string): ProductAnalyticsMode {
  return getPrivateProductAnalytics(db).modeForOperation({ scope: { kind: "project", projectId }, operationId: turnOperationId(threadId, turnId), featureId: "core.execution", action: "turn", version: 1 });
}

export function rememberAnalyticsTurnMode(db: DbConnection, threadId: string, target: TurnRequestTarget): void {
  const context = productAnalyticsContext();
  if (target.kind !== "new-turn" || context === undefined) return;
  const service = getPrivateProductAnalytics(db);
  try {
    const key = pendingModeKey(threadId);
    const updatedAt = Date.now();
    const stored = db.transaction((tx) => {
      tx.delete(appSettingsValues).where(and(like(appSettingsValues.key, `${pendingModePrefix}%`), lt(appSettingsValues.updatedAt, updatedAt - ANALYTICS_RETENTION_MS))).run();
      const existing = tx.select({ key: appSettingsValues.key }).from(appSettingsValues).where(eq(appSettingsValues.key, key)).get();
      if (existing === undefined && (tx.select({ value: count() }).from(appSettingsValues).where(like(appSettingsValues.key, `${pendingModePrefix}%`)).get()?.value ?? 0) >= ANALYTICS_MAX_PENDING) return false;
      const value = JSON.stringify(context.mode);
      tx.insert(appSettingsValues).values({ key, value, updatedAt }).onConflictDoUpdate({ target: appSettingsValues.key, set: { value, updatedAt } }).run();
      return true;
    });
    if (!stored) service.noteGap(context.scope, context.mode);
  } catch {
    service.noteGap(context.scope, context.mode);
  }
}

export function observeAnalyticsTurn(deps: Pick<AppDeps, "db" | "config" | "logger" | "providerRegistry">, threadId: string, turnId: string, event: { stage: "started" } | { stage: "completed"; status: "completed" | "failed" | "interrupted" }): void {
  const service = initializePrivateProductAnalytics({ db: deps.db, release: deps.config.appVersion, mode: analyticsMode(deps.config.isDevelopment), logger: deps.logger });
  const thread = deps.db.select({ projectId: threads.projectId, providerId: threads.providerId }).from(threads).where(eq(threads.id, threadId)).get();
  if (thread === undefined) return;
  const operationId = turnOperationId(threadId, turnId);
  const pendingKey = pendingModeKey(threadId);
  let pending: { value: string; updatedAt: number } | undefined;
  let mode = service.mode;
  if (event.stage === "started") {
    try {
      pending = deps.db.select({ value: appSettingsValues.value, updatedAt: appSettingsValues.updatedAt }).from(appSettingsValues).where(and(eq(appSettingsValues.key, pendingKey), gte(appSettingsValues.updatedAt, Date.now() - ANALYTICS_RETENTION_MS))).get();
      if (pending !== undefined) mode = productAnalyticsModeSchema.parse(JSON.parse(pending.value));
    } catch {
      service.noteGap({ kind: "project", projectId: thread.projectId });
    }
  }
  const outcome = event.stage === "started" ? "none" : event.status === "failed" ? "failed" : event.status === "interrupted" ? "cancelled" : "succeeded";
  const receipt = service.record("core.execution", "turn", event.stage, outcome, outcome === "failed" ? "internal" : outcome === "cancelled" ? "cancelled" : "none", null, { operationId, scope: { kind: "project", projectId: thread.projectId }, actorKind: "system", surface: "system", mode });
  const provider = deps.providerRegistry.get(thread.providerId);
  if (provider !== null) {
    const action = pluginAnalyticsAction("provider", thread.providerId);
    service.register({ ...pluginAnalyticsFeature(provider.pluginId, action, ["system"], "lifecycle"), availability: "unknown", limitation: "Actual root turn lifecycle. Runtime execution is system activity, not proof of human provider selection or current host readiness." });
    service.record(`plugin.${provider.pluginId}`, action, event.stage, outcome, outcome === "failed" ? "internal" : outcome === "cancelled" ? "cancelled" : "none", null, { operationId, scope: { kind: "project", projectId: thread.projectId }, actorKind: "system", surface: "system", mode });
  }
  if (event.stage === "started" && pending !== undefined && receipt.status === "accepted") {
    try {
      deps.db.delete(appSettingsValues).where(and(eq(appSettingsValues.key, pendingKey), eq(appSettingsValues.value, pending.value), eq(appSettingsValues.updatedAt, pending.updatedAt))).run();
    } catch {
      service.noteGap({ kind: "project", projectId: thread.projectId }, mode);
    }
  }
}
