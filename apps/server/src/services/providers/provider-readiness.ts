import type { ProviderReadiness } from "@bb/domain";
import type { SystemProviderState } from "@bb/server-contract";
import { ApiError } from "../../errors.js";

const FRESH_MS = 5 * 60_000;
const RETRY_MS = 5_000;

export interface ProviderHealthCacheKey {
  hostId: string;
  providerId: string;
}

export function unknownProviderReadiness(
  detail = "Readiness has not been checked. Refresh provider health before execution.",
): ProviderReadiness {
  return {
    verification: "required",
    scope: "host",
    status: "unknown",
    freshness: "unverified",
    checkedAt: null,
    retryAfterMs: RETRY_MS,
    detail,
  };
}

export function observedProviderReadiness(
  health: Pick<SystemProviderState, "status" | "statusMessage">,
): ProviderReadiness {
  return {
    verification: "required",
    scope: "host",
    status:
      health.status === "unauthenticated" || health.status === "expired"
        ? "auth_required"
        : health.status,
    freshness: "fresh",
    checkedAt: Date.now(),
    retryAfterMs: health.status === "unknown" ? RETRY_MS : null,
    detail:
      health.statusMessage ??
      (health.status === "ready"
        ? "Provider is ready."
        : `Provider reported ${health.status}. Check provider settings.`),
  };
}

export function failedProviderReadiness(
  previous: ProviderReadiness | undefined,
  error: unknown,
): ProviderReadiness {
  if (previous?.checkedAt != null) {
    return {
      ...previous,
      freshness: "stale",
      retryAfterMs: RETRY_MS,
      detail:
        "Readiness refresh failed; the last observation is stale. Retry shortly or check the machine connection and provider logs.",
    };
  }
  if (
    error instanceof ApiError &&
    (error.status === 502 || error.status === 504)
  ) {
    return {
      ...unknownProviderReadiness(
        "Provider initialization could not finish within the discovery budget or the machine is unavailable. Retry shortly or check the machine connection and provider logs.",
      ),
      status: "initializing",
    };
  }
  return unknownProviderReadiness(
    "Provider readiness could not be verified. Check provider settings and logs before retrying.",
  );
}

export interface ProviderReadinessCache {
  lookupReadiness(key: ProviderHealthCacheKey): ProviderReadiness | undefined;
  observeReadiness(key: ProviderHealthCacheKey, value: ProviderReadiness): void;
  resolveReadiness(
    key: ProviderHealthCacheKey,
    probe: () => Promise<ProviderReadiness>,
  ): Promise<ProviderReadiness>;
  invalidateReadiness(filter?: Partial<ProviderHealthCacheKey>): void;
}
interface ReadinessEntry extends ProviderHealthCacheKey {
  value: ProviderReadiness;
  expiresAt: number;
  retryAt: number;
  inFlight?: Promise<ProviderReadiness>;
}

export function createProviderReadinessCache(): ProviderReadinessCache {
  const entries = new Map<string, ReadinessEntry>();
  const keyOf = (key: ProviderHealthCacheKey) =>
    JSON.stringify([key.hostId, key.providerId]);
  const snapshot = (entry: ReadinessEntry): ProviderReadiness =>
    entry.expiresAt > Date.now() || entry.value.freshness !== "fresh"
      ? entry.value
      : {
          ...entry.value,
          freshness: "stale",
          retryAfterMs: RETRY_MS,
          detail:
            "Previous readiness observation expired. A refresh is in progress; retry shortly before execution.",
        };
  const cache: ProviderReadinessCache = {
    lookupReadiness(key) {
      const entry = entries.get(keyOf(key));
      return entry === undefined ? undefined : snapshot(entry);
    },
    observeReadiness(key, value) {
      entries.set(keyOf(key), {
        ...key,
        value,
        expiresAt: Date.now() + FRESH_MS,
        retryAt:
          value.status === "unknown" || value.freshness !== "fresh"
            ? Date.now() + RETRY_MS
            : 0,
      });
    },
    resolveReadiness(key, probe) {
      const id = keyOf(key);
      const previous = entries.get(id);
      if (previous?.inFlight !== undefined)
        return previous.value.checkedAt === null
          ? previous.inFlight
          : Promise.resolve(snapshot(previous));
      if (
        previous !== undefined &&
        (previous.retryAt > Date.now() ||
          (previous.value.freshness === "fresh" &&
            previous.value.status !== "unknown" &&
            previous.expiresAt > Date.now()))
      )
        return Promise.resolve(snapshot(previous));
      const entry: ReadinessEntry = previous ?? {
        ...key,
        value: {
          ...unknownProviderReadiness(
            "Provider initialization is in progress. Retry shortly; no installation failure has been confirmed.",
          ),
          status: "initializing",
        },
        expiresAt: 0,
        retryAt: 0,
      };
      entries.set(id, entry);
      const pending = Promise.resolve()
        .then(probe)
        .then(
          (value) => {
            if (entries.get(id) === entry) cache.observeReadiness(key, value);
            return value;
          },
          (error: unknown) => {
            const value = failedProviderReadiness(entry.value, error);
            if (entries.get(id) === entry) {
              entry.value = value;
              entry.retryAt = Date.now() + RETRY_MS;
              entry.inFlight = undefined;
            }
            return value;
          },
        );
      entry.inFlight = pending;
      return previous?.value.checkedAt != null
        ? Promise.resolve(snapshot(entry))
        : pending;
    },
    invalidateReadiness(filter) {
      if (filter === undefined) entries.clear();
      else
        for (const [id, entry] of entries) {
          if (
            (filter.hostId === undefined || filter.hostId === entry.hostId) &&
            (filter.providerId === undefined ||
              filter.providerId === entry.providerId)
          )
            entries.delete(id);
        }
    },
  };
  return cache;
}
