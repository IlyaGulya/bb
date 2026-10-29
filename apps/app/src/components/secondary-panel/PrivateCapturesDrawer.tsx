import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@bb/shared-ui/button";
import { ResponsiveDrawerShell } from "@bb/shared-ui/responsive-overlay";
import { capturePolicySchema, captureSourceSchema, type CaptureScope } from "@bb/domain";
import { sdk } from "@/lib/sdk";
import { saveFile } from "@/lib/save-file";
import { captureProductAnalyticsContext } from "@/lib/product-analytics";

type CaptureAnalytics = ReturnType<typeof captureProductAnalyticsContext>;

const api = sdk.experimental_privateCaptures;
const fieldClass = "min-h-11 w-full rounded-md border bg-background px-2 py-1 text-sm md:min-h-0";
function time(value: number | null): string { return value === null ? "unknown" : new Date(value).toLocaleString(); }
export function PrivateCapturesAction({ threadId }: { threadId: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <div className="shrink-0 px-4 pb-2"><Button type="button" variant="outline" size="sm" className="min-h-11 w-full md:min-h-0" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>Private capture</Button></div>
    <ResponsiveDrawerShell open={open} onOpenChange={setOpen} srLabel="Private capture" contentClassName="h-[85dvh] min-w-0 md:inset-x-6 md:mx-auto md:max-w-5xl">
      <PrivateCapturesContent key={threadId} threadId={threadId} open={open} onClose={() => setOpen(false)} />
    </ResponsiveDrawerShell>
  </>;
}
function PrivateCapturesContent({ threadId, open, onClose }: { threadId: string; open: boolean; onClose(): void }) {
  const eligibility = useQuery({ queryKey: ["capture-eligibility", threadId], queryFn: () => sdk.experimental_executionContexts.getThreadEligibility({ threadId }), enabled: open, retry: false, gcTime: 0, refetchOnWindowFocus: false });
  const subject = eligibility.data;
  const context = subject?.binding?.executionContext;
  const projectId = subject?.thread.projectId;
  const scope: CaptureScope | null = projectId && context ? { projectId, executionContextId: context.id } : null;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [artifactId, setArtifactId] = useState<string | null>(null);
  const [modelFilter, setModelFilter] = useState("");
  const [hostFilter, setHostFilter] = useState("");
  const [sessionFilter, setSessionFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [destination, setDestination] = useState("");
  const [after, setAfter] = useState<string | undefined>();
  const [artifactAfter, setArtifactAfter] = useState<string | undefined>();
  const [reportedModel, setReportedModel] = useState("");
  const [sourceHost, setSourceHost] = useState("");
  const [sourceRun, setSourceRun] = useState("");
  const [sourceSession, setSourceSession] = useState("");
  const [associationId, setAssociationId] = useState("");
  const [associationRun, setAssociationRun] = useState("");
  const [associationOperation, setAssociationOperation] = useState(() => crypto.randomUUID());
  const [consent, setConsent] = useState(false);
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const [importId, setImportId] = useState(() => crypto.randomUUID());
  const [nativeEvents, setNativeEvents] = useState(true);
  const [bridge, setBridge] = useState(false);
  const [cpa, setCpa] = useState(false);
  const [retention, setRetention] = useState("24");
  const [quota, setQuota] = useState("64");
  const [interval, setInterval] = useState("30");
  const [lease, setLease] = useState("300");
  const [exportsJson, setExportsJson] = useState("[]");
  const [standalone, setStandalone] = useState(false);
  const [standaloneRuntime, setStandaloneRuntime] = useState("");
  const [standaloneLinkOperation, setStandaloneLinkOperation] = useState(() => crypto.randomUUID());
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [representation, setRepresentation] = useState<"raw" | "transcript" | "binary">("transcript");
  const [reviewed, setReviewed] = useState(false);
  const list = useQuery({
    queryKey: ["private-captures", scope?.projectId, scope?.executionContextId, threadId, modelFilter, hostFilter, sessionFilter, after],
    queryFn: () => {
      if (!scope) throw new Error("capture_scope_required");
      return api.list({ ...scope, threadId, limit: 25, after, model: modelFilter || undefined, hostId: hostFilter || undefined, nativeSessionId: sessionFilter || undefined });
    }, enabled: open && scope !== null, retry: false, gcTime: 0, refetchOnWindowFocus: false,
  });
  const selected = list.isSuccess ? list.data.find(value => value.session.id === selectedId) ?? list.data[0] : undefined;
  const captureId = selected?.session.id;
  const artifacts = useQuery({
    queryKey: ["private-capture-artifacts", scope?.projectId, scope?.executionContextId, captureId, sourceFilter, destination, sourceHost, sourceRun, sourceSession, reportedModel, artifactAfter],
    queryFn: () => {
      if (!scope || !captureId) throw new Error("capture_scope_required");
      return api.artifacts({ ...scope, captureId, limit: 25, after: artifactAfter, source: sourceFilter ? captureSourceSchema.parse(sourceFilter) : undefined, destination: destination || undefined, hostId: sourceHost || undefined, runId: sourceRun || undefined, nativeSessionId: sourceSession || undefined, model: reportedModel || undefined });
    }, enabled: open && scope !== null && captureId !== undefined, retry: false, gcTime: 0, refetchOnWindowFocus: false,
  });
  const selectedArtifact = artifacts.isSuccess ? artifacts.data.find(value => value.manifest.artifactId === artifactId) ?? artifacts.data[0] : undefined;
  const refresh = async () => { await list.refetch(); if (captureId) await artifacts.refetch(); };
  const create = useMutation({
    mutationFn: async (analytics: CaptureAnalytics) => {
      if (!scope || !subject?.host || !consent) throw new Error("capture_consent_and_scope_required");
      if (standalone && !standaloneRuntime.trim()) throw new Error("capture_runtime_required");
      const policy = capturePolicySchema.parse({ consent: "private-full-content", payloadReview: "owner-approved-sensitive-application-data", retentionHours: Number(retention), maxBytes: Number(quota) * 1024 * 1024, maxArtifacts: 512, syncIntervalSeconds: Number(interval), offlineLeaseSeconds: Number(lease), bridgeRecorder: bridge, nativeEvents, cpaLogs: cpa, nativeExports: JSON.parse(exportsJson) });
      const value = await api.create({ ...scope, id: draftId, hostId: subject.host.id, threadId: standalone ? null : threadId, runId: null, nativeSessionId: null, runtimeId: standalone ? standaloneRuntime.trim() : subject.thread.providerId, runtimeVersion: null, modelConnectionId: standalone ? null : subject.binding?.modelConnection?.id ?? null, model: null, policy, analytics });
      if (standalone) await api.link({ ...scope, captureId: value.session.id, threadId, runId: null, operationId: standaloneLinkOperation, analytics });
      setSelectedId(value.session.id); setDraftId(crypto.randomUUID()); setStandaloneLinkOperation(crypto.randomUUID()); setConsent(false); setAfter(undefined); await refresh();
    }, retry: false, gcTime: 0,
  });
  const control = useMutation({
    mutationFn: async ({ operation, analytics }: { operation: "sync" | "stop"; analytics: CaptureAnalytics }) => {
      if (!scope || !captureId) throw new Error("capture_scope_required");
      await api[operation]({ ...scope, captureId, analytics }); await refresh();
    }, retry: false, gcTime: 0,
  });
  const associate = useMutation({
    mutationFn: async (analytics: CaptureAnalytics) => {
      if (!scope || !associationId) throw new Error("capture_scope_required");
      await api.link({ ...scope, captureId: associationId, threadId, runId: associationRun || null, operationId: associationOperation, analytics });
      setSelectedId(associationId); setAfter(undefined); await refresh();
    }, retry: false, gcTime: 0,
  });
  const preview = useMutation({
    mutationFn: async (analytics: CaptureAnalytics) => {
      if (!scope || !captureId || !selectedArtifact) throw new Error("capture_scope_required");
      return api.preview({ ...scope, captureId, artifactId: selectedArtifact.manifest.artifactId, previewBytes: 65536, analytics });
    }, retry: false, gcTime: 0,
  });
  const download = useMutation({
    mutationFn: async (analytics: CaptureAnalytics) => {
      if (!scope || !captureId || !selectedArtifact) throw new Error("capture_scope_required");
      const blob = await api.download({ ...scope, captureId, artifactId: selectedArtifact.manifest.artifactId, analytics });
      if (await saveFile({ fileName: `capture-${selectedArtifact.manifest.artifactId}.bin`, blob }) === "failed") throw new Error("capture_save_failed");
    }, retry: false, gcTime: 0,
  });
  const upload = useMutation({
    mutationFn: async (analytics: CaptureAnalytics) => {
      if (!scope || !captureId || !file || !reviewed) throw new Error("capture_review_required");
      await api.upload({ ...scope, captureId, operationId: importId, sourceId: file.name, file, representation, streamState: "unknown", analytics });
      setFile(null); setImportId(crypto.randomUUID()); setReviewed(false); setFileKey(value => value + 1); await refresh();
    }, retry: false, gcTime: 0,
  });
  useEffect(() => { preview.reset(); setImportId(crypto.randomUUID()); setFile(null); setReviewed(false); setFileKey(value => value + 1); }, [captureId, scope?.executionContextId]);
  useEffect(() => { preview.reset(); }, [selectedArtifact?.manifest.artifactId]);
  useEffect(() => {
    if (!open) { preview.reset(); download.reset(); setFile(null); setFileKey(value => value + 1); setReviewed(false); setConsent(false); }
  }, [open]);
  const failure = create.isError || control.isError || associate.isError || upload.isError || preview.isError || download.isError;
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col [&_button]:min-h-11 md:[&_button]:min-h-0">
    <header className="space-y-2 border-b px-4 py-3">
      <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">Private capture data</h3><div className="flex gap-2"><Button type="button" variant="outline" size="sm" onClick={() => { preview.reset(); void refresh(); void eligibility.refetch(); }}>Refresh</Button><Button type="button" variant="ghost" size="sm" onClick={onClose}>Close</Button></div></div>
      <p className="text-xs text-muted-foreground">Protected full-content application data, not analytics. Context: {context?.name ?? "unavailable"}. Payer: {subject?.binding?.modelConnection?.name ?? "unknown"}; it does not select the data scope. No capture is enabled merely by opening this drawer.</p>
    </header>
    <div className="min-h-0 space-y-4 overflow-y-auto overscroll-contain p-4">
      {eligibility.isPending ? <p role="status">Loading scope…</p> : eligibility.isError || !scope ? <p role="alert" className="text-sm text-warning-text">A persisted execution context and actual Core project are required. No scope or payer fallback is used.</p> : <>
        <details className="rounded-md border p-3">
          <summary className="cursor-pointer text-sm font-medium">Explicit opt-in and resource policy</summary>
          <div className="space-y-3 pt-3 text-sm">
            <p>Includes available retained evidence for this thread. Existing provider loggers are not enabled or reconfigured. Work exports require applicable owner permission; protected roots must be on encrypted storage. New capture preserves every source byte, including embedded credentials and private-key content, without redaction or secret-based rejection.</p>
            <label className="block"><input type="checkbox" checked={standalone} onChange={event => { setStandalone(event.target.checked); if (event.target.checked) { setNativeEvents(false); setBridge(false); setCpa(false); } }} /> Register standalone owned evidence on this host, with an explicit navigation link; this does not select a CPA endpoint or prove native execution.</label>
            {standalone && <label className="block">Exact standalone runtime ID<input className={fieldClass} value={standaloneRuntime} onChange={event => setStandaloneRuntime(event.target.value)} /></label>}
            <div className="flex flex-wrap gap-4"><label><input type="checkbox" checked={nativeEvents} onChange={event => setNativeEvents(event.target.checked)} disabled={standalone} /> Existing normalized native events</label><label><input type="checkbox" checked={bridge} onChange={event => setBridge(event.target.checked)} disabled={standalone} /> Already-enabled private bridge recorder</label><label><input type="checkbox" checked={cpa} onChange={event => setCpa(event.target.checked)} disabled={standalone || !subject?.binding?.modelConnection?.gateway} /> Retained CPA files</label></div>
            <div className="grid gap-2 md:grid-cols-4"><label>Retention hours<input className={fieldClass} type="number" min="1" max="720" value={retention} onChange={event => setRetention(event.target.value)} /></label><label>Capture quota MiB<input className={fieldClass} type="number" min="1" max="256" value={quota} onChange={event => setQuota(event.target.value)} /></label><label>Sync seconds<input className={fieldClass} type="number" min="30" max="3600" value={interval} onChange={event => setInterval(event.target.value)} /></label><label>Offline admission lease seconds<input className={fieldClass} type="number" min="30" max="3600" value={lease} onChange={event => setLease(event.target.value)} /></label></div>
            <label className="block">Explicit host-local native export registrations (JSON; empty means none)<textarea className={fieldClass} rows={3} value={exportsJson} onChange={event => setExportsJson(event.target.value)} /></label>
            <p className="text-xs text-muted-foreground">Only private files under this thread's host thread-storage root can be enrolled here. Standalone exports use their capture-specific input root via SDK/CLI. Native auth homes, arbitrary source roots and timestamp-based session association are not supported.</p>
            <label className="block"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} /> I authorize this exact project/context full-content capture and sensitive-data/export policy.</label>
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={!consent || !subject?.host || create.isPending} onClick={() => create.mutate(captureProductAnalyticsContext())}>{create.isPending ? "Admitting…" : "Create private capture"}</Button>
              <Button type="button" variant="outline" disabled={create.isPending} onClick={() => { setDraftId(crypto.randomUUID()); setConsent(false); create.reset(); }}>New capture draft</Button>
            </div>
            <p className="text-xs text-muted-foreground">Failed requests retain their opaque capture ID for safe retry. Refresh first if a response was lost. The per-artifact ceiling is 64 MiB; the configured artifact-count ceiling is 512, with explicit backpressure rather than truncation.</p>
          </div>
        </details>
        <details className="rounded-md border p-3 text-sm"><summary className="cursor-pointer">Associate existing standalone evidence</summary><div className="space-y-2 pt-2"><label className="block">Existing capture UUID in this exact project/context<input className={fieldClass} value={associationId} onChange={event => { setAssociationId(event.target.value); setAssociationOperation(crypto.randomUUID()); }} /></label><label className="block">Existing run in this thread (optional)<input className={fieldClass} value={associationRun} onChange={event => { setAssociationRun(event.target.value); setAssociationOperation(crypto.randomUUID()); }} /></label><p className="text-xs text-muted-foreground">This is an explicit owner association, not proof that the source ran in this thread. Original context, host, account, model and retention are not rewritten.</p><Button type="button" size="sm" disabled={!associationId || associate.isPending} onClick={() => associate.mutate(captureProductAnalyticsContext())}>Associate with this thread</Button></div></details>
        <div className="grid gap-2 text-sm md:grid-cols-3"><label>Machine ID filter<input className={fieldClass} value={hostFilter} onChange={event => { setHostFilter(event.target.value); setAfter(undefined); }} /></label><label>Configured model filter<input className={fieldClass} value={modelFilter} onChange={event => { setModelFilter(event.target.value); setAfter(undefined); }} /></label><label>Native session filter<input className={fieldClass} value={sessionFilter} onChange={event => { setSessionFilter(event.target.value); setAfter(undefined); }} /></label></div>
        {list.isPending ? <p role="status">Loading capture index…</p> : list.isError ? <p role="alert">Capture index unavailable or permission revoked. No payloads are shown.</p> : <>
          {list.data.length === 0 ? <p>No capture records in this exact scope/filter. This is not proof of complete capture or zero activity.</p> : <ul className="space-y-2">{list.data.map(value => <li key={value.session.id}><button type="button" className="w-full break-all rounded-md border px-3 py-2 text-left text-sm" aria-pressed={value.session.id === captureId} onClick={() => { setSelectedId(value.session.id); setArtifactId(null); setArtifactAfter(undefined); }}>{value.session.enabled ? "Enabled" : "Stopped"} · {value.session.id} · {value.storedBytes.toLocaleString()} committed bytes · gap {value.gap}</button></li>)}</ul>}
          <div className="flex gap-2"><Button type="button" size="sm" variant="outline" disabled={!after} onClick={() => setAfter(undefined)}>First page</Button><Button type="button" size="sm" variant="outline" disabled={list.data.length < 25} onClick={() => setAfter(list.data.at(-1)?.session.id)}>Next page</Button></div>
        </>}
        {selected && <section className="space-y-3 rounded-md border p-3 text-sm" aria-label="Selected capture">
          <p>Frozen machine: {selected.session.subject.hostId} · Runtime: {selected.session.subject.runtimeId} / {selected.session.subject.runtimeVersion ?? "version unknown"} · Model: {selected.session.subject.model ?? "unknown"} · Run: {selected.session.subject.runId ?? "unknown, not inferred"}</p>
          <p>Last sync: {time(selected.lastSyncAt)} · Last committed server ACK: {time(selected.lastAckAt)} · Expires: {time(selected.session.expiresAt)}</p>
          <p>Core pending: {selected.pendingBytes} bytes / {selected.pendingChunks} chunks. Host backlog: {selected.host ? `${selected.host.pendingBytes} bytes / ${selected.host.pendingChunks} chunks; known dropped ${selected.host.droppedBytes} bytes; gap ${selected.host.gap}` : "unknown / not enrolled"}. Gaps: {selected.gapCount}; latest {selected.gap}.</p>
          <p>Host collection: {selected.hostEnabled === null ? "unknown" : selected.hostEnabled ? "enabled under lease" : "disabled"}.</p>
          <p>Owner associations: {selected.links.length ? selected.links.map(link => `${link.threadId}${link.runId ? ` / ${link.runId}` : ""}`).join(", ") : "none"}; these are navigation links, not native execution provenance.</p>
          <p className="text-xs text-muted-foreground">Stop denies new Core intake immediately. A disconnected host stops collection when its bounded lease expires; it does not delete unacknowledged data before retention or turn off independent provider loggers.</p>
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={control.isPending || !selected.session.enabled} onClick={() => control.mutate({ operation: "sync", analytics: captureProductAnalyticsContext() })}>Sync now</Button>
            <Button type="button" size="sm" variant="outline" disabled={control.isPending || !selected.session.enabled} onClick={() => control.mutate({ operation: "stop", analytics: captureProductAnalyticsContext() })}>Stop new capture</Button>
          </div>
          <p>CPA is the only network capture path. Managed host/Core body files require authenticated encryption with separate protected key references; 0600 is not encryption. Original CPA source storage and intentional downloads have separate protection requirements. No process, network proxy or runtime is launched by this drawer.</p>
          <details><summary className="cursor-pointer">Actual retained evidence and coverage gaps</summary><ul className="space-y-2 pt-2 text-xs">{selected.coverage.map(value => <li key={value.source}><strong>{value.source}: {value.state}</strong> — {value.evidence}</li>)}</ul></details>
          <details>
            <summary className="cursor-pointer">Import owned evidence</summary>
            <div className="space-y-2 pt-2">
              <input key={fileKey} type="file" onChange={event => { setFile(event.target.files?.[0] ?? null); setImportId(crypto.randomUUID()); setReviewed(false); }} />
              <label className="block">Representation<select className={fieldClass} value={representation} onChange={event => { setRepresentation(event.target.value === "binary" ? "binary" : event.target.value === "raw" ? "raw" : "transcript"); setImportId(crypto.randomUUID()); }}><option value="transcript">Transcript</option><option value="raw">Raw text</option><option value="binary">Reviewed binary</option></select></label>
              <label className="block"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} /> I authorize every byte of this owned file, including any embedded credentials, for this exact private context.</label>
              <Button type="button" size="sm" disabled={!reviewed || !file || upload.isPending || !selected.session.enabled} onClick={() => upload.mutate(captureProductAnalyticsContext())}>{upload.isPending ? "Importing…" : "Import with resumable ACK"}</Button>
              <p className="text-xs text-muted-foreground">Stream state is unknown, not inferred. Retry the same file to resume; no browser raw-payload outbox is created. Payload checksums never become analytics operation IDs.</p>
            </div>
          </details>
          <div className="grid gap-2 md:grid-cols-2"><label>Source filter<select className={fieldClass} value={sourceFilter} onChange={event => { setSourceFilter(event.target.value); setArtifactAfter(undefined); }}><option value="">All evidence sources</option>{captureSourceSchema.options.map(value => <option key={value} value={value}>{value}</option>)}</select></label><label>Exact reported destination<input className={fieldClass} value={destination} onChange={event => { setDestination(event.target.value); setArtifactAfter(undefined); }} /></label></div>
          <details><summary className="cursor-pointer">Source-reported evidence filters</summary><div className="grid gap-2 pt-2 md:grid-cols-2"><label>Known source machine<input className={fieldClass} value={sourceHost} onChange={event => { setSourceHost(event.target.value); setArtifactAfter(undefined); }} /></label><label>Actual source run<input className={fieldClass} value={sourceRun} onChange={event => { setSourceRun(event.target.value); setArtifactAfter(undefined); }} /></label><label>Actual native session<input className={fieldClass} value={sourceSession} onChange={event => { setSourceSession(event.target.value); setArtifactAfter(undefined); }} /></label><label>Reported model label<input className={fieldClass} value={reportedModel} onChange={event => { setReportedModel(event.target.value); setArtifactAfter(undefined); }} /></label></div></details>
          {artifacts.isPending ? <p role="status">Loading artifacts…</p> : artifacts.isError ? <p role="alert">Artifact index unavailable or permission revoked.</p> : artifacts.isSuccess && <>
            {artifacts.data.length === 0 ? <p>No retained artifacts in this filter.</p> : <ul className="space-y-2">{artifacts.data.map(value => <li key={value.manifest.artifactId}><button type="button" className="w-full break-all rounded-md border px-2 py-1 text-left text-xs" aria-pressed={value.manifest.artifactId === selectedArtifact?.manifest.artifactId} onClick={() => { setArtifactId(value.manifest.artifactId); preview.reset(); }}>{value.manifest.source} · {value.manifest.representation} · {value.manifest.sourceId} · {value.manifest.storedBytes} bytes · {value.rejectedAt !== null ? "privacy rejected; no body access" : value.completedAt === null ? "incomplete" : "file verified"}</button></li>)}</ul>}
            <div className="flex gap-2"><Button type="button" variant="outline" size="sm" disabled={!artifactAfter} onClick={() => setArtifactAfter(undefined)}>First artifacts</Button><Button type="button" variant="outline" size="sm" disabled={artifacts.data.length < 25} onClick={() => setArtifactAfter(artifacts.data.at(-1)?.manifest.artifactId)}>Next artifacts</Button></div>
          </>}
          {selectedArtifact && <div className="space-y-2 break-all text-xs">
            <p>Source SHA-256: {selectedArtifact.manifest.sourceSha256}</p>
            <p>Stored SHA-256: {selectedArtifact.manifest.storedSha256}</p>
            <p>Manifest v{selectedArtifact.manifest.version} · {selectedArtifact.manifest.fidelity} · {selectedArtifact.manifest.redactionPolicy} · stream {selectedArtifact.manifest.streamState}. {selectedArtifact.manifest.version === 1 ? "Historical artifact: original labels and bytes are unchanged; not fresh byte-preserving capture." : "Exact admitted source bytes are retained, including credentials. Normalized events remain normalized, not original wire bytes."}</p>
            <p>Known source machine: {selectedArtifact.manifest.hostId ?? "unknown"} · Run: {selectedArtifact.manifest.runId ?? "unknown"} · Native session: {selectedArtifact.manifest.nativeSessionId ?? "unknown"} · Reported model labels: {selectedArtifact.manifest.models.join(", ") || "unknown"}. {selectedArtifact.manifest.indexLimited ? "Index bounded; inspect the full stored source for remaining labels/destinations." : "Reported labels are not payer or upstream-routing certification."}</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" disabled={selectedArtifact.completedAt === null || preview.isPending} onClick={() => preview.mutate(captureProductAnalyticsContext())}>Inspect bounded body</Button>
              <Button type="button" size="sm" variant="outline" disabled={selectedArtifact.completedAt === null || download.isPending} onClick={() => download.mutate(captureProductAnalyticsContext())}>Download and verify full file</Button>
            </div>
          </div>}
          {preview.isSuccess && artifacts.isSuccess && preview.data.artifactId === selectedArtifact?.manifest.artifactId && <div className="space-y-2 text-xs"><p>{preview.data.previewBytes} of {preview.data.sizeBytes} bytes · {preview.data.encoding} · {preview.data.truncated ? "preview truncated; full download preserves all stored bytes" : "complete stored body"}</p><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md border p-2">{preview.data.raw}</pre></div>}
        </section>}
      </>}
      {failure && <p role="alert" className="text-sm text-warning-text">Capture action failed or was refused. Check permission, source availability, consent, quotas and integrity; no unsupported fallback or success is assumed. Refresh for current scope/status.</p>}
    </div>
  </div>;
}
