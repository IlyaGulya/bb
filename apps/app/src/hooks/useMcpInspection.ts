import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { McpConfigurationInspection } from "@bb/domain";
import { sdk } from "@/lib/sdk";

export type McpInspectionQuery = UseQueryResult<McpConfigurationInspection, Error>;

export function useMcpInspection({
  hostId,
  providerId,
  configPaths,
  enabled = true,
}: {
  hostId: string | null;
  providerId: string;
  configPaths: string[];
  enabled?: boolean;
}) {
  const paths = [...new Set(configPaths)].sort();
  return useQuery({
    queryKey: ["mcp-inspection", hostId, providerId, paths],
    queryFn: () => {
      if (hostId === null) throw new Error("Choose an execution machine.");
      return sdk.experimental_executionContexts.inspectMcp({
        hostId,
        providerId,
        configPaths: paths,
      });
    },
    enabled: enabled && hostId !== null && providerId !== "" && paths.length > 0,
    retry: false,
    staleTime: 0,
  });
}
