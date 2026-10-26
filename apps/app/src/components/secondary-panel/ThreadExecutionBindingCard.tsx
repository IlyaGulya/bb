import { useQuery } from "@tanstack/react-query";
import { DetailCard, DetailRow } from "@/components/ui/detail-card";
import { sdk } from "@/lib/sdk";

export function ThreadExecutionBindingCard({ threadId }: { threadId: string }) {
  const binding = useQuery({
    queryKey: ["thread-execution-binding", threadId],
    queryFn: () => sdk.executionContexts.getThreadBinding({ threadId }),
    staleTime: Infinity,
  });
  return (
    <div className="shrink-0 px-4 py-2">
      <DetailCard>
        {binding.isPending ? <p className="text-xs text-muted-foreground">Loading persisted execution binding…</p> : binding.isError ? <p role="alert" className="text-xs text-warning-text">Could not load persisted execution binding. <button type="button" className="underline" onClick={() => void binding.refetch()}>Retry</button></p> : <>
          <DetailRow label="Execution context">{binding.data?.executionContext?.name ?? "Unassigned (legacy)"}</DetailRow>
          <DetailRow label="Model connection">{binding.data?.modelConnection?.name ?? "Native default (legacy)"}</DetailRow>
          {binding.data?.modelConnection ? <DetailRow label="Provider · machine">{binding.data.modelConnection.provider} · {binding.data.modelConnection.hostId}</DetailRow> : null}
          <p className="mt-2 text-xs text-muted-foreground">Persisted when this thread was created. Context or connection changes apply to new threads, not hot account changes in this native session.</p>
        </>}
      </DetailCard>
    </div>
  );
}
