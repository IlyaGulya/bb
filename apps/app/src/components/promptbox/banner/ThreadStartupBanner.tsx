import { useRef } from "react";
import type { ProviderStartupDiagnostic } from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import { useThread, useThreadTimeline } from "@/hooks/queries/thread-queries";
import { useRetryThread } from "@/hooks/mutations/thread-runtime-mutations";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { ProviderRequirementBanner } from "./ProviderRequirementBanner";

function StartupFailureBanner({ threadId, diagnostic, detail }: {
  threadId: string;
  diagnostic: ProviderStartupDiagnostic;
  detail: string | null;
}) {
  const retry = useRetryThread();
  const submitting = useRef(false);
  if (retry.isSuccess) return null;
  return (
    <div className="space-y-2">
      <ProviderRequirementBanner
        title={diagnostic.retryBlocked ? "Provider stop needs verification" : diagnostic.code === "provider_startup_auth_required" ? "Authentication required for startup" : "Provider startup blocked"}
        description={detail ?? "Check target-local prerequisites before retrying. This thread and its checkpoint are retained."}
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-9"
            disabled={diagnostic.retryBlocked || retry.isPending}
            onClick={() => {
              if (submitting.current || diagnostic.retryBlocked) return;
              submitting.current = true;
              retry.mutate(threadId, { onSettled: () => { submitting.current = false; } });
            }}
          >
            {diagnostic.retryBlocked ? "Retry blocked" : retry.isPending ? "Retrying…" : "Retry this thread"}
          </Button>
        }
      />
      {retry.isError ? (
        <p role="alert" className="px-3 text-sm text-destructive-text">
          {getMutationErrorMessage({ error: retry.error, fallbackMessage: "Could not retry startup. The thread and checkpoint are unchanged." })}
        </p>
      ) : null}
    </div>
  );
}

export function ThreadStartupBanner({ threadId }: { threadId: string }) {
  const thread = useThread(threadId);
  const timeline = useThreadTimeline(threadId, { enabled: thread.data?.status === "error" && thread.data.archivedAt === null });
  if (thread.data?.status !== "error" || thread.data.archivedAt !== null) return null;
  const rows = timeline.data?.rows;
  if (!rows) return null;
  let latest: (typeof rows)[number] | undefined;
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    if (row?.kind === "system" && row.systemKind === "operation" && row.operationKind !== "parent-change" && row.providerStartup !== undefined) {
      latest = row;
      break;
    }
  }
  if (!latest || latest.kind !== "system" || latest.systemKind !== "operation" || latest.operationKind === "parent-change" || latest.status !== "error" || !latest.providerStartup) return null;
  return <StartupFailureBanner key={latest.id} threadId={threadId} diagnostic={latest.providerStartup} detail={latest.detail} />;
}
