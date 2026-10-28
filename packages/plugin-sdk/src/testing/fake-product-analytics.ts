import { productAnalyticsActionDeclarationSchema, productAnalyticsEventSchema } from "@bb/server-contract";
import type { BbPluginApi } from "../backend-contract.js";

export function createFakeProductAnalytics(pluginId: string): BbPluginApi["experimental_productAnalytics"] {
  const actions = new Set<string>();
  const admitted = new Set<string>();
  return {
    declareAction(input) {
      const declaration = productAnalyticsActionDeclarationSchema.parse(input);
      if (/^(rpc\.|cli\.|http\.|agent-tool\.|websocket\.|service\.|schedule\.|provider\.|environment\.|machine\.|open$)/.test(declaration.action)) throw new Error("Framework analytics actions cannot be redeclared");
      actions.add(declaration.action);
      return { featureId: `plugin.${pluginId}`, action: declaration.action, version: 1 };
    },
    record(input) {
      const event = productAnalyticsEventSchema.parse({ ...input, featureId: `plugin.${pluginId}`, version: 1 });
      const identity = { operationId: event.operationId, featureId: event.featureId, action: event.action, stage: event.stage, scope: event.scope, mode: event.mode };
      if (!actions.has(event.action)) return { ...identity, status: "rejected", code: "unknown_feature" };
      const key = JSON.stringify([event.scope, event.operationId, event.featureId, event.action, event.stage]);
      if (admitted.has(key)) return { ...identity, status: "duplicate", code: "none" };
      admitted.add(key);
      return { ...identity, status: "accepted", code: "none" };
    },
  };
}
