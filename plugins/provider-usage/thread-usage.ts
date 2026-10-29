import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { normalizeUsageMeasurement, normalizedUsage, withThreadUsageFreshness } from "./usage-normalization.js";
import { usageFetchMethod, usageListMethod, usageSourceRpcContract } from "./usage-source-contract.js";
import type { ThreadUsage, ThreadUsageInput } from "./thread-usage-schema.js";

const SOURCE_PLUGIN_ID = "provider-claude-code";

function unknownUsage(threadId: string): ThreadUsage {
  return {
    threadId,
    bindingCreatedAt: null,
    connection: null,
    host: null,
    state: "unknown",
    reason: "The frozen thread binding could not be verified. No other account was selected.",
    source: null,
    observedAt: null,
    usage: null,
  };
}

export function createThreadUsageReader(bb: BbPluginApi) {
  const inspect = async (threadId: string) => {
    const observation = await bb.sdk.experimental_executionContexts.getThreadEligibility({ threadId });
    const { binding, thread, host, modelConnection: current, executionContext: contextDefinition } = observation;
    const result = unknownUsage(threadId);
    const key = observation.generation;
    result.bindingCreatedAt = binding?.createdAt ?? null;
    result.host = host === null ? null : { id: host.id, name: host.name };
    const connection = binding?.modelConnection;
    if (!connection) {
      result.reason = "This thread has no frozen model connection. Browse all accounts for host-local maintenance observations.";
      return { result, key, qualified: false };
    }
    result.connection = {
      id: connection.id,
      name: connection.name,
      providerId: connection.provider,
      providerName: connection.provider,
      kind: connection.gateway === null ? "native" : "gateway",
      definition: "unknown",
    };
    if (current === null) {
      const missing = observation.issue?.code === "model_connection_not_found";
      result.connection.definition = missing ? "missing" : "unknown";
      result.state = result.connection.definition;
      result.reason = missing
        ? "The current connection definition was removed. The frozen binding has not been replaced."
        : "The current connection definition could not be verified. No quota was attributed.";
      return { result, key, qualified: false };
    }
    result.connection.definition = current.revoked || connection.revoked
      ? "revoked"
      : !current.enabled || !connection.enabled
        ? "disabled"
        : JSON.stringify(current) === JSON.stringify(connection) ? "active" : "changed";
    if (result.connection.definition === "revoked" || result.connection.definition === "disabled") {
      result.state = result.connection.definition;
      result.reason = `This model connection is ${result.state}. The frozen binding remains unchanged; usage is not collected.`;
      return { result, key, qualified: false };
    }
    if (binding?.executionContext && contextDefinition === null) {
      result.state = "missing";
      result.reason = "The execution context referenced by the frozen binding was removed. No quota was attributed.";
      return { result, key, qualified: false };
    }
    if (contextDefinition !== null && !contextDefinition.enabled) {
      result.state = "disabled";
      result.reason = "The frozen binding's execution context is currently disabled. Usage is not collected.";
      return { result, key, qualified: false };
    }
    if (connection.gateway !== null) {
      result.state = "unsupported";
      result.reason = "No exact permitted quota source is published for this gateway connection. Account namespaces, request usage and cooldowns do not identify a physical credential or subscription quota.";
      return { result, key, qualified: false };
    }
    if (connection.nativeAuth.configDir !== null || connection.nativeAuth.profile !== null || connection.nativeAuth.hostEnv !== null) {
      result.state = "unsupported";
      result.reason = "The existing usage sources do not identify this native config directory, profile or auth broker. Host-global usage belongs to a different, unproven source.";
      return { result, key, qualified: false };
    }
    if (connection.provider !== "claude-code") {
      result.state = "unsupported";
      result.reason = "No exact native-connection association is proven for this provider's usage source. Other native and pooled accounts are not substitutes.";
      return { result, key, qualified: false };
    }
    if (binding?.executionContext?.nativeMcpProfile && binding.executionContext.nativeMcpProfile.configDir !== null) {
      result.state = "unsupported";
      result.reason = "The frozen native MCP profile does not use the host-default Claude account source. Its quota association is not proven.";
      return { result, key, qualified: false };
    }
    if (!observation.available) {
      result.state = observation.issue?.code === "execution_host_disconnected" ? "stale" : "unknown";
      result.reason = observation.issue?.message ?? "Current Core execution eligibility could not be verified. No quota was attributed.";
      return { result, key, qualified: false };
    }
    if (host === null || thread.providerId !== connection.provider) {
      result.reason = "The thread's actual execution machine and frozen provider could not be verified. No fallback was selected.";
      return { result, key, qualified: false };
    }
    return { result, key, qualified: true };
  };
  const recheck = async (threadId: string, key: string): Promise<ThreadUsage | null> => {
    const latest = await inspect(threadId);
    if (!latest.qualified) return latest.result;
    if (latest.key === key) return null;
    latest.result.reason = "The frozen binding or current execution definitions changed while usage was loading. Reload to inspect the frozen selection; no old quota was retained.";
    return latest.result;
  };

  return async (input: ThreadUsageInput): Promise<ThreadUsage> => {
    let initial: Awaited<ReturnType<typeof inspect>>;
    try {
      initial = await inspect(input.threadId);
    } catch {
      return unknownUsage(input.threadId);
    }
    if (!initial.qualified) return initial.result;
    const result = initial.result;
    const selectedHostId = result.host?.id;
    if (selectedHostId === undefined) return result;
    try {
      const sources = await bb.sdk.plugins.experimental_discoverRpc({ method: usageListMethod });
      const source = sources.find((value) => value.pluginId === SOURCE_PLUGIN_ID);
      if (!source) {
        result.state = "unsupported";
        result.reason = "The host-default Claude usage source is not available. No other source was selected.";
      } else {
        const inventory = await bb.sdk.plugins.callRpc({
          pluginId: source.pluginId,
          method: usageListMethod,
          input: {},
          outputSchema: usageSourceRpcContract[usageListMethod].output,
          signal: AbortSignal.timeout(45_000),
        });
        const expectedId = JSON.stringify([selectedHostId, "claude-code"]);
        const resources = inventory.resources.filter((resource) =>
          resource.id === expectedId &&
          resource.providerId === "claude-code" &&
          resource.scope.kind === "host" &&
          resource.scope.hostId === selectedHostId,
        );
        if (resources.length !== 1) {
          result.reason = "An unambiguous host-default Claude resource is not published for this execution machine. No pooled or other-host resource was selected.";
        } else {
          const changed = await recheck(input.threadId, initial.key);
          if (changed !== null) return changed;
          result.source = { pluginId: source.pluginId, name: source.displayName, resourceId: expectedId };
          const measurement = normalizeUsageMeasurement(await bb.sdk.plugins.callRpc({
            pluginId: source.pluginId,
            method: usageFetchMethod,
            input: { resourceId: expectedId, refresh: input.force },
            outputSchema: usageSourceRpcContract[usageFetchMethod].output,
            signal: AbortSignal.timeout(45_000),
          }));
          result.observedAt = measurement.observedAt;
          const usage = measurement.usage;
          if (usage.status === "error") {
            result.state = measurement.observedAt === null ? "unknown" : "stale";
            result.reason = "The selected source could not provide current usage. No other account was queried.";
          } else if (usage.status !== "ok") {
            result.state = usage.status;
            result.usage = normalizedUsage(usage);
            result.reason = usage.status === "expired"
              ? "The selected source reports an expired login, not exhausted quota."
              : usage.status === "unauthenticated"
                ? "The selected source reports no authenticated login, not exhausted quota."
                : "Claude is not installed on this execution machine.";
          } else {
            result.usage = normalizedUsage(usage);
            result.state = usage.windows.some((window) => window.usedPercent >= 100)
              ? "exhausted"
              : usage.windows.length === 0 ? "unknown" : "available";
            result.reason = result.state === "exhausted"
              ? "The selected source reports at least one exhausted quota window. No fallback account was selected."
              : result.state === "unknown"
                ? "The selected source reports no quota windows. Missing limits are not zero consumption."
                : "The selected source reports quota windows for the frozen logical connection.";
          }
        }
      }
    } catch {
      result.state = "unknown";
      result.reason = "The selected usage source could not be read. No other source was queried.";
      result.usage = null;
    }
    try {
      if (result.connection !== null) {
        const providers = await bb.sdk.providers.list({ hostId: selectedHostId }).catch(() => []);
        result.connection.providerName = providers.find((provider) => provider.id === result.connection?.providerId)?.displayName ?? result.connection.providerId;
      }
      const changed = await recheck(input.threadId, initial.key);
      if (changed !== null) return changed;
    } catch {
      return unknownUsage(input.threadId);
    }
    return withThreadUsageFreshness(result, Date.now());
  };
}
