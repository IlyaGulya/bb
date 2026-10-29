import { ExperimentalProductAnalyticsOperation, ExperimentalProductAnalyticsOutbox, experimental_productAnalyticsRequestInit, type ExperimentalProductAnalyticsContext } from "@bb/sdk/browser";
import { productAnalyticsLocalActionsSchema, type ProductAnalyticsLocalActions, type ProductAnalyticsActor, type ProductAnalyticsEvent, type ProductAnalyticsScope } from "@bb/server-contract";
import { BrowserAnalyticsStore } from "./product-analytics-store";

const mode = import.meta.env.MODE === "production" ? "production" : import.meta.env.MODE === "test" ? "test" : import.meta.env.MODE === "smoke" ? "smoke" : "preview";
let currentInput: { actor: ProductAnalyticsActor; operationId: string; event: Event } | null = null;
let requestContext: ExperimentalProductAnalyticsContext | null = null;
let currentScope: ProductAnalyticsScope = { kind: "instance" };
let surface: ProductAnalyticsEvent["surface"] = "web";
let sessionId: string | null = null;
const operationIntents = new WeakMap<ExperimentalProductAnalyticsOperation, boolean>();
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
  const plugins = new Map<string, ProductAnalyticsLocalActions["actions"]>();
  for (const event of batch.events) {
    if (!event.featureId.startsWith("ui.plugin.")) continue;
    const pluginId = event.featureId.slice("ui.plugin.".length);
    const actions = plugins.get(pluginId) ?? [];
    actions.push({ action: event.action, coverage: event.action.endsWith(".mount") ? "observation" : "lifecycle" });
    plugins.set(pluginId, actions);
  }
  for (const [pluginId, actions] of plugins) await declareProductAnalyticsLocalActions({ pluginId, actions });
  const response = await fetch("/api/v1/system/product-analytics/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(batch), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("analytics_delivery_failed");
  return response.json();
});
export async function declareProductAnalyticsLocalActions(input: ProductAnalyticsLocalActions): Promise<boolean> {
  const parsed = productAnalyticsLocalActionsSchema.safeParse(input);
  if (!parsed.success) return false;
  const response = await fetch("/api/v1/system/product-analytics/local-actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(parsed.data), signal: AbortSignal.timeout(10_000) });
  if (response.status === 400 || response.status === 409) return false;
  if (!response.ok) throw new Error("analytics_catalog_delivery_failed");
  return true;
}
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
  const context = captureProductAnalyticsContext();
  void productAnalyticsOutbox.record({
    operationId: options.operationId ?? context.operationId ?? crypto.randomUUID(), featureId, action, version: 1,
    scope: options.scope ?? (context.projectId === undefined ? { kind: "instance" } : { kind: "project", projectId: context.projectId }), actorKind: options.actorKind ?? context.actorKind, actorSessionId: context.actorSessionId ?? null, surface: context.surface, mode: context.mode ?? mode,
    stage, outcome: options.outcome ?? "none", errorCode: options.errorCode ?? "none", durationMs: options.durationMs === undefined ? null : Math.min(86_400_000, Math.max(0, Math.round(options.durationMs))), timestamp: Date.now(),
  });
}
export function beginProductAnalyticsAction(featureId: string, action: string, scope?: ProductAnalyticsScope): ExperimentalProductAnalyticsOperation {
  const context = captureProductAnalyticsContext();
  const operation = new ExperimentalProductAnalyticsOperation(productAnalyticsOutbox, { featureId, action, version: 1, operationId: context.operationId ?? crypto.randomUUID(), scope: scope ?? (context.projectId === undefined ? { kind: "instance" } : { kind: "project", projectId: context.projectId }), actorKind: context.actorKind, actorSessionId: context.actorSessionId ?? null, surface: context.surface, mode: context.mode ?? mode });
  operationIntents.set(operation, context.intentional === true);
  return operation;
}
export function withProductAnalyticsOperation<T>(operation: ExperimentalProductAnalyticsOperation, run: () => T): T {
  const event = operation.identity;
  return withProductAnalyticsContext({ operationId: event.operationId, actorKind: event.actorKind, surface: event.surface, mode: event.mode, intentional: operationIntents.get(operation) ?? false, ...(event.actorSessionId === null ? {} : { actorSessionId: event.actorSessionId }), ...(event.scope.kind === "project" ? { projectId: event.scope.projectId } : {}) }, run);
}
export async function observeProductAnalyticsAsync<T>(featureId: string, action: string, run: () => Promise<T>, classify: (value: T) => Exclude<ProductAnalyticsEvent["outcome"], "none"> = () => "succeeded", scope?: ProductAnalyticsScope): Promise<T> {
  const operation = beginProductAnalyticsAction(featureId, action, scope);
  try {
    const result = await withProductAnalyticsOperation(operation, run);
    void operation.complete(classify(result));
    return result;
  } catch (error) {
    const cancelled = error instanceof DOMException && error.name === "AbortError";
    void operation.complete(cancelled ? "cancelled" : "failed", cancelled ? "cancelled" : "internal");
    throw error;
  }
}
export function observeProductAnalyticsLocal<T>(featureId: string, action: string, run: () => T, scope?: ProductAnalyticsScope): T {
  const operation = beginProductAnalyticsAction(featureId, action, scope);
  try {
    const result = withProductAnalyticsOperation(operation, run);
    void operation.complete(result === false ? "denied" : "accepted", result === false ? "unavailable" : "none");
    return result;
  } catch (error) {
    void operation.complete("failed", "internal");
    throw error;
  }
}
export function observeProductAnalyticsAction<T>(featureId: string, action: string, run: () => T, succeeded: (value: T) => boolean = () => true): T {
  const pluginCommand = /^plugin:([a-z0-9][a-z0-9-]*)\/([a-zA-Z0-9_-]+)$/.exec(action);
  if (pluginCommand) {
    featureId = `plugin.${pluginCommand[1]}`;
    action = `command.${pluginCommand[2]}`;
  }
  const operation = beginProductAnalyticsAction(featureId, action);
  try {
    const result = withProductAnalyticsOperation(operation, run);
    const success = succeeded(result);
    void operation.complete(success ? "accepted" : "denied", success ? "none" : "unavailable");
    return result;
  } catch (error) {
    void operation.complete("failed", "internal");
    throw error;
  }
}

