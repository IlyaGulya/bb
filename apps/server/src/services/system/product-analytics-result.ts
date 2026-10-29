import type { ProductAnalyticsEvent } from "@bb/server-contract";
import type { Context } from "hono";

export interface ProductAnalyticsResult {
  outcome: ProductAnalyticsEvent["outcome"];
  errorCode: ProductAnalyticsEvent["errorCode"];
}
export function outcomeForStatus(status: number): { outcome: ProductAnalyticsEvent["outcome"]; errorCode: ProductAnalyticsEvent["errorCode"] } {
  if (status === 202) return { outcome: "accepted", errorCode: "none" };
  if (status >= 200 && status < 400) return { outcome: "succeeded", errorCode: "none" };
  if (status === 401 || status === 403) return { outcome: "denied", errorCode: "forbidden" };
  if (status === 404) return { outcome: "unavailable", errorCode: "not_found" };
  if (status === 409) return { outcome: "failed", errorCode: "conflict" };
  if (status === 400 || status === 422) return { outcome: "failed", errorCode: "invalid" };
  if (status === 499) return { outcome: "cancelled", errorCode: "cancelled" };
  if (status === 502 || status === 503 || status === 504) return { outcome: "failed", errorCode: "unavailable" };
  return { outcome: "failed", errorCode: "internal" };
}
export function classifyProductAnalyticsResult(value: unknown, depth = 0): ProductAnalyticsResult | null {
  if (typeof value !== "object" || value === null || depth > 2) return null;
  if (value instanceof Response) return outcomeForStatus(value.status);
  if ("outcome" in value) {
    if (value.outcome === "denied") return { outcome: "denied", errorCode: "forbidden" };
    if (value.outcome === "cancelled" || value.outcome === "interrupted") return { outcome: "cancelled", errorCode: "cancelled" };
    if (value.outcome === "unavailable" || value.outcome === "not-found") return { outcome: "unavailable", errorCode: "unavailable" };
    if (value.outcome === "conflict") return { outcome: "failed", errorCode: "conflict" };
    if (value.outcome === "failed" || value.outcome === "rolled-back" || value.outcome === "error") return { outcome: "failed", errorCode: "internal" };
    if (value.outcome === "accepted" || value.outcome === "queued" || value.outcome === "pending") return { outcome: "accepted", errorCode: "none" };
  }
  if (("ok" in value && value.ok === false) || ("success" in value && value.success === false) || ("isError" in value && value.isError === true) || ("exitCode" in value && typeof value.exitCode === "number" && value.exitCode !== 0)) return { outcome: "failed", errorCode: "internal" };
  if ("delivery" in value && value.delivery === "queued") return { outcome: "accepted", errorCode: "none" };
  if ("result" in value) return classifyProductAnalyticsResult(value.result, depth + 1);
  if ("value" in value) return classifyProductAnalyticsResult(value.value, depth + 1);
  return null;
}

export async function withProductAnalyticsJsonResult<T>(context: Pick<Context, "json">, run: (classify: (value: unknown) => ProductAnalyticsResult | null) => Promise<T>): Promise<T> {
  let semantic: ProductAnalyticsResult | null = null;
  const originalJson = context.json;
  context.json = new Proxy(originalJson, {
    apply(target, receiver, args) {
      semantic = classifyProductAnalyticsResult(args[0]);
      const invoke: (...args: never[]) => unknown = target;
      return Reflect.apply(invoke, receiver, args);
    },
  });
  try {
    return await run((value) => value instanceof Response && value.status >= 400 ? outcomeForStatus(value.status) : semantic ?? classifyProductAnalyticsResult(value));
  } finally {
    context.json = originalJson;
  }
}
