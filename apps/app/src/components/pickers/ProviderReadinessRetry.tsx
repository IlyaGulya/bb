import type { SystemProvidersQuery } from "@bb/server-contract";
import { Button } from "@bb/shared-ui/button";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { applyProviderReadinessObservation } from "@/hooks/cache-owners/system-cache-effects";
import { sdk } from "@/lib/sdk";

export function ProviderReadinessRetry({
  providerId,
  routing = {},
}: {
  providerId: string;
  routing?: SystemProvidersQuery;
}) {
  const queryClient = useQueryClient();
  const refresh = useMutation({
    retry: false,
    mutationFn: async () => {
      const result = await sdk.system.providerStates({
        ...routing,
        providerId,
      });
      const readiness = result.providers.find(
        (provider) => provider.providerId === providerId,
      )?.readiness;
      if (readiness === undefined)
        throw new Error(
          "The provider did not report readiness. Check its plugin and machine connection.",
        );
      await applyProviderReadinessObservation({
        queryClient,
        providerId,
        routing,
        readiness,
      });
    },
  });
  return (
    <div className="mt-2 space-y-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={refresh.isPending}
        onClick={() => refresh.mutate()}
      >
        {refresh.isPending ? "Checking readiness…" : "Check readiness"}
      </Button>
      {refresh.error === null ? null : (
        <p role="alert" className="text-xs text-destructive">
          {refresh.error.message}
        </p>
      )}
    </div>
  );
}
