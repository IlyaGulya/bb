import { productAnalyticsActionDeclarationSchema, type ProductAnalyticsActionDeclaration } from "@bb/server-contract";
import { pluginAnalyticsFeature } from "./product-analytics-catalog.js";
import type { PrivateProductAnalytics } from "./product-analytics.js";

export function validatePluginAnalyticsAction(input: ProductAnalyticsActionDeclaration): ProductAnalyticsActionDeclaration {
  const declaration = productAnalyticsActionDeclarationSchema.parse(input);
  if (/^(rpc\.|cli\.|http\.|agent-tool\.|websocket\.|service\.|schedule\.|provider\.|environment\.|machine\.|open$)/.test(declaration.action)) throw new Error("Framework analytics actions cannot be redeclared");
  return declaration;
}

export function declarePluginAnalyticsAction(service: PrivateProductAnalytics, pluginId: string, input: ProductAnalyticsActionDeclaration) {
  const declaration = validatePluginAnalyticsAction(input);
  const feature = pluginAnalyticsFeature(pluginId, declaration.action, declaration.surfaces, declaration.completionSource === "client" ? "lifecycle" : "admission");
  feature.limitation = declaration.completionSource === "client" ? "Declared client-local completion; not a server action result." : "Declared semantic server outcome; callers record the actual result, not an inferred click success.";
  const registration = service.registerOwned(feature, declaration.completionSource);
  return {
    identity: { featureId: feature.featureId, action: feature.action, version: 1 as const },
    dispose: registration.dispose,
  };
}
