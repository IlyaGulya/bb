import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@bb/shared-ui/button";
import { ResponsiveDrawerShell } from "@bb/shared-ui/responsive-overlay";
import { cn } from "@bb/shared-ui/lib/utils";
import { BbHttpError, sdk } from "@/lib/sdk";
import { saveFile } from "@/lib/save-file";

const PREVIEW_BYTES = 65_536;
const LOG_SECTION_PATTERN = /^=== (REQUEST INFO|HEADERS|REQUEST BODY|API REQUEST|API RESPONSE|RESPONSE|WEBSOCKET TIMELINE|API WEBSOCKET TIMELINE) ===\r?$/gm;

function availabilityMessage(error: unknown): string {
  if (error instanceof BbHttpError) {
    if (error.code === "gateway_logs_scan_limit") {
      return "The bounded directory scan reached its limit before finding this thread's logs. Additional retained CPA log files may exist.";
    }
    if (error.code === "gateway_logs_unsupported") {
      return "Native CPA request logs are unsupported for this thread's persisted model binding or this server platform.";
    }
    if (error.code === "thread_not_found") {
      return "This thread is no longer available.";
    }
    if (error.status === 401 || error.status === 403) {
      return "You do not have access to these request logs. Sign in with an authorized account.";
    }
    if (error.status === 404) {
      return "This request log is no longer available. Refresh the list; retained files may have been removed.";
    }
    if (error.status === 409) {
      return "Request logs are not ready. Native CPA request logging may be off, or requests may still be streaming or settling. Refresh after the request finishes.";
    }
    if (error.status === 503) {
      return "Native CPA request logs are unavailable on this server. The read-only log directory may not be configured or accessible.";
    }
    if (error.status === 400 || error.status === 422) {
      return "Native CPA request logs are unavailable for this thread's persisted model binding.";
    }
  }
  return "Could not load native CPA request logs. Check your connection and try again.";
}

function byteLabel(bytes: number): string {
  return `${bytes.toLocaleString()} bytes`;
}

function logTime(createdAt: string): string {
  const time = new Date(createdAt);
  return Number.isNaN(time.getTime()) ? createdAt : time.toLocaleString();
}

export function GatewayLogsAction({ threadId }: { threadId: string }) {
  const [open, setOpen] = useState(false);
  const binding = useQuery({
    queryKey: ["thread-execution-binding", threadId],
    queryFn: () => sdk.experimental_executionContexts.getThreadBinding({ threadId }),
    staleTime: Infinity,
  });

  if (!binding.data?.modelConnection?.gateway) return null;

  return (
    <div className="shrink-0 px-4 pb-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        Native CPA request logs
      </Button>
      <GatewayLogsDrawer threadId={threadId} open={open} onOpenChange={setOpen} />
    </div>
  );
}

export function GatewayLogsDrawer({
  threadId,
  open,
  onOpenChange,
}: {
  threadId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <ResponsiveDrawerShell
      open={open}
      onOpenChange={onOpenChange}
      srLabel="Native CPA request logs"
      contentClassName="h-[85dvh] min-w-0 md:inset-x-6 md:mx-auto md:max-w-5xl"
    >
      <GatewayLogsContent
        key={threadId}
        threadId={threadId}
        open={open}
        onClose={() => onOpenChange(false)}
      />
    </ResponsiveDrawerShell>
  );
}

