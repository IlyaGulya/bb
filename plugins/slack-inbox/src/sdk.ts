import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  configurationSchema,
  statusSchema,
  type Configuration,
} from "./contract.js";

export function createSlackInboxClient(
  plugins: Pick<BbPluginApi["sdk"]["plugins"], "callRpc">,
) {
  return {
    status: () =>
      plugins.callRpc({
        pluginId: "bb--slack-inbox",
        method: "status",
        input: null,
        outputSchema: statusSchema,
      }),
    configure: (configuration: Configuration) =>
      plugins.callRpc({
        pluginId: "bb--slack-inbox",
        method: "configure",
        input: configurationSchema.parse(configuration),
        outputSchema: statusSchema,
      }),
    checkCoverage: () =>
      plugins.callRpc({
        pluginId: "bb--slack-inbox",
        method: "checkCoverage",
        input: null,
        outputSchema: statusSchema,
      }),
    retry: () =>
      plugins.callRpc({
        pluginId: "bb--slack-inbox",
        method: "retry",
        input: null,
        outputSchema: statusSchema,
      }),
  };
}
