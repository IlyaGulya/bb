import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { loadCliConfig } from "@bb/config/cli";
import { ExperimentalProductAnalyticsOperation, ExperimentalProductAnalyticsOutbox } from "@bb/sdk/node";
import { productAnalyticsModeSchema, productAnalyticsScopeSchema } from "@bb/server-contract";
import { cliAnalyticsContext } from "./client.js";
import { resolveCliErrorLogLocation } from "./cli-error-log.js";
import { LocalProductAnalyticsStore } from "./product-analytics-store.js";

const actions = new Set(["guide", "help", "plugin new", "plugin types", "plugin build", "plugin dev", "diagnostics cli-errors", "diagnostics product-analytics"]);
let outbox: ExperimentalProductAnalyticsOutbox | null = null;
const active = new Map<ExperimentalProductAnalyticsOperation, string>();
let exitBound = false;
export function localProductAnalyticsOutbox(): ExperimentalProductAnalyticsOutbox {
  if (outbox !== null) return outbox;
  const baseUrl = loadCliConfig().BB_SERVER_URL;
  const key = createHash("sha256").update(baseUrl).digest("hex");
  const store = new LocalProductAnalyticsStore(join(resolveCliErrorLogLocation().dataDir, "private-product-analytics", key));
  outbox = new ExperimentalProductAnalyticsOutbox(store, async (batch) => {
    const response = await fetch(new URL("/api/v1/system/product-analytics/events", baseUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(batch), signal: AbortSignal.timeout(250) });
    if (!response.ok) throw new Error("analytics_delivery_failed");
    return response.json();
  });
  return outbox;
}
export function beginLocalProductAnalytics(command: string): ExperimentalProductAnalyticsOperation | null {
  if (!actions.has(command)) return null;
  try {
    const context = cliAnalyticsContext();
    const scope = productAnalyticsScopeSchema.parse(context.projectId === undefined ? { kind: "instance" } : { kind: "project", projectId: context.projectId });
    const operation = new ExperimentalProductAnalyticsOperation(localProductAnalyticsOutbox(), { featureId: "cli.local", action: command.replaceAll(" ", "."), version: 1, operationId: context.operationId ?? randomUUID(), actorKind: context.actorKind, actorSessionId: null, scope, surface: context.surface, mode: context.mode ?? productAnalyticsModeSchema.parse(process.env.NODE_ENV === "test" ? "test" : "production") });
    active.set(operation, command);
    if (!exitBound) {
      exitBound = true;
      process.once("exit", (code) => {
        for (const [pending, name] of active) void pending.complete(code !== 0 ? "failed" : name === "plugin dev" ? "cancelled" : "succeeded", code !== 0 ? "internal" : name === "plugin dev" ? "cancelled" : "none");
      });
    }
    return operation;
  } catch {
    console.error("Private analytics: local storage or context unavailable; usage has a gap.");
    return null;
  }
}
export async function finishLocalProductAnalytics(operation: ExperimentalProductAnalyticsOperation | null, failed = false): Promise<void> {
  if (operation === null) return;
  const name = active.get(operation);
  active.delete(operation);
  await operation.complete(failed ? "failed" : name === "plugin dev" ? "cancelled" : "succeeded", failed ? "internal" : name === "plugin dev" ? "cancelled" : "none");
  await outbox?.flush();
  const health = outbox?.getSnapshot();
  if (health && (health.gaps > 0 || health.failed > 0 || health.storage === "unavailable")) console.error(`Private analytics delivery: ${health.pending} pending, ${health.failed} retrying, ${health.gaps} gaps; storage ${health.storage}.`);
}
