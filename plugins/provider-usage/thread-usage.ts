import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { normalizeUsageMeasurement, normalizedUsage } from "./usage-normalization.js";
import { usageFetchMethod, usageListMethod, usageSourceRpcContract } from "./usage-source-contract.js";
import type { ThreadUsage, ThreadUsageInput } from "./thread-usage-schema.js";

const MAX_OBSERVATION_AGE_MS = 2 * 60_000;
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
    const result = unknownUsage(threadId);
    const [binding, thread] = await Promise.all([
      bb.sdk.experimental_executionContexts.getThreadBinding({ threadId }),
      bb.sdk.threads.get({ threadId }),
    ]);
    result.bindingCreatedAt = binding?.createdAt ?? null;
    const connection = binding?.modelConnection;
    if (!connection) {
      result.reason = "This thread has no frozen model connection. Browse all accounts for host-local maintenance observations.";
      return { result, key: "unbound", qualified: false };
    }
    result.connection = {
      id: connection.id,
      name: connection.name,
      providerId: connection.provider,
      providerName: connection.provider,
      kind: connection.gateway === null ? "native" : "gateway",
      definition: "unknown",
    };
    const [definition, environment] = await Promise.all([
      bb.sdk.experimental_modelConnections.get({ id: connection.id }).then(
        (value) => ({ kind: "found" as const, value }),
        (cause: unknown) => ({
          kind: cause instanceof Error && "status" in cause && cause.status === 404
            ? "missing" as const
            : "unknown" as const,
        }),
      ),
      thread.environmentId === null
        ? null
        : bb.sdk.environments.get({ environmentId: thread.environmentId }).catch(() => null),
    ]);
    if (definition.kind !== "found") {
      result.connection.definition = definition.kind;
      result.state = definition.kind;
      result.reason = definition.kind === "missing"
        ? "The current connection definition was removed. The frozen binding has not been replaced."
        : "The current connection definition could not be verified. No quota was attributed.";
      return { result, key: definition.kind, qualified: false };
    }
    const current = definition.value;
    result.connection.definition = current.revoked || connection.revoked
      ? "revoked"
      : !current.enabled || !connection.enabled
        ? "disabled"
        : JSON.stringify(current) === JSON.stringify(connection) ? "active" : "changed";
    const host = environment === null
      ? null
      : await bb.sdk.hosts.get({ hostId: environment.hostId }).catch(() => null);
    result.host = host === null ? null : { id: host.id, name: host.name };
    if (host !== null) {
      const providers = await bb.sdk.providers.list({ hostId: host.id }).catch(() => []);
      result.connection.providerName = providers.find((provider) => provider.id === connection.provider)?.displayName ?? connection.provider;
    }
    const key = JSON.stringify([binding, thread.providerId, thread.environmentId, environment?.hostId, current, host?.status]);
    if (result.connection.definition === "revoked" || result.connection.definition === "disabled") {
      result.state = result.connection.definition;
      result.reason = `This model connection is ${result.state}. The frozen binding remains unchanged; usage is not collected.`;
      return { result, key, qualified: false };
    }
    if (environment === null || host === null) {
      result.reason = "The thread's actual execution machine could not be verified. No host-default fallback was selected.";
      return { result, key, qualified: false };
    }
    if (thread.providerId !== connection.provider || current.provider !== connection.provider) {
      result.reason = "The thread provider and frozen/current connection providers do not match. No quota was attributed.";
      return { result, key, qualified: false };
    }
    const authorizesHost = (value: NonNullable<typeof connection>) => value.gateway === null
      ? value.hostId === host.id
      : value.gateway.allowedHostIds.includes(host.id);
    if (!authorizesHost(connection) || !authorizesHost(current)) {
      result.reason = "The actual execution machine is not authorized by the frozen and current connection definitions.";
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
    if (host.status !== "connected") {
      result.state = "stale";
      result.reason = "The execution machine is disconnected. Current selected-source usage is unavailable.";
      return { result, key, qualified: false };
    }
    return { result, key, qualified: true };
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
          } else if (measurement.observedAt === null || measurement.observedAt > Date.now()) {
            result.observedAt = null;
            result.reason = "The source did not provide a valid observation time. Quota and plan cannot be attributed as current.";
          } else {
            result.usage = normalizedUsage(usage);
            result.state = Date.now() - measurement.observedAt > MAX_OBSERVATION_AGE_MS
              ? "stale"
              : usage.windows.some((window) => window.usedPercent >= 100) ? "exhausted"
                : usage.windows.length === 0 ? "unknown" : "available";
            result.reason = result.state === "stale"
              ? "The last selected-source observation is older than two minutes; current quota is unknown."
              : result.state === "exhausted"
                ? "The selected source reports at least one exhausted quota window. No fallback account was selected."
                : result.state === "unknown"
                  ? "The selected source reports no quota windows. Missing limits are not zero consumption."
                  : "Host-default Claude observation for this frozen logical connection; not a receipt of the physical credential used by a turn.";
          }
        }
      }
    } catch {
      result.state = "unknown";
      result.reason = "The selected usage source could not be read. No other source was queried.";
      result.usage = null;
    }
    try {
      const latest = await inspect(input.threadId);
      if (!latest.qualified) return latest.result;
      if (latest.key !== initial.key) {
        latest.result.reason = "The binding or connection definition changed while usage was loading. Reload to inspect the frozen selection; no old quota was retained.";
        return latest.result;
      }
    } catch {
      return unknownUsage(input.threadId);
    }
    if (result.usage?.status === "ok" && result.observedAt !== null && Date.now() - result.observedAt > MAX_OBSERVATION_AGE_MS) {
      result.state = "stale";
      result.reason = "The last selected-source observation is older than two minutes; current quota is unknown.";
    }
    return result;
  };
}
