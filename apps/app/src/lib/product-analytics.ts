import { ExperimentalProductAnalyticsOutbox, experimental_productAnalyticsRequestInit, type ExperimentalProductAnalyticsContext } from "@bb/sdk/browser";
import type { ProductAnalyticsActor, ProductAnalyticsEvent, ProductAnalyticsScope } from "@bb/server-contract";
import { BrowserAnalyticsStore } from "./product-analytics-store";

const mode = import.meta.env.MODE === "production" ? "production" : import.meta.env.MODE === "test" ? "test" : import.meta.env.MODE === "smoke" ? "smoke" : "preview";
let currentInput: { actor: ProductAnalyticsActor; operationId: string; event: Event } | null = null;
let requestContext: ExperimentalProductAnalyticsContext | null = null;
let currentScope: ProductAnalyticsScope = { kind: "instance" };
let surface: ProductAnalyticsEvent["surface"] = "web";
let sessionId: string | null = null;
function actorSessionId(): string {
  if (sessionId !== null) return sessionId;
  try {
    sessionId = sessionStorage.getItem("bb.private-analytics.session.v1");
    if (sessionId === null || !/^[0-9a-f-]{36}$/.test(sessionId)) {
      sessionId = crypto.randomUUID();
      sessionStorage.setItem("bb.private-analytics.session.v1", sessionId);
    }
  } catch { sessionId = crypto.randomUUID(); }
  return sessionId;
}
export const productAnalyticsOutbox = new ExperimentalProductAnalyticsOutbox(new BrowserAnalyticsStore(), async (batch) => {
  const response = await fetch("/api/v1/system/product-analytics/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(batch), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("analytics_delivery_failed");
  return response.json();
});
export function setProductAnalyticsView(scope: ProductAnalyticsScope, nextSurface: ProductAnalyticsEvent["surface"]): void { currentScope = scope; surface = nextSurface; }
export function productAnalyticsInput(event: Event): void {
  const context = { actor: event.isTrusted ? navigator.webdriver ? "agent" as const : "human" as const : "unknown" as const, operationId: crypto.randomUUID(), event };
  currentInput = context;
  setTimeout(() => { if (currentInput === context) currentInput = null; }, 0);
}
function activeInput() { return currentInput?.event.eventPhase === Event.NONE ? null : currentInput; }
export function captureProductAnalyticsContext(): ExperimentalProductAnalyticsContext {
  if (requestContext !== null) return requestContext;
  const input = activeInput();
  return { actorKind: input?.actor ?? "unknown", operationId: input?.operationId ?? crypto.randomUUID(), surface, mode, intentional: input !== null, actorSessionId: actorSessionId(), ...(currentScope.kind === "project" ? { projectId: currentScope.projectId } : {}) };
}
export function withProductAnalyticsContext<T>(context: ExperimentalProductAnalyticsContext, run: () => T): T {
  const previous = requestContext;
  requestContext = context;
  try {
    return run();
  } finally {
    requestContext = previous;
  }
}
export function productAnalyticsRequestInit(init: RequestInit = {}): RequestInit {
  return experimental_productAnalyticsRequestInit(captureProductAnalyticsContext(), init);
}
export function recordProductAnalytics(featureId: string, action: string, stage: ProductAnalyticsEvent["stage"], options: { operationId?: string; outcome?: ProductAnalyticsEvent["outcome"]; errorCode?: ProductAnalyticsEvent["errorCode"]; durationMs?: number; scope?: ProductAnalyticsScope; actorKind?: ProductAnalyticsActor } = {}): void {
  const input = activeInput();
  void productAnalyticsOutbox.record({
    operationId: options.operationId ?? input?.operationId ?? crypto.randomUUID(), featureId, action, version: 1,
    scope: options.scope ?? currentScope, actorKind: options.actorKind ?? input?.actor ?? "unknown", actorSessionId: actorSessionId(), surface, mode,
    stage, outcome: options.outcome ?? "none", errorCode: options.errorCode ?? "none", durationMs: options.durationMs === undefined ? null : Math.min(86_400_000, Math.max(0, Math.round(options.durationMs))), timestamp: Date.now(),
  });
}
export function observeProductAnalyticsAction<T>(featureId: string, action: string, run: () => T, succeeded: (value: T) => boolean = () => true): T {
  const pluginCommand = /^plugin:([a-z0-9][a-z0-9-]*)\/([a-zA-Z0-9_-]+)$/.exec(action);
  if (pluginCommand) {
    featureId = `plugin.${pluginCommand[1]}`;
    action = `command.${pluginCommand[2]}`;
  }
  const input = activeInput();
  const operationId = input?.operationId ?? crypto.randomUUID();
  const actorKind = input?.actor ?? "unknown";
  const scope = currentScope;
  const start = performance.now();
  recordProductAnalytics(featureId, action, "started", { operationId, actorKind, scope });
  try {
    const result = run();
    const success = succeeded(result);
    recordProductAnalytics(featureId, action, "completed", { operationId, actorKind, scope, outcome: success ? "accepted" : "denied", errorCode: success ? "none" : "unavailable", durationMs: performance.now() - start });
    return result;
  } catch (error) {
    recordProductAnalytics(featureId, action, "completed", { operationId, actorKind, scope, outcome: "failed", errorCode: "internal", durationMs: performance.now() - start });
    throw error;
  }
}

let pendingNavigation: { featureId: string; operationId: string; actorKind: ProductAnalyticsActor; scope: ProductAnalyticsScope; startedAt: number; timer: ReturnType<typeof setTimeout> } | null = null;
export function beginProductAnalyticsNavigation(featureId: string, targetProjectId: string | undefined): void {
  if (pendingNavigation !== null) {
    const previous = pendingNavigation;
    clearTimeout(previous.timer);
    pendingNavigation = null;
    recordProductAnalytics(previous.featureId, "open", "completed", { ...previous, outcome: "cancelled", errorCode: "cancelled", durationMs: performance.now() - previous.startedAt });
  }
  const input = activeInput();
  const operationId = input?.operationId ?? crypto.randomUUID();
  const actorKind = input?.actor ?? "unknown";
  const scope: ProductAnalyticsScope = targetProjectId === undefined ? { kind: "instance" } : { kind: "project", projectId: targetProjectId };
  const startedAt = performance.now();
  const timer = setTimeout(() => {
    if (pendingNavigation?.operationId !== operationId) return;
    recordProductAnalytics(featureId, "open", "completed", { operationId, actorKind, scope, outcome: "cancelled", errorCode: "cancelled", durationMs: performance.now() - startedAt });
    pendingNavigation = null;
  }, 10_000);
  pendingNavigation = { featureId, operationId, actorKind, scope, startedAt, timer };
  recordProductAnalytics(featureId, "open", "started", { operationId, actorKind, scope });
}
export function completeProductAnalyticsNavigation(featureId: string): void {
  const pending = pendingNavigation;
  if (pending?.featureId !== featureId) {
    recordProductAnalytics(featureId, "open", "opened", { actorKind: "unknown" });
    return;
  }
  clearTimeout(pending.timer);
  pendingNavigation = null;
  recordProductAnalytics(featureId, "open", "opened", pending);
  recordProductAnalytics(featureId, "open", "completed", { ...pending, outcome: "succeeded", errorCode: "none", durationMs: performance.now() - pending.startedAt });
}
