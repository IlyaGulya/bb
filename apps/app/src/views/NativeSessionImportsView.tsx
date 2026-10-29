import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { Textarea } from "@bb/shared-ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@bb/shared-ui/select";
import { nativeImportContinueSchema, nativeImportDiscoverSchema, type NativeImportManifest, type NativeImportRecord } from "@bb/server-contract";
import type { NativeSessionSource } from "@bb/sdk";
import { PageShell } from "@/components/ui/page-shell";
import { sdk } from "@/lib/sdk";
import { saveFile } from "@/lib/save-file";
import { getThreadRoutePath } from "@/lib/route-paths";

const sourceKey = (source: NativeSessionSource) => `${source.engine}:${source.rootPath}:${source.path}`;
const providerFor = (source: NativeSessionSource) => source.engine === "omp" ? "acp-omp" : source.engine === "claude" ? "claude-code" : "codex";
const decode = (content: string) => new TextDecoder().decode(Uint8Array.from(atob(content), (character) => character.charCodeAt(0)));
const bytesLabel = (bytes: number) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(bytes);
const modeLabel = (mode: NativeImportManifest["mode"]) => mode === "archive" ? "Archive only" : mode === "native-admitted" ? "Native identity admitted" : "Separate handoff thread";
function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="flex min-w-0 flex-col gap-2 text-sm"><span className="font-medium">{label}</span>{children}{hint && <span className="text-muted-foreground">{hint}</span>}</label>;
}
function Choice({ label, value, onChange, options, placeholder = "Choose…", disabled = false }: {
  label: string; value: string; onChange(value: string): void; options: { value: string; label: string; disabled?: boolean }[]; placeholder?: string; disabled?: boolean;
}) {
  return <Field label={label}><Select value={value} onValueChange={onChange} disabled={disabled}><SelectTrigger aria-label={label} className="w-full"><SelectValue placeholder={placeholder} /></SelectTrigger><SelectContent>{options.map((option) => <SelectItem key={option.value} value={option.value} disabled={option.disabled}>{option.label}</SelectItem>)}</SelectContent></Select></Field>;
}
function Download({ importId, file, name, children }: { importId: string; file: string; name: string; children: ReactNode }) {
  const url = `/api/v1/native-session-imports/file?${new URLSearchParams({ importId, file })}`;
  return <a className="break-words text-sm underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" href={url} download={name} onClick={(event) => { event.preventDefault(); void saveFile({ fileName: name, url }); }}>{children}</a>;
}
export function NativeSessionImportsView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const importId = searchParams.get("importId") ?? "";
  const queryClient = useQueryClient();
  const [hostId, setHostId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [engine, setEngine] = useState("omp");
  const [root, setRoot] = useState("");
  const [profile, setProfile] = useState("");
  const [artifactRoots, setArtifactRoots] = useState("");
  const [found, setFound] = useState<NativeSessionSource[]>([]);
  const [selected, setSelected] = useState(new Set<string>());
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [hasDiscovered, setHasDiscovered] = useState(false);
  const [jobs, setJobs] = useState<NativeImportManifest[]>([]);
  const [preview, setPreview] = useState<{ source: NativeSessionSource; offset: number; content: string; size: number; length: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const discoveryController = useRef<AbortController | null>(null);
  const discoveryVersion = useRef(0);
  const hosts = useQuery({ queryKey: ["native-session-import", "hosts"], queryFn: ({ signal }) => sdk.hosts.list({ signal }) });
  const projects = useQuery({ queryKey: ["native-session-import", "projects"], queryFn: ({ signal }) => sdk.projects.list({ signal }) });
  const manifest = useQuery({ queryKey: ["native-session-import", importId], enabled: Boolean(importId), queryFn: ({ signal }) => sdk.experimental_nativeSessionImports.get({ importId, signal }), refetchInterval: (query) => query.state.data?.status === "importing" ? 1000 : false });
  const active = manifest.data;
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => () => { discoveryController.current?.abort(); }, []);
  async function act(name: string, work: () => Promise<void>) {
    setBusy(name); setError(null);
    try { await work(); } catch (error) {
      if (name === "discover" && discoveryController.current?.signal.aborted) setWarnings((previous) => [...previous, "Discovery cancelled. It did not start an import or a native runtime."]);
      else setError(error instanceof Error ? error.message : "The action could not be completed. Your saved import remains available.");
    }
    finally { setBusy(null); }
  }
  function resetDiscovery() {
    discoveryVersion.current++; discoveryController.current?.abort();
    setFound([]); setSelected(new Set()); setPreview(null); setNextCursor(null); setWarnings([]); setHasDiscovered(false);
  }
  async function discover(cursor: number) {
    const request = nativeImportDiscoverSchema.parse({ hostId, roots: [{ engine, path: root.trim(), profile: profile.trim(), artifactRoots: artifactRoots.split("\n").map((value) => value.trim()).filter(Boolean) }], cursor, limit: 100 });
    const controller = new AbortController();
    discoveryController.current = controller;
    const version = discoveryVersion.current;
    const result = await sdk.experimental_nativeSessionImports.discover({ ...request, signal: controller.signal });
    if (version !== discoveryVersion.current) return;
    setFound((previous) => cursor === 0 ? result.sessions : [...new Map([...previous, ...result.sessions].map((source) => [sourceKey(source), source])).values()]);
    setNextCursor(result.nextCursor); setHasDiscovered(true);
    setWarnings([...result.warnings, ...(result.incomplete ? ["Discovery reached its safety boundary. Select a narrower source directory to see the rest."] : [])]);
  }
  async function showPreview(source: NativeSessionSource, offset: number) {
    const result = await sdk.experimental_nativeSessionImports.preview({ hostId, source, offset, length: 65536 });
    setPreview({ source, offset, content: decode(result.content), size: result.sizeBytes, length: atob(result.content).length });
  }
  async function start() {
    const chosen = found.filter((source) => selected.has(sourceKey(source)));
    if (!projectId || !chosen.length) throw new Error("Choose a destination project and at least one source session.");
    const imports: NativeImportManifest[] = [];
    const failures: string[] = [];
    for (let offset = 0; offset < chosen.length; offset += 100) {
      const result = await sdk.experimental_nativeSessionImports.start({ selections: chosen.slice(offset, offset + 100).map((source) => ({ hostId, projectId, source })) });
      imports.push(...result.imports);
      failures.push(...result.failures.map((failure) => `${chosen[offset + failure.index]?.title ?? "Selected session"}: ${failure.message}`));
    }
    setJobs((previous) => [...new Map([...previous, ...imports].map((job) => [job.id, job])).values()]);
    if (imports[0]) setSearchParams({ importId: imports[0].id });
    if (failures.length) setError(failures.join("\n"));
  }
  const unavailable = hosts.error ?? projects.error ?? manifest.error;
  return <PageShell maxWidthClassName="max-w-5xl" contentClassName="gap-8 pt-6">
    <header className="flex flex-col gap-3"><Link to="/" className="w-fit text-sm text-muted-foreground underline underline-offset-4">Back to new thread</Link><h1 className="text-xl font-semibold">Import native history</h1><p className="max-w-prose text-sm text-muted-foreground">Keep OMP, Claude Code and Codex conversations in BB without starting agents or creating Tasks. Import the full recorded data first; choose native continuation or a clearly separate handoff afterward.</p></header>
    {(error || unavailable) && <div ref={errorRef} role="alert" tabIndex={-1} className="break-words whitespace-pre-wrap rounded-md border border-destructive/40 p-4 text-sm text-destructive">{error ?? (unavailable instanceof Error ? unavailable.message : "Could not load saved data. Try the action again when the server is available.")}</div>}
    <section aria-labelledby="native-source-heading" className="flex flex-col gap-5"><div><h2 id="native-source-heading" className="text-base font-semibold">Find source sessions</h2><p className="mt-1 text-sm text-muted-foreground">Choose history directories explicitly, including work-profile or overridden roots. Profile labels describe provenance, not accounts or payers. No credentials are transferred.</p></div>
      {(hosts.isPending || projects.isPending) && <p role="status" className="text-sm text-muted-foreground">Loading machines and projects…</p>}
      <fieldset disabled={busy !== null} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <Choice label="Source machine" value={hostId} onChange={(value) => { setHostId(value); resetDiscovery(); }} options={(hosts.data ?? []).map((host) => ({ value: host.id, label: `${host.name}${host.status !== "connected" ? " · unavailable" : ""}`, disabled: host.status !== "connected" }))} />
        <Choice label="Native engine" value={engine} onChange={(value) => { setEngine(value); resetDiscovery(); }} options={[{ value: "omp", label: "OMP" }, { value: "claude", label: "Claude Code" }, { value: "codex", label: "Codex" }]} />
        <Field label="Session-history directory" hint="An absolute directory on the source machine. Only native JSONL histories are discovered."><Input value={root} onChange={(event) => { setRoot(event.target.value); resetDiscovery(); }} placeholder="/path/to/session-history" spellCheck={false} /></Field>
        <Field label="Source profile label" hint="For example, the label you use for your work configuration. This never selects a payer."><Input value={profile} onChange={(event) => { setProfile(event.target.value); resetDiscovery(); }} /></Field>
        <div className="sm:col-span-2"><Field label="Referenced-artifact directories" hint="Optional: one absolute blob/artifact directory per line. Only references present in a selected native record can be copied; auth/configuration files and neighboring sessions are refused."><Textarea rows={2} value={artifactRoots} onChange={(event) => { setArtifactRoots(event.target.value); resetDiscovery(); }} spellCheck={false} /></Field></div>
      </fieldset>
      <div className="flex flex-wrap items-center gap-3"><Button disabled={busy !== null || !hostId || !root.trim() || !profile.trim()} onClick={() => void act("discover", () => discover(0))}>{busy === "discover" ? "Finding sessions…" : "Find sessions"}</Button>{busy === "discover" && <Button variant="outline" onClick={() => discoveryController.current?.abort()}>Cancel discovery</Button>}<span className="text-sm text-muted-foreground">Nothing is imported or resumed by discovery.</span></div>
      {warnings.length > 0 && <ul className="space-y-2 text-sm text-muted-foreground">{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      {hasDiscovered && found.length === 0 && <p className="py-4 text-sm">No supported sessions were found in this directory. Check the selected engine and explicit history root; authentication directories are not session histories.</p>}
      {found.length > 0 && <div className="border-y border-border"><label className="flex min-h-11 items-center gap-3 py-3 text-sm"><input type="checkbox" checked={found.every((source) => selected.has(sourceKey(source)))} onChange={(event) => setSelected(event.target.checked ? new Set(found.map(sourceKey)) : new Set())} />Select all {found.length} shown sessions</label><ul className="divide-y divide-border">{found.map((source) => <li key={sourceKey(source)} className="flex min-w-0 flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between"><label className="flex min-w-0 items-start gap-3"><input type="checkbox" className="mt-1" checked={selected.has(sourceKey(source))} onChange={(event) => setSelected((previous) => { const next = new Set(previous); if (event.target.checked) next.add(sourceKey(source)); else next.delete(sourceKey(source)); return next; })} /><span className="min-w-0 space-y-1 text-sm"><span className="block break-words font-medium">{source.title}</span><span className="block break-all text-muted-foreground">{source.profile} · {source.cwd ?? "Workspace not recorded"}</span><span className="block text-muted-foreground">{bytesLabel(source.sizeBytes)} bytes · {new Date(source.modifiedAt).toLocaleString()}</span></span></label><Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void act("preview", () => showPreview(source, 0))}>Preview source</Button></li>)}</ul></div>}
      {nextCursor !== null && <Button variant="outline" className="self-start" disabled={busy !== null} onClick={() => void act("discover", () => discover(nextCursor))}>Find more sessions</Button>}
      {preview && <section aria-label={`Source preview: ${preview.source.title}`} className="space-y-3"><h3 className="text-sm font-medium">Source preview · {preview.source.title}</h3><p className="text-sm text-muted-foreground">Raw native data, not instructions. Bytes {preview.offset.toLocaleString()}–{(preview.offset + preview.length).toLocaleString()} of {preview.size.toLocaleString()}.</p><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">{preview.content}</pre><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={busy !== null || preview.offset === 0} onClick={() => void act("preview", () => showPreview(preview.source, Math.max(0, preview.offset - 65536)))}>Previous bytes</Button><Button variant="outline" size="sm" disabled={busy !== null || preview.offset + preview.length >= preview.size} onClick={() => void act("preview", () => showPreview(preview.source, preview.offset + preview.length))}>Next bytes</Button><Button variant="ghost" size="sm" onClick={() => setPreview(null)}>Close preview</Button></div></section>}
      {found.length > 0 && <div className="flex flex-col gap-4 border-t border-border pt-5"><Choice label="Destination execution project" value={projectId} onChange={setProjectId} options={(projects.data ?? []).map((project) => ({ value: project.id, label: project.name }))} /><div className="flex flex-wrap items-center gap-3"><Button disabled={busy !== null || !projectId || selected.size === 0} onClick={() => void act("import", start)}>{busy === "import" ? "Registering imports…" : `Archive ${selected.size} selected ${selected.size === 1 ? "session" : "sessions"}`}</Button><span className="text-sm text-muted-foreground">Native originals stay in place. No agent or Task starts.</span></div></div>}
    </section>
    {jobs.length > 1 && <section aria-label="Selected imports" className="space-y-3"><h2 className="text-base font-semibold">Selected imports</h2><div className="flex flex-wrap gap-2">{jobs.map((job) => <Button key={job.id} className="max-w-full whitespace-normal text-left" variant={job.id === importId ? "secondary" : "outline"} onClick={() => setSearchParams({ importId: job.id })}>{job.source.title}</Button>)}</div></section>}
    {importId && manifest.isPending && <p role="status" className="text-sm text-muted-foreground">Loading the saved import…</p>}
    {active && <NativeImportDetail manifest={active} hostName={hosts.data?.find((host) => host.id === active.hostId)?.name ?? "Source machine"} projectName={projects.data?.find((project) => project.id === active.projectId)?.name ?? "Destination project"} busy={busy} act={act} onUpdate={async (next) => { queryClient.setQueryData(["native-session-import", importId], next); await queryClient.invalidateQueries({ queryKey: ["native-session-import", "thread", next.threadId] }); }} />}
  </PageShell>;
}
function NativeImportDetail({ manifest, hostName, projectName, busy, act, onUpdate }: {
  manifest: NativeImportManifest; hostName: string; projectName: string; busy: string | null;
  act(name: string, work: () => Promise<void>): Promise<void>; onUpdate(manifest: NativeImportManifest): Promise<void>;
}) {
  const [after, setAfter] = useState(0);
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [raw, setRaw] = useState<{ record: NativeImportRecord; offset: number; content: string; length: number } | null>(null);
  const records = useQuery({ queryKey: ["native-session-import", "records", manifest.id, after, query, manifest.records], enabled: manifest.records > 0,
    queryFn: ({ signal }) => sdk.experimental_nativeSessionImports.records({ importId: manifest.id, after, query, limit: 25, signal }) });
  useEffect(() => { setAfter(0); setQuery(""); setQueryInput(""); setRaw(null); }, [manifest.id]);
  async function readRecord(record: NativeImportRecord, offset: number) {
    const result = await sdk.experimental_nativeSessionImports.bytes({ importId: manifest.id, file: "native", offset: record.offset + offset, length: Math.min(65536, record.length - offset) });
    setRaw({ record, offset, content: decode(result.content), length: atob(result.content).length });
  }
  return <section aria-labelledby="native-import-heading" className="flex flex-col gap-6 border-t border-border pt-6"><header className="space-y-2"><h2 id="native-import-heading" className="break-words text-base font-semibold">{manifest.source.title}</h2><p className="text-sm font-medium">{modeLabel(manifest.mode)} · {manifest.status}</p><p className="max-w-prose text-sm text-muted-foreground">{manifest.reason}</p></header>
    <dl className="grid gap-4 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">Source</dt><dd className="mt-1 break-all">{hostName} · {manifest.source.profile} · {manifest.source.engine}</dd></div><div><dt className="text-muted-foreground">Destination</dt><dd className="mt-1">{projectName}</dd></div><div><dt className="text-muted-foreground">Native state remains on the source machine</dt><dd className="mt-1 break-all">{manifest.source.path}<br />{manifest.source.cwd ?? "Workspace was not recorded"}</dd></div><div><dt className="text-muted-foreground">BB archive</dt><dd className="mt-1">Private persistent server data, under native-session-imports. Separate from model context; not a backup of all agent files.</dd></div></dl>
    <div role="status" aria-live="polite" className="space-y-2"><p className="text-sm tabular-nums">{manifest.bytes.toLocaleString()} / {manifest.source.sizeBytes.toLocaleString()} committed bytes · {manifest.records.toLocaleString()} native records</p><progress aria-label="Committed native archive bytes" className="h-2 w-full accent-primary" max={Math.max(1, manifest.source.sizeBytes)} value={manifest.bytes} /></div>
    {manifest.error && <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">{manifest.error} The committed boundary is retained. Rediscover a changed source before retrying.</p>}
    <div className="flex flex-wrap gap-3">
      {manifest.status === "importing" ? <Button variant="outline" disabled={busy !== null} onClick={() => void act("cancel", async () => { await onUpdate(await sdk.experimental_nativeSessionImports.cancel({ importId: manifest.id })); })}>Cancel import</Button> : manifest.status !== "ready" && <Button disabled={busy !== null} onClick={() => void act("resume", async () => { await onUpdate(await sdk.experimental_nativeSessionImports.resume({ importId: manifest.id })); })}>Resume import processing</Button>}
      {manifest.threadId && <Link className="inline-flex min-h-10 items-center text-sm underline underline-offset-4" to={getThreadRoutePath({ projectId: manifest.projectId, threadId: manifest.threadId })}>Open Core conversation</Link>}
      {manifest.bytes > 0 && <Download importId={manifest.id} file="native" name="native-session.jsonl">Download {manifest.status === "ready" ? "full" : "committed"} native JSONL</Download>}
    </div>
    <details className="text-sm"><summary className="cursor-pointer font-medium">Boundary and original identity</summary><dl className="mt-3 space-y-2 break-all"><div><dt className="text-muted-foreground">Original native session ID</dt><dd>{manifest.source.sessionId}</dd></div><div><dt className="text-muted-foreground">Committed boundary SHA-256</dt><dd className="font-mono text-xs">{manifest.boundarySha256 ?? "No complete record has been committed yet"}</dd></div><div><dt className="text-muted-foreground">Import reference</dt><dd className="font-mono text-xs">{manifest.id}</dd></div></dl></details>
    {manifest.records > 0 && <section aria-label="Retained native record browser" className="space-y-4"><h3 className="text-base font-semibold">Recorded history and native state</h3><p className="text-sm text-muted-foreground">Messages and tools are projected into the Core conversation. This index also keeps service records, branches, checkpoints and compaction state. Pagination changes presentation, not preservation.</p><form className="flex flex-col gap-2 sm:flex-row" onSubmit={(event) => { event.preventDefault(); setQuery(queryInput); setAfter(0); }}><Input aria-label="Search complete retained history and tool results" placeholder="Search messages, tools or native IDs" value={queryInput} onChange={(event) => setQueryInput(event.target.value)} maxLength={1024} /><Button type="submit" variant="outline">Search retained data</Button></form><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => setAfter(0)}>Beginning</Button><Button variant="outline" size="sm" onClick={() => setAfter(Math.max(0, Math.floor(manifest.records / 2) - 1)))}>Middle</Button><Button variant="outline" size="sm" onClick={() => setAfter(Math.max(0, manifest.records - 25))}>End</Button></div>
      {records.isPending && <p role="status" className="text-sm text-muted-foreground">Loading retained records…</p>}{records.error && <p role="alert" className="text-sm text-destructive">{records.error.message}</p>}{records.data && records.data.records.length === 0 && <p className="text-sm">No matching records in this window.{records.data.nextAfter !== null ? " Continue searching the next window." : " Try another search or return to the beginning."}</p>}
      <ol className="divide-y divide-border border-y border-border">{records.data?.records.map((record) => <li key={record.ordinal} className="space-y-2 py-4"><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-medium">Record {record.ordinal} · {record.type}</span><span className="text-xs text-muted-foreground">{record.timestamp === null ? "Native timestamp not recorded" : new Date(record.timestamp).toLocaleString()}</span></div><p className="whitespace-pre-wrap break-words text-sm">{record.preview || "Native state record; retained byte-for-byte."}</p><details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Original links and provenance</summary><p className="mt-2 break-all">Native ID: {record.nativeId ?? "not recorded"}<br />Native parent: {record.parentId ?? "not recorded"}<br />Original bytes: {record.offset}–{record.offset + record.length}<br />Core sequence window: {record.sourceSeqStart}–{record.sourceSeqEnd}</p></details><Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void act("record", () => readRecord(record, 0))}>Read complete native record</Button></li>)}</ol>
      {records.data?.nextAfter !== null && records.data?.nextAfter !== undefined && <Button variant="outline" disabled={records.isFetching} onClick={() => { if (records.data?.nextAfter !== null && records.data?.nextAfter !== undefined) setAfter(records.data.nextAfter); }}>Next record window</Button>}
      {raw && <div className="space-y-3"><h4 className="text-sm font-medium">Original record {raw.record.ordinal} · bytes {raw.offset.toLocaleString()}–{(raw.offset + raw.length).toLocaleString()} of {raw.record.length.toLocaleString()}</h4><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">{raw.content}</pre><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={busy !== null || raw.offset === 0} onClick={() => void act("record", () => readRecord(raw.record, Math.max(0, raw.offset - 65536)))}>Previous record bytes</Button><Button variant="outline" size="sm" disabled={busy !== null || raw.offset + raw.length >= raw.record.length} onClick={() => void act("record", () => readRecord(raw.record, raw.offset + raw.length)))}>Next record bytes</Button><Button variant="ghost" size="sm" onClick={() => setRaw(null)}>Close record</Button></div></div>}
    </section>}
    {manifest.artifacts.length > 0 && <section className="space-y-3" aria-label="Referenced native artifacts"><h3 className="text-base font-semibold">Referenced artifacts</h3><ul className="space-y-3">{manifest.artifacts.map((artifact) => <li key={artifact.file} className="space-y-1 break-all text-sm">{artifact.status === "ready" ? <Download importId={manifest.id} file={artifact.file} name={artifact.reference.split(/[\\/]/).pop() || "native-artifact"}>{artifact.reference}</Download> : <span className="text-destructive">{artifact.reference} · unavailable: {artifact.reason}</span>}<p className="font-mono text-xs text-muted-foreground">{artifact.sha256 ?? "Not captured"}</p></li>)}</ul></section>}
    {manifest.status === "ready" && <NativeContinuation manifest={manifest} busy={busy} act={act} onUpdate={onUpdate} />}
  </section>;
}
function NativeContinuation({ manifest, busy, act, onUpdate }: { manifest: NativeImportManifest; busy: string | null; act(name: string, work: () => Promise<void>): Promise<void>; onUpdate(manifest: NativeImportManifest): Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [environmentId, setEnvironmentId] = useState("");
  const [contextId, setContextId] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [model, setModel] = useState("");
  const [permissionMode, setPermissionMode] = useState("");
  const [handoff, setHandoff] = useState("");
  const [loadCatalog, setLoadCatalog] = useState(false);
  const providerId = providerFor(manifest.source);
  const environments = useQuery({ queryKey: ["native-session-import", "environments", manifest.projectId], enabled: open, queryFn: ({ signal }) => sdk.environments.list({ projectId: manifest.projectId, signal }) });
  const contexts = useQuery({ queryKey: ["native-session-import", "contexts"], enabled: open, queryFn: () => sdk.experimental_executionContexts.list() });
  const connections = useQuery({ queryKey: ["native-session-import", "connections"], enabled: open, queryFn: () => sdk.experimental_modelConnections.list() });
  const models = useQuery({ queryKey: ["native-session-import", "models", environmentId, providerId, connectionId], enabled: open && loadCatalog && Boolean(environmentId && connectionId), queryFn: ({ signal }) => sdk.providers.models({ environmentId, providerId, modelConnectionId: connectionId, signal }), retry: false });
  useEffect(() => { setEnvironmentId(""); setContextId(""); setConnectionId(""); setModel(""); setPermissionMode(""); setHandoff(""); setLoadCatalog(false); setOpen(false); }, [manifest.id]);
  async function continueWith(kind: "admit" | "handoff") {
    if (!contextId || !model || !permissionMode) throw new Error("Choose the execution context, account, model and permissions explicitly.");
    const input = nativeImportContinueSchema.parse({ importId: manifest.id, environmentId, executionContextId: contextId === "none" ? null : contextId, modelConnectionId: connectionId, model, permissionMode });
    await onUpdate(kind === "admit" ? await sdk.experimental_nativeSessionImports.admit(input) : await sdk.experimental_nativeSessionImports.handoff({ ...input, input: handoff }));
  }
  if (manifest.mode === "native-admitted") return <p className="text-sm">The original native identity is admitted. Use the Core conversation for the next turn; the retained import boundary stays separate from the continuing native state.</p>;
  if (manifest.continuationThreadId) return <Link className="text-sm underline underline-offset-4" to={getThreadRoutePath({ projectId: manifest.projectId, threadId: manifest.continuationThreadId })}>Open the separate new handoff conversation</Link>;
  const loadingError = environments.error ?? contexts.error ?? connections.error ?? models.error;
  return <section className="space-y-4 border-t border-border pt-5" aria-label="Explicit continuation options"><h3 className="text-base font-semibold">Continue deliberately</h3><p className="max-w-prose text-sm text-muted-foreground">History import does not select an account or take control of a native process. Native admission must prove exclusive ownership and the same identity; uncertain or active external writers refuse. A handoff starts a new dialogue with only the context you provide below.</p><Button variant="outline" onClick={() => setOpen(!open)}>{open ? "Hide continuation choices" : "Choose continuation or handoff"}</Button>
    {open && <div className="space-y-4">{loadingError && <p role="alert" className="text-sm text-destructive">{loadingError.message}</p>}<fieldset disabled={busy !== null} className="grid min-w-0 gap-4 sm:grid-cols-2"><Choice label="Destination workspace" value={environmentId} onChange={(value) => { setEnvironmentId(value); setModel(""); setLoadCatalog(false); }} options={(environments.data ?? []).filter((environment) => environment.hostId === manifest.hostId && environment.status === "ready").map((environment) => ({ value: environment.id, label: environment.name ?? environment.path ?? "Unnamed workspace" }))} /><Choice label="Execution context" value={contextId} onChange={setContextId} options={[{ value: "none", label: "No explicit execution context" }, ...(contexts.data ?? []).filter((context) => context.projectIds.length === 0 || context.projectIds.includes(manifest.projectId)).map((context) => ({ value: context.id, label: `${context.name}${context.enabled ? "" : " · disabled"}`, disabled: !context.enabled }))]} /><Choice label="Account / payer connection" value={connectionId} onChange={(value) => { setConnectionId(value); setModel(""); setLoadCatalog(false); }} options={(connections.data ?? []).filter((connection) => connection.provider === providerId && (connection.hostId === manifest.hostId || connection.gateway?.allowedHostIds.includes(manifest.hostId))).map((connection) => ({ value: connection.id, label: `${connection.name}${connection.enabled && !connection.revoked ? "" : " · unavailable"}`, disabled: !connection.enabled || connection.revoked }))} /><Choice label="Turn permissions" value={permissionMode} onChange={setPermissionMode} options={[{ value: "accept-edits", label: "Approve edits" }, { value: "auto", label: "Automatic approval" }, { value: "full", label: "Full access" }]} /><div className="space-y-3 sm:col-span-2"><Button variant="outline" size="sm" disabled={!environmentId || !connectionId || models.isFetching} onClick={() => { setLoadCatalog(true); if (loadCatalog) void models.refetch(); }}>{models.isFetching ? "Loading selected account’s catalog…" : "Load selected account’s model catalog"}</Button><Choice label="Model" value={model} onChange={setModel} options={(models.data?.models ?? []).map((model) => ({ value: model.model, label: model.displayName }))} disabled={!loadCatalog || models.isFetching} />{models.data?.modelLoadError && <p role="alert" className="text-sm text-destructive">The selected model catalog is unavailable. Nothing is substituted.</p>}{models.isSuccess && models.data.models.length === 0 && <p className="text-sm text-muted-foreground">This connection currently offers no models. Select another connection explicitly; no fallback is chosen.</p>}</div></fieldset>
      <div className="space-y-3"><Button variant="outline" disabled={busy !== null || !environmentId || !connectionId || !contextId || !model || !permissionMode} onClick={() => void act("admit", () => continueWith("admit"))}>{busy === "admit" ? "Checking exclusive native admission…" : "Request native admission · no model turn"}</Button><p className="text-sm text-muted-foreground">OMP/Claude external takeover requires an exclusive native ownership/receipt contract that these adapters cannot currently prove. They retain the archive instead of creating a second writer or forging receipts. Codex admission also verifies the exact native storage path and workspace.</p></div>
      <div className="space-y-3 border-t border-border pt-4"><Field label="Context for a separate new dialogue" hint="This is the next-turn handoff only. The full original JSONL, tool results and native state stay in the archive and are not automatically sent to the model."><Textarea rows={5} maxLength={100000} value={handoff} onChange={(event) => setHandoff(event.target.value)} /></Field><Button disabled={busy !== null || !handoff.trim() || !environmentId || !connectionId || !contextId || !model || !permissionMode} onClick={() => void act("handoff", () => continueWith("handoff"))}>{busy === "handoff" ? "Creating separate dialogue…" : "Create new thread with handoff"}</Button></div>
    </div>}
  </section>;
}
