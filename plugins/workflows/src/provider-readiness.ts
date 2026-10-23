import {
  experimental_providerExecutionReadinessBlocker,
  type BbPluginApi,
  type PluginProvidersState,
} from "@get-bb/plugin-sdk";

export async function requireWorkflowProviderReadiness(
  bb: BbPluginApi,
  environmentId: string,
  provider: PluginProvidersState["providers"][number],
  signal?: AbortSignal,
): Promise<void> {
  const observation =
    provider.readiness?.verification === "unsupported" ||
    provider.readiness?.status === "disabled"
      ? null
      : ((
          await bb.sdk.system.providerStates({
            environmentId,
            providerId: provider.id,
            ...(signal === undefined ? {} : { signal }),
          })
        ).providers.find((entry) => entry.providerId === provider.id)
          ?.readiness ?? null);
  signal?.throwIfAborted();
  const blocker = experimental_providerExecutionReadinessBlocker(
    provider,
    observation,
    "environment",
  );
  if (blocker !== null) throw new Error(blocker);
}
