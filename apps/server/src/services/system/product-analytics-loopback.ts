import { experimental_productAnalyticsRequestInit, type FetchImplementation } from "@bb/sdk";
import { productAnalyticsContext } from "./product-analytics.js";

export function privateAnalyticsLoopbackFetch(fetchImpl: FetchImplementation): FetchImplementation {
  return (input, init) => {
    const context = productAnalyticsContext();
    return fetchImpl(input, experimental_productAnalyticsRequestInit({
      actorKind: context?.actorKind ?? "system",
      surface: context?.surface ?? "system",
      ...(context === undefined ? {} : { operationId: context.operationId, mode: context.mode, intentional: context.intent }),
      ...(context?.actorSessionId === null || context?.actorSessionId === undefined ? {} : { actorSessionId: context.actorSessionId }),
      ...(context?.scope.kind === "project" ? { projectId: context.scope.projectId } : {}),
    }, init));
  };
}
