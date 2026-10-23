import type {
  SystemProviderState,
  SystemProviderStatesResponse,
  SystemProvidersQuery,
} from "@bb/server-contract";
import type { ProviderInfo, ProviderReadiness } from "@bb/domain";
import type { AppDeps } from "../../types.js";
import {
  createProviderListingBudget,
  type ProviderListingBudget,
} from "../providers/native-roots.js";
import {
  failedProviderReadiness,
  observedProviderReadiness,
  unknownProviderReadiness,
} from "../providers/provider-readiness.js";
import {
  callHostRetryableOnlineRpc,
  isHostUnavailableApiError,
} from "../hosts/online-rpc.js";
import {
  requireConnectedHostSession,
  requireEnvironment,
} from "../lib/entity-lookup.js";
import { registeredProviderInfos } from "./execution-options.js";
import { resolveSystemLookupHostId } from "./host-lookup.js";
import { resolveBridgeLaunchForProviderId } from "./provider-bridge-launch.js";
import { mapProviderMaintenanceRequests } from "./provider-maintenance-concurrency.js";
import { resolvePluginProviderEnvHealth } from "../plugins/plugin-agent-contributions.js";
import { isSuspendedHostUnavailableError } from "../lib/lifecycle-api-errors.js";

function unknownProviderState(
  provider: ProviderInfo,
  statusMessage: string,
  readiness: ProviderReadiness = {
    ...unknownProviderReadiness(statusMessage),
    verification: provider.readiness?.verification ?? "required",
    ...(provider.readiness?.verification === "unsupported"
      ? { retryAfterMs: null }
      : {}),
  },
): SystemProviderState {
  return {
    providerId: provider.id,
    displayName: provider.displayName,
    status: "unknown",
    statusMessage,
    readiness,
    accountEmail: null,
    planLabel: null,
    installedVersion: null,
    minimumSupportedVersion: null,
    canInstall: false,
    canUpdate: false,
    loginCommand: null,
    localLoginCommand: null,
  };
}

async function getProviderState(
  deps: AppDeps,
  args: {
    cwd?: string;
    hostId: string;
    provider: ProviderInfo;
    budget: ProviderListingBudget;
    scope: ProviderReadiness["scope"];
  },
): Promise<SystemProviderState> {
  if (args.provider.readiness?.status === "disabled") {
    return unknownProviderState(
      args.provider,
      args.provider.readiness.detail,
      args.provider.readiness,
    );
  }
  if (!args.provider.maintenance.health) {
    return unknownProviderState(
      args.provider,
      "This provider does not report readiness.",
    );
  }
  const bridgeLaunch = resolveBridgeLaunchForProviderId(deps, args.provider.id);
  if (bridgeLaunch === null) {
    return unknownProviderState(
      args.provider,
      "The provider bridge is unavailable.",
    );
  }

  try {
    const result = await callHostRetryableOnlineRpc(deps, {
      hostId: args.hostId,
      timeoutMs: args.budget.remainingMs(),
      command: {
        type: "provider.health",
        providerId: args.provider.id,
        bridgeLaunch,
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
      },
    });
    if (!result.supported) {
      const readiness = unknownProviderReadiness(
        "Provider readiness was not reported. Check the provider plugin before execution.",
      );
      if (args.scope === "host")
        deps.providerRegistry.observeReadiness(
          { hostId: args.hostId, providerId: args.provider.id },
          readiness,
        );
      return unknownProviderState(args.provider, readiness.detail, readiness);
    }
    let health = result.health;
    if (health.status === "unauthenticated" || health.status === "expired") {
      const contributed = await resolvePluginProviderEnvHealth({
        providerId: args.provider.id,
        hostId: args.hostId,
      });
      if (contributed !== null) {
        health = {
          ...health,
          status: "ready",
          statusMessage: contributed.statusMessage,
          accountEmail: null,
          planLabel: contributed.label,
          loginCommand: null,
          localLoginCommand: null,
        };
      }
    }
    const readiness = observedProviderReadiness(health);
    if (args.scope === "host") {
      deps.providerRegistry.observeReadiness(
        { hostId: args.hostId, providerId: args.provider.id },
        readiness,
      );
    }
    return {
      ...health,
      providerId: args.provider.id,
      displayName: args.provider.displayName,
      localLoginCommand: health.localLoginCommand ?? null,
      readiness,
    };
  } catch (error) {
    const previous =
      args.scope === "host" ? args.provider.readiness : undefined;
    const readiness = failedProviderReadiness(previous, error);
    if (args.scope === "host")
      deps.providerRegistry.observeReadiness(
        { hostId: args.hostId, providerId: args.provider.id },
        readiness,
      );
    return unknownProviderState(args.provider, readiness.detail, readiness);
  }
}

export async function getProviderStates(
  deps: AppDeps,
  query: SystemProvidersQuery,
): Promise<SystemProviderStatesResponse> {
  const hostId = resolveSystemLookupHostId(deps, query);
  const cwd =
    query.environmentId === undefined
      ? undefined
      : (requireEnvironment(deps.db, query.environmentId).path ?? undefined);
  await deps.providerRegistry.whenRegistrationsSettled();
  const scope = query.environmentId === undefined ? "host" : "environment";
  const providers = registeredProviderInfos(
    deps,
    { providerId: query.providerId, capability: query.capability },
    hostId,
  );
  try {
    requireConnectedHostSession(deps, hostId);
  } catch (error) {
    if (!isHostUnavailableApiError(error)) {
      throw error;
    }
    const statusMessage = isSuspendedHostUnavailableError(error)
      ? "Machine is paused."
      : "Provider readiness could not be checked.";
    return {
      providers: providers.map((provider) => {
        const readiness: ProviderReadiness =
          provider.readiness?.status === "disabled"
            ? provider.readiness
            : scope === "host" && provider.readiness?.checkedAt != null
              ? failedProviderReadiness(provider.readiness, error)
              : {
                  ...unknownProviderReadiness(statusMessage),
                  verification: provider.readiness?.verification ?? "required",
                  scope,
                };
        if (readiness.freshness === "stale")
          deps.providerRegistry.observeReadiness(
            { hostId, providerId: provider.id },
            readiness,
          );
        return unknownProviderState(provider, statusMessage, readiness);
      }),
    };
  }
  const budget = createProviderListingBudget();
  return {
    providers: await mapProviderMaintenanceRequests(
      providers,
      async (provider) => {
        const state = await getProviderState(deps, {
          hostId,
          provider,
          budget,
          scope,
          ...(cwd === undefined ? {} : { cwd }),
        });
        return {
          ...state,
          readiness: {
            ...(state.readiness ?? unknownProviderReadiness()),
            scope,
          },
        };
      },
    ),
  };
}
