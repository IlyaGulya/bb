import { createHash } from "node:crypto";
import { threads } from "@bb/db";
import { eq } from "drizzle-orm";
import type { AppDeps } from "../../types.js";
import { analyticsMode, initializePrivateProductAnalytics } from "./product-analytics.js";
import { pluginAnalyticsAction } from "./product-analytics-plugin-catalog.js";
import { pluginAnalyticsFeature } from "./product-analytics-catalog.js";

export function observeAnalyticsTurn(deps: Pick<AppDeps, "db" | "config" | "logger" | "providerRegistry">, threadId: string, turnId: string, event: { stage: "started" } | { stage: "completed"; status: "completed" | "failed" | "interrupted" }): void {
  const service = initializePrivateProductAnalytics({ db: deps.db, release: deps.config.appVersion, mode: analyticsMode(deps.config.isDevelopment), logger: deps.logger });
  const thread = deps.db.select({ projectId: threads.projectId, providerId: threads.providerId }).from(threads).where(eq(threads.id, threadId)).get();
  if (thread === undefined) return;
  const hash = createHash("sha256").update(`${threadId}:${turnId}`).digest("hex");
  const operationId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const outcome = event.stage === "started" ? "none" : event.status === "failed" ? "failed" : event.status === "interrupted" ? "cancelled" : "succeeded";
  service.record("core.execution", "turn", event.stage, outcome, outcome === "failed" ? "internal" : outcome === "cancelled" ? "cancelled" : "none", null, { operationId, scope: { kind: "project", projectId: thread.projectId }, actorKind: "system", surface: "system", mode: service.mode });
  const provider = deps.providerRegistry.get(thread.providerId);
  if (provider !== null) {
    const action = pluginAnalyticsAction("provider", thread.providerId);
    service.register({ ...pluginAnalyticsFeature(provider.pluginId, action, ["system"], "lifecycle"), availability: "unknown", limitation: "Actual root turn lifecycle. Runtime execution is system activity, not proof of human provider selection or current host readiness." });
    service.record(`plugin.${provider.pluginId}`, action, event.stage, outcome, outcome === "failed" ? "internal" : outcome === "cancelled" ? "cancelled" : "none", null, { operationId, scope: { kind: "project", projectId: thread.projectId }, actorKind: "system", surface: "system", mode: service.mode });
  }
}
