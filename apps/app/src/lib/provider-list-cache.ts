import { providerInfoSchema, type ProviderInfo } from "@bb/domain";
import { z } from "zod";
import { createLastKnownCache } from "@/lib/last-known-cache";

const providerListCache = createLastKnownCache({
  prefix: "bb.provider-list",
  version: "2",
  schema: z.array(providerInfoSchema),
  maxEntries: 16,
});

export function providerListCacheKey({
  environmentId,
  hostId,
}: {
  environmentId: string | null;
  hostId: string | null;
}): string {
  return providerListCache.key(environmentId, hostId);
}

export function readCachedProviderList(key: string): ProviderInfo[] | null {
  return (
    providerListCache
      .read(key)
      ?.map((provider): ProviderInfo =>
        provider.readiness === undefined
          ? provider
          : {
              ...provider,
              readiness: {
                ...provider.readiness,
                freshness:
                  provider.readiness.checkedAt === null
                    ? "unverified"
                    : "stale",
                detail:
                  "Cached observation; refresh provider readiness before execution.",
              },
            },
      ) ?? null
  );
}
export const writeCachedProviderList = providerListCache.write;
