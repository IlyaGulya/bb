import { PRODUCT_ANALYTICS_HEADERS as headers, type ProductAnalyticsActor, type ProductAnalyticsMode, type ProductAnalyticsSurface } from "@bb/server-contract";
import type { FetchImplementation } from "./response.js";

export interface ExperimentalProductAnalyticsContext {
  actorKind: ProductAnalyticsActor;
  surface: ProductAnalyticsSurface;
  mode?: ProductAnalyticsMode;
  actorSessionId?: string;
  operationId?: string;
  intentional?: boolean;
  projectId?: string;
}
export function experimental_productAnalyticsRequestInit(context: ExperimentalProductAnalyticsContext, init: RequestInit = {}): RequestInit {
  const result = new Headers(init.headers);
  if (!result.has(headers.operation)) result.set(headers.operation, context.operationId ?? crypto.randomUUID());
  if (!result.has(headers.actor)) result.set(headers.actor, context.actorKind);
  if (!result.has(headers.surface)) result.set(headers.surface, context.surface);
  if (context.mode !== undefined && !result.has(headers.mode)) result.set(headers.mode, context.mode);
  if (context.actorSessionId !== undefined && !result.has(headers.session)) result.set(headers.session, context.actorSessionId);
  if (context.intentional !== undefined && !result.has(headers.intent)) result.set(headers.intent, context.intentional ? "use" : "observe");
  if (context.projectId !== undefined && !result.has(headers.project)) result.set(headers.project, context.projectId);
  return { ...init, headers: result };
}
export function experimental_createProductAnalyticsFetch(context: ExperimentalProductAnalyticsContext, fetchImpl: FetchImplementation = fetch): FetchImplementation {
  return (input, init) => fetchImpl(input, experimental_productAnalyticsRequestInit(context, init?.headers === undefined && input instanceof Request ? { ...init, headers: input.headers } : init));
}
