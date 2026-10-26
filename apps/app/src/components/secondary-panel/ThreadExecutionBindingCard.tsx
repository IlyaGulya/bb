import { useQuery } from "@tanstack/react-query";
import { DetailCard, DetailRow } from "@/components/ui/detail-card";
import { sdk } from "@/lib/sdk";
import { useThread } from "@/hooks/queries/thread-queries";
import { useEnvironment } from "@/hooks/queries/environment-queries";
import { useHosts } from "@/hooks/queries/host-queries";

export function ThreadExecutionBindingCard({ threadId }: { threadId: string }) {
  const thread = useThread(threadId);
  const environment = useEnvironment(thread.data?.environmentId);
  const hosts = useHosts();
  const executionHostId = environment.data?.hostId;
  const executionHost = hosts.data?.find((host) => host.id === executionHostId);
  const binding = useQuery({
    queryKey: ["thread-execution-binding", threadId],
    queryFn: () =>
      sdk.experimental_executionContexts.getThreadBinding({ threadId }),
    staleTime: Infinity,
  });
  return (
    <div className="shrink-0 px-4 py-2">
      <DetailCard>
        {binding.isPending ? (
          <p className="text-xs text-muted-foreground">
            Loading persisted execution binding…
          </p>
        ) : binding.isError ? (
          <p role="alert" className="text-xs text-warning-text">
            Could not load persisted execution binding.{" "}
            <button
              type="button"
              className="underline"
              onClick={() => void binding.refetch()}
            >
              Retry
            </button>
          </p>
        ) : (
          <>
            <DetailRow label="Execution context">
              {binding.data?.executionContext?.name ?? "Unassigned (legacy)"}
            </DetailRow>
            <DetailRow label="Model connection">
              {binding.data?.modelConnection?.name ?? "Native default (legacy)"}
            </DetailRow>
            {binding.data?.modelConnection ? (
              <DetailRow label="Provider · machine">
                {binding.data.modelConnection.provider} ·{" "}
                {binding.data.modelConnection.hostId}
              </DetailRow>
            ) : null}
            <DetailRow label="Execution machine">
              {executionHost?.name ??
                executionHostId ??
                (thread.isError || environment.isError
                  ? "Unavailable"
                  : thread.isPending || environment.isFetching
                    ? "Loading…"
                    : "No execution environment")}
            </DetailRow>
            <DetailRow label="Context MCP servers">
              {binding.data?.executionContext?.mcpServers.length
                ? binding.data.executionContext.mcpServers.map((ref) => (
                    <div
                      key={`${ref.name}:${ref.configPath}`}
                      className="break-all"
                    >
                      <span className="font-medium">{ref.name}</span>
                      <span className="block text-muted-foreground">
                        {ref.configPath}
                      </span>
                    </div>
                  ))
                : "None selected (native defaults unchanged)"}
            </DetailRow>
            <p className="mt-2 text-xs text-muted-foreground">
              MCP sources and native authentication are local to the execution
              machine, independently of the model connection. Authentication is
              not checked here.
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Persisted when this thread was created. Context or connection
              changes apply to new threads, not hot account changes in this
              native session.
            </p>
          </>
        )}
      </DetailCard>
    </div>
  );
}
