import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { z } from "zod";
import { routingRpcContract } from "../shared/routing.js";

export function createTaskRoutingClient(plugins: Pick<BbPluginApi["sdk"]["plugins"], "callRpc">) {
  return {
    inspect: (input: z.infer<typeof routingRpcContract.getInboxRoute.input>) => plugins.callRpc({ pluginId: "tasks", method: "getInboxRoute", input, outputSchema: routingRpcContract.getInboxRoute.output }),
    preview: (input: z.infer<typeof routingRpcContract.previewInboxRoute.input>) => plugins.callRpc({ pluginId: "tasks", method: "previewInboxRoute", input, outputSchema: routingRpcContract.previewInboxRoute.output }),
    apply: (input: z.infer<typeof routingRpcContract.applyInboxRoute.input>) => plugins.callRpc({ pluginId: "tasks", method: "applyInboxRoute", input, outputSchema: routingRpcContract.applyInboxRoute.output }),
    enableLocalAway: (input: z.infer<typeof routingRpcContract.enableLocalAway.input>) => plugins.callRpc({ pluginId: "tasks", method: "enableLocalAway", input, outputSchema: routingRpcContract.enableLocalAway.output }),
    revokeLocalAway: (input: z.infer<typeof routingRpcContract.revokeLocalAway.input>) => plugins.callRpc({ pluginId: "tasks", method: "revokeLocalAway", input, outputSchema: routingRpcContract.revokeLocalAway.output }),
  };
}
