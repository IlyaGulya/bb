import { z } from "zod";
import { validatePluginEnvironmentProviderDeclaration } from "@get-bb/plugin-sdk/internal/host-policy";
import { providerOperations, type TestEnvironmentProviderContext } from "./provider-decisions.js";
import { setPluginEnvironmentProviderBridge, type PluginEnvironmentProviderRecord } from "../../src/services/plugins/plugin-environment-provider-registry.js";
import { DEFAULT_ENVIRONMENT_PROVIDER_ID } from "../../src/services/environments/environment-provider-ids.js";
import { invokePluginInline } from "../../src/services/plugins/plugin-hook-registry.js";

export const checkoutProviderInputsSchema = z.object({
  path: z.string().min(1).optional(),
  branch: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("existing"), name: z.string().min(1) }),
      z.object({ kind: z.literal("new"), baseBranch: z.string().min(1) }),
    ])
    .optional(),
});

function checkoutInputsOf(context: TestEnvironmentProviderContext): { path?: string } {
  const inputs = context.inputs;
  return typeof inputs === "object" && inputs !== null && !Array.isArray(inputs)
    ? { ...(typeof inputs.path === "string" ? { path: inputs.path } : {}) }
    : {};
}

export function defaultEnvironmentProviderRecords(): PluginEnvironmentProviderRecord[] {
  const checkout = validatePluginEnvironmentProviderDeclaration({
    id: DEFAULT_ENVIRONMENT_PROVIDER_ID.projectCheckout,
    displayName: "Checkout",
    description: "Prepare a workspace for this thread.",
    icon: "Folder",
    requires: { projectCheckout: true },
    inputs: checkoutProviderInputsSchema,
    ...providerOperations((context) => {
      const host = context.host;
      const path = checkoutInputsOf(context).path ?? context.projectCheckout?.path;
      if (host === null || path === undefined) {
        return { action: "reject", message: "Checkout needs a machine with the project" };
      }
      return { action: "ready", environment: { type: "host", hostId: host.id, path } };
    }),
  });
  return [{ pluginId: "environment-project-checkout", provider: checkout }];
}

export function installDefaultEnvironmentProviders(): void {
  const records = defaultEnvironmentProviderRecords();
  setPluginEnvironmentProviderBridge({
    listEnvironmentProviders: () => records,
    getEnvironmentProvider: (id) => records.find((record) => record.provider.id === id),
    invokeProvider: (_pluginId, _label, run) => invokePluginInline(run),
    decisionTimeoutMs: 10_000,
  });
}