let pendingNavigation: { featureId: string; operation: ExperimentalProductAnalyticsOperation; navigation: ExperimentalProductAnalyticsOperation | null; timer: ReturnType<typeof setTimeout> } | null = null;
export function beginProductAnalyticsNavigation(featureId: string, targetProjectId: string | undefined): void {
  if (captureProductAnalyticsContext().intentional !== true) return;
  if (pendingNavigation !== null) {
    clearTimeout(pendingNavigation.timer);
    void pendingNavigation.operation.complete("cancelled", "cancelled");
    void pendingNavigation.navigation?.complete("cancelled", "cancelled");
  }
  const scope: ProductAnalyticsScope = targetProjectId === undefined ? { kind: "instance" } : { kind: "project", projectId: targetProjectId };
  const operation = beginProductAnalyticsAction(featureId, "open", scope);
  const navigation = featureId === "ui.navigation" ? null : beginProductAnalyticsAction("ui.navigation", "open", scope);
  const timer = setTimeout(() => {
    if (pendingNavigation?.operation !== operation) return;
    void operation.complete("cancelled", "cancelled");
    void navigation?.complete("cancelled", "cancelled");
    pendingNavigation = null;
  }, 10_000);
  pendingNavigation = { featureId, operation, navigation, timer };
}
export function completeProductAnalyticsNavigation(featureId: string): void {
  const pending = pendingNavigation;
  if (pending?.featureId !== featureId) {
    recordProductAnalytics(featureId, "open", "opened", { actorKind: "unknown" });
    return;
  }
  clearTimeout(pending.timer);
  pendingNavigation = null;
  withProductAnalyticsOperation(pending.operation, () => recordProductAnalytics(featureId, "open", "opened"));
  void pending.operation.complete();
  void pending.navigation?.complete();
}
