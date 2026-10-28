import { randomUUID } from "node:crypto";
import { classifyProductAnalyticsResult, type ProductAnalyticsResult } from "./product-analytics-result.js";
import { pluginAnalyticsFeature } from "./product-analytics-catalog.js";
import { productAnalyticsContext, runWithProductAnalytics, type AnalyticsContext, type PrivateProductAnalytics } from "./product-analytics.js";

export async function observePluginAnalytics<T>(service: PrivateProductAnalytics, pluginId: string, action: string, run: () => Promise<T>, override?: Partial<AnalyticsContext>, classify: (value: unknown) => ProductAnalyticsResult | null = classifyProductAnalyticsResult): Promise<T> {
  const inherited = productAnalyticsContext();
  const context: AnalyticsContext = {
    operationId: inherited?.operationId ?? randomUUID(), scope: inherited?.scope ?? { kind: "instance" },
    scopeKnown: override?.scope !== undefined || (inherited?.scopeKnown ?? false),
    actorKind: inherited?.actorKind ?? "system", actorSessionId: inherited?.actorSessionId ?? null,
    surface: inherited?.surface ?? "system", mode: inherited?.mode ?? service.mode, intent: inherited?.intent ?? false,
    ...override,
  };
  service.register(pluginAnalyticsFeature(pluginId, action, [context.surface]));
  return runWithProductAnalytics(context, async () => {
    const started = performance.now();
    service.record(`plugin.${pluginId}`, action, "started");
    let semantic: ProductAnalyticsResult = { outcome: "failed", errorCode: "internal" };
    try {
      const result = await run();
      semantic = classify(result) ?? { outcome: "succeeded", errorCode: "none" };
      return result;
    } finally {
      service.record(`plugin.${pluginId}`, action, "completed", semantic.outcome, semantic.errorCode, performance.now() - started);
    }
  });
}