function GatewayLogsContent({
  threadId,
  open,
  onClose,
}: {
  threadId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [selection, setSelection] = useState<string | null>(null);
  const [view, setView] = useState<"raw" | "sections">("raw");
  const logs = useQuery({
    queryKey: ["gateway-logs", threadId],
    queryFn: () => sdk.experimental_gatewayLogs.list({ threadId }),
    enabled: open,
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const selectedLog = logs.data?.entries.find((entry) => entry.id === selection)
    ?? logs.data?.entries[0];
  const selectedLogId = selectedLog?.id;
  const preview = useQuery({
    queryKey: ["gateway-log-preview", threadId, selectedLogId, PREVIEW_BYTES],
    queryFn: () => {
      if (!selectedLogId) throw new Error("No request log selected");
      return sdk.experimental_gatewayLogs.read({
        threadId,
        logId: selectedLogId,
        previewBytes: PREVIEW_BYTES,
      });
    },
    enabled: open && logs.isSuccess && selectedLogId !== undefined,
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const sections = useMemo(() => {
    const raw = preview.data?.raw ?? "";
    const markers = Array.from(raw.matchAll(LOG_SECTION_PATTERN));
    return markers.map((marker, index) => ({
      title: marker[1],
      raw: raw.slice(marker.index + marker[0].length, markers[index + 1]?.index).replace(/^\r?\n/, ""),
    }));
  }, [preview.data?.raw]);
  const download = useMutation({
    mutationFn: async (logId: string) => {
      const blob = await sdk.experimental_gatewayLogs.download({ threadId, logId });
      const outcome = await saveFile({ fileName: `cpa-${logId}.log`, blob });
      if (outcome === "failed") throw new Error("Could not start the download");
    },
    retry: false,
    gcTime: 0,
  });
  const refreshing = logs.isFetching || preview.isFetching;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-gateway-logs-viewer="">
      <header className="shrink-0 space-y-2 border-b px-4 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Native CPA request logs</h3>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={refreshing}
              onClick={() => {
                void logs.refetch();
                if (selectedLogId) void preview.refetch();
              }}
            >
              {refreshing ? "Refreshing…" : "Refresh logs"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Private native CPA request logs linked by this thread's inbound header.
          Header correlation is not per-run authorization. Raw headers and bodies may
          contain sensitive content. These are request records, not per-turn traces;
          retention and streaming queue limits can leave gaps.
        </p>
      </header>
      {logs.isPending ? (
        <p role="status" className="p-4 text-sm text-muted-foreground">Loading request logs…</p>
      ) : logs.isError ? (
        <p role="alert" className="p-4 text-sm text-warning-text">{availabilityMessage(logs.error)}</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain md:flex-row md:overflow-hidden">
          <section aria-label="Request log files" className="max-h-48 shrink-0 overflow-y-auto border-b md:max-h-none md:w-64 md:border-b-0 md:border-r">
            {logs.data.scanTruncated ? (
              <p role="status" className="p-3 text-xs text-warning-text">
                The directory scan reached its limit. This list may omit request logs.
              </p>
            ) : null}
            {logs.data.unavailableFiles > 0 ? (
              <p role="status" className="p-3 text-xs text-warning-text">
                {logs.data.unavailableFiles.toLocaleString()} files could not be inspected. This list may be incomplete.
              </p>
            ) : null}
            {logs.data.entries.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">
                No completed request logs are available. Logging may be off, requests may
                still be streaming or settling, or retained files may have expired.
              </p>
            ) : (
              <ul className="p-2">
                {logs.data.entries.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className={cn(
                        "w-full rounded-md px-3 py-2 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        entry.id === selectedLogId && "bg-accent text-accent-foreground",
                      )}
                      aria-pressed={entry.id === selectedLogId}
                      onClick={() => setSelection(entry.id)}
                    >
                      <span className="block break-all font-mono">{entry.id}</span>
                      <time className="mt-1 block text-muted-foreground" dateTime={entry.createdAt}>{logTime(entry.createdAt)}</time>
                      <span className="block text-muted-foreground">{byteLabel(entry.sizeBytes)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-label="Selected request log" className="flex min-h-0 min-w-0 flex-1 flex-col md:overflow-y-auto">
            {selectedLogId ? (
              <>
                <div className="shrink-0 space-y-2 border-b p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="min-w-0 break-all font-mono text-xs">{selectedLogId}</h4>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={download.isPending}
                      onClick={() => download.mutate(selectedLogId)}
                    >
                      {download.isPending && download.variables === selectedLogId ? "Downloading…" : "Download full log"}
                    </Button>
                  </div>
                  {download.isError && download.variables === selectedLogId ? (
                    <p role="alert" className="text-xs text-warning-text">Download failed. {availabilityMessage(download.error)}</p>
                  ) : null}
                  {preview.isSuccess ? (
                    <p role="status" className={cn("text-xs", preview.data.truncated ? "text-warning-text" : "text-muted-foreground")}>
                      {preview.data.truncated
                        ? `Preview truncated to ${byteLabel(preview.data.previewBytes)} of ${byteLabel(preview.data.sizeBytes)}. Download the full log for all retained bytes.`
                        : `Complete file preview: ${byteLabel(preview.data.sizeBytes)} (preview limit ${byteLabel(preview.data.previewBytes)}).`}
                    </p>
                  ) : null}
                  {sections.length > 0 && preview.isSuccess ? (
                    <div className="flex gap-2" role="group" aria-label="Preview display">
                      <Button type="button" size="sm" variant="ghost" aria-pressed={view === "raw"} onClick={() => setView("raw")}>Raw preview</Button>
                      <Button type="button" size="sm" variant="ghost" aria-pressed={view === "sections"} onClick={() => setView("sections")}>Sections</Button>
                    </div>
                  ) : null}
                </div>
                {preview.isPending ? (
                  <p role="status" className="p-4 text-sm text-muted-foreground">Loading bounded raw preview…</p>
                ) : preview.isError ? (
                  <p role="alert" className="p-4 text-sm text-warning-text">{availabilityMessage(preview.error)}</p>
                ) : view === "sections" && sections.length > 0 ? (
                  <div className="space-y-2 p-3">
                    <p className="text-xs text-muted-foreground">Sections follow native log markers, which can also appear inside logged content. The raw preview remains authoritative.</p>
                    {sections.map((section, index) => (
                      <details key={index} open={index === 0} className="rounded-md border">
                        <summary className="cursor-pointer px-3 py-2 text-xs font-medium">{section.title}</summary>
                        <pre className="overflow-x-auto whitespace-pre-wrap break-words p-3 font-mono text-xs">{section.raw}</pre>
                      </details>
                    ))}
                  </div>
                ) : (
                  <pre aria-label="Raw request log preview" className="m-0 whitespace-pre-wrap break-words p-3 font-mono text-xs">{preview.data.raw}</pre>
                )}
              </>
            ) : (
              <p className="p-4 text-sm text-muted-foreground">Select a request log to preview its raw contents.</p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
