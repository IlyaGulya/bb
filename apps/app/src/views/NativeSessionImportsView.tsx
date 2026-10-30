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
import { captureProductAnalyticsContext, withProductAnalyticsContext } from "@/lib/product-analytics";

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
  return <Field label={label}><Select value={value} onValueChange={onChange} disabled={disabled}><SelectTrigger aria-label={label} className="min-h-11 w-full min-w-0 [&>span]:truncate"><SelectValue placeholder={placeholder} /></SelectTrigger><SelectContent>{options.map((option) => <SelectItem className="min-h-11" key={option.value} value={option.value} disabled={option.disabled}>{option.label}</SelectItem>)}</SelectContent></Select></Field>;
}
function Download({ importId, file, name, children }: { importId: string; file: string; name: string; children: ReactNode }) {
  const url = `/api/v1/native-session-imports/file?${new URLSearchParams({ importId, file })}`;
  return <a className="inline-flex min-h-11 max-w-full items-center break-all text-sm underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" href={url} download={name} onClick={(event) => { event.preventDefault(); void saveFile({ fileName: name, url }); }}>{children}</a>;
}
export function NativeSessionImportsView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const importId = searchParams.get("importId") ?? "";
  const originProjectId = searchParams.get("projectId") ?? "";
  const originHostId = searchParams.get("hostId") ?? "";
  const queryClient = useQueryClient();
  const [hostId, setHostId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [engine, setEngine] = useState("all");
  const [customRoot, setCustomRoot] = useState(false);
  const [root, setRoot] = useState("");
  const [profile, setProfile] = useState("");
  const [artifactRoots, setArtifactRoots] = useState("");
  const [showDiscovery, setShowDiscovery] = useState(!importId);
  const [search, setSearch] = useState("");
  const [found, setFound] = useState<NativeSessionSource[]>([]);
  const [selected, setSelected] = useState(new Set<string>());
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [hasDiscovered, setHasDiscovered] = useState(false);
  const [preview, setPreview] = useState<{ source: NativeSessionSource; offset: number; content: string; size: number; length: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const discoveryController = useRef<AbortController | null>(null);
  const discoveryVersion = useRef(0);
  const hosts = useQuery({ queryKey: ["native-session-import", "hosts"], queryFn: ({ signal }) => sdk.hosts.list({ signal }) });
  const projects = useQuery({ queryKey: ["native-session-import", "projects"], queryFn: ({ signal }) => sdk.projects.list({ signal }) });
  const recent = useQuery({
    queryKey: ["native-session-import", "recent"],
    queryFn: ({ signal }) => sdk.experimental_nativeSessionImports.list({ limit: 100, signal }),
    refetchInterval: (query) => query.state.data?.some((item) => item.status === "importing") ? 1000 : false,
  });
  const manifest = useQuery({ queryKey: ["native-session-import", importId], enabled: Boolean(importId), queryFn: ({ signal }) => sdk.experimental_nativeSessionImports.get({ importId, signal }), refetchInterval: (query) => query.state.data?.status === "importing" ? 1000 : false });
  const active = manifest.data;
  const sourceHost = hosts.data?.find((host) => host.id === hostId);
  const locations = useQuery({
    queryKey: ["native-session-import", "locations", hostId],
    enabled: Boolean(hostId) && sourceHost?.status === "connected",
    queryFn: ({ signal }) => sdk.experimental_nativeSessionImports.locations({ hostId, signal }),
    retry: false,
  });
  const knownRoots = (locations.data?.roots ?? []).filter((location) => engine === "all" || location.engine === engine);
  const visible = found.filter((source) => `${source.title} ${source.engine} ${source.cwd ?? ""} ${source.profile}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const savedImports = [...new Map([...(recent.data ?? []), ...(active ? [active] : [])].map((item) => [item.id, item])).values()];
  function importedSource(source: NativeSessionSource) {
    return savedImports.find((item) => item.hostId === hostId && item.projectId === projectId && item.source.engine === source.engine && item.source.sessionId === source.sessionId && item.source.cwd === source.cwd);
  }
  const selectable = visible.filter((source) => !importedSource(source));
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => () => { discoveryController.current?.abort(); }, []);
  useEffect(() => {
    if (active) {
      setHostId(active.hostId); setProjectId(active.projectId); setShowDiscovery(false); resetDiscovery();
    }
  }, [active?.id]);
  useEffect(() => {
    if (importId) return;
    if (!hostId && hosts.data) {
      const connected = hosts.data.filter((host) => host.status === "connected");
      const origin = hosts.data.find((host) => host.id === originHostId);
      if (origin) setHostId(origin.id);
      else if (!originHostId && connected.length === 1) setHostId(connected[0].id);
    }
    if (!projectId && projects.data) {
      const origin = projects.data.find((project) => project.id === originProjectId);
      if (origin) setProjectId(origin.id);
      else if (!originProjectId && projects.data.length === 1) setProjectId(projects.data[0].id);
    }
  }, [active, importId, hostId, projectId, originHostId, originProjectId, hosts.data, projects.data]);
  async function act(name: string, work: () => Promise<void>) {
    const version = discoveryVersion.current;
    setBusy(name); setError(null);
    try { await work(); } catch (error) {
      if ((name === "discover" || name === "preview") && version !== discoveryVersion.current) return;
      if (name === "discover" && discoveryController.current?.signal.aborted) return;
      setError(error instanceof Error ? error.message : "The action could not be completed. Your saved import remains available.");
    }
    finally { setBusy(null); }
  }
  function resetDiscovery() {
    discoveryVersion.current++; discoveryController.current?.abort();
    setFound([]); setSelected(new Set()); setPreview(null); setNextCursor(null); setWarnings([]); setHasDiscovered(false); setSearch("");
  }
  async function discover(cursor: number) {
    const roots = customRoot ? [{ engine: engine === "all" ? "omp" : engine, path: root.trim(), profile: profile.trim() || "Custom location", artifactRoots: artifactRoots.split("\n").map((value) => value.trim()).filter(Boolean) }] : knownRoots;
    const request = nativeImportDiscoverSchema.parse({ hostId, roots, cursor, limit: 100 });
    const controller = new AbortController();
    discoveryController.current = controller;
    const version = discoveryVersion.current;
    const result = await sdk.experimental_nativeSessionImports.discover({ ...request, signal: controller.signal });
    if (version !== discoveryVersion.current || controller.signal.aborted) return;
    setFound((previous) => cursor === 0 ? result.sessions : [...new Map([...previous, ...result.sessions].map((source) => [sourceKey(source), source])).values()]);
    setNextCursor(result.nextCursor); setHasDiscovered(true);
    setWarnings([...result.warnings, ...(result.incomplete ? ["Discovery reached its safety boundary. Use the engine filter or a narrower location in Advanced to see the rest."] : [])]);
  }
  async function showPreview(source: NativeSessionSource, offset: number) {
    const version = discoveryVersion.current;
    const result = await sdk.experimental_nativeSessionImports.preview({ hostId, source, offset, length: 65536 });
    if (version !== discoveryVersion.current) return;
    setPreview({ source, offset, content: decode(result.content), size: result.sizeBytes, length: atob(result.content).length });
  }
  function openImport(id: string) {
    resetDiscovery(); setError(null); setShowDiscovery(false);
    setSearchParams({ importId: id });
  }
  async function start() {
    const chosen = found.filter((source) => selected.has(sourceKey(source)) && !importedSource(source));
    if (!projectId || !chosen.length) throw new Error("Choose a destination project and at least one conversation that has not already been imported.");
    const analytics = { ...captureProductAnalyticsContext(), projectId };
    const imports: NativeImportManifest[] = [];
    const failures: string[] = [];
    for (let offset = 0; offset < chosen.length; offset += 100) {
      const result = await withProductAnalyticsContext(analytics, () => sdk.experimental_nativeSessionImports.start({ selections: chosen.slice(offset, offset + 100).map((source) => ({ hostId, projectId, source })) }));
      imports.push(...result.imports);
      failures.push(...result.failures.map((failure) => `${chosen[offset + failure.index]?.title ?? "Selected conversation"}: ${failure.message}`));
    }
    await queryClient.invalidateQueries({ queryKey: ["native-session-import", "recent"] });
    if (imports[0]) openImport(imports[0].id);
    if (failures.length) setError(failures.join("\n"));
  }
  const unavailable = hosts.error ?? projects.error ?? manifest.error;
  return <PageShell maxWidthClassName="max-w-5xl" contentClassName="min-w-0 gap-8 pt-6 [&_dd]:break-words [&_button]:min-h-11 [&_button]:max-w-full [&_button]:whitespace-normal [&_input:not([type=checkbox])]:min-h-11 [&_summary]:min-h-11 [&_summary]:py-3 [&_summary]:focus-visible:outline [&_summary]:focus-visible:outline-2 [&_summary]:focus-visible:outline-ring">
    <header className="flex flex-col gap-3"><Link to="/" className="inline-flex min-h-11 w-fit items-center text-sm text-muted-foreground underline underline-offset-4">Back to new thread</Link><h1 className="text-xl font-semibold">Import native history</h1><p className="max-w-prose text-sm text-muted-foreground">Bring OMP, Claude Code and Codex conversations into BB. Your originals stay on their machine. Archiving needs no model or account and starts no agent or Task.</p></header>
    {!importId && <a href="#recent-native-imports-heading" className="inline-flex min-h-11 w-fit items-center text-sm underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">Recent imports · refresh an existing conversation</a>}
    {(error || unavailable) && <div ref={errorRef} role="alert" tabIndex={-1} className="break-words whitespace-pre-wrap rounded-md border border-destructive/40 p-4 text-sm text-destructive">{error ?? (unavailable instanceof Error ? unavailable.message : "Could not load saved data. Try again when the server is available.")}</div>}
    {importId && manifest.isPending && <p role="status" className="text-sm text-muted-foreground">Loading the saved import…</p>}
    {active && <NativeImportDetail key={active.id} manifest={active} hostName={hosts.data?.find((host) => host.id === active.hostId)?.name ?? "Source machine"} projectName={projects.data?.find((project) => project.id === active.projectId)?.name ?? "Destination project"} busy={busy} act={act} onUpdate={async (next) => {
      queryClient.setQueryData(["native-session-import", next.id], next);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["native-session-import", "thread", next.threadId] }),
        queryClient.invalidateQueries({ queryKey: ["native-session-import", "recent"] }),
      ]);
    }} />}
    {!showDiscovery && <Button variant="outline" className="self-start" disabled={busy !== null} onClick={() => setShowDiscovery(true)}>Import another conversation</Button>}
    {showDiscovery && <section aria-labelledby="native-source-heading" className="flex min-w-0 flex-col gap-5"><div><h2 id="native-source-heading" className="text-base font-semibold">Find conversations to import</h2><p className="mt-1 max-w-prose text-sm text-muted-foreground">Choose a machine and project. BB finds known native history locations; no directory or checkpoint is needed.</p></div>
      {(hosts.isPending || projects.isPending) && <p role="status" className="text-sm text-muted-foreground">Loading machines and projects…</p>}
      {hosts.isSuccess && hosts.data.length === 0 && <p className="text-sm">Connect a machine to find its native conversations. Existing imports below remain readable.</p>}
      {projects.isSuccess && projects.data.length === 0 && <p className="text-sm">Create a project from the new-thread page before importing a conversation.</p>}
      {originHostId && hosts.isSuccess && !hosts.data.some((host) => host.id === originHostId) && <p className="text-sm">The previous machine is unavailable. Choose a source machine below.</p>}
      {originProjectId && projects.isSuccess && !projects.data.some((project) => project.id === originProjectId) && <p className="text-sm">The previous project is unavailable. Choose a destination project below.</p>}
      <fieldset disabled={busy !== null} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <Choice label="Source machine" value={hostId} onChange={(value) => { setHostId(value); resetDiscovery(); }} options={(hosts.data ?? []).map((host) => ({ value: host.id, label: `${host.name}${host.status !== "connected" ? " · offline" : ""}` }))} />
        <Choice label="Destination project" value={projectId} onChange={(value) => { setProjectId(value); setSelected(new Set()); }} options={(projects.data ?? []).map((project) => ({ value: project.id, label: project.name }))} />
        <Choice label="Native engine" value={engine} onChange={(value) => { setEngine(value); resetDiscovery(); }} options={[{ value: "all", label: "All engines" }, { value: "omp", label: "OMP" }, { value: "claude", label: "Claude Code" }, { value: "codex", label: "Codex" }]} />
      </fieldset>
      {sourceHost && sourceHost.status !== "connected" && <p role="status" className="text-sm text-muted-foreground">This machine is offline. Reconnect it to find conversations or import new messages. Saved archives remain available.</p>}
      {hostId && sourceHost?.status === "connected" && locations.isPending && <p role="status" className="text-sm text-muted-foreground">Loading known history locations…</p>}
      {locations.error && <div role="alert" className="space-y-2 text-sm"><p className="break-words text-destructive">Could not load history locations: {locations.error.message}</p><Button variant="outline" disabled={locations.isFetching} onClick={() => void locations.refetch()}>Retry history locations</Button></div>}
      {locations.data?.warnings.length ? <ul className="space-y-2 break-words text-sm text-muted-foreground">{locations.data.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : null}
      {locations.isSuccess && knownRoots.length === 0 && !customRoot && <p className="text-sm">No known history locations are available for this engine on this machine. Try another engine or machine, or specify a location in Advanced.</p>}
      <details className="min-w-0 text-sm"><summary className="cursor-pointer font-medium">Advanced · history locations</summary><fieldset disabled={busy !== null} className="mt-3 flex min-w-0 flex-col gap-4">
        <p className="text-muted-foreground">Profiles are provenance labels, not accounts or payers. No credentials are read or transferred.</p>
        {knownRoots.length > 0 && <ul className="space-y-2 break-all text-muted-foreground">{knownRoots.map((location) => <li key={`${location.engine}:${location.path}:${location.profile}`}>{location.engine} · {location.profile} · {location.path}</li>)}</ul>}
        <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={customRoot} onChange={(event) => { setCustomRoot(event.target.checked); resetDiscovery(); }} />Use a custom history location instead</label>
        {customRoot && <><p className="text-muted-foreground">Choose a specific native engine above. Only this directory is searched.</p><Field label="Session-history directory"><Input value={root} onChange={(event) => { setRoot(event.target.value); resetDiscovery(); }} placeholder="/path/to/session-history" spellCheck={false} /></Field><Field label="Source profile label" hint="Optional provenance label; never selects an account."><Input value={profile} onChange={(event) => { setProfile(event.target.value); resetDiscovery(); }} /></Field><Field label="Referenced-artifact directories" hint="Optional: one absolute directory per line. Only artifacts referenced by selected records can be copied; auth/configuration files are refused."><Textarea rows={2} value={artifactRoots} onChange={(event) => { setArtifactRoots(event.target.value); resetDiscovery(); }} spellCheck={false} /></Field></>}
      </fieldset></details>
      <div className="flex flex-wrap items-center gap-3"><Button disabled={busy !== null || !hostId || sourceHost?.status !== "connected" || (customRoot ? !root.trim() || engine === "all" : locations.isFetching || knownRoots.length === 0)} onClick={() => void act("discover", () => discover(0))}>{busy === "discover" ? "Finding conversations…" : "Find conversations"}</Button>{busy === "discover" && <Button variant="outline" onClick={() => { discoveryController.current?.abort(); setWarnings((previous) => [...previous, "Discovery cancelled. No import or native runtime was started."]); }}>Cancel discovery</Button>}<span className="text-sm text-muted-foreground">Discovery does not import or resume anything.</span></div>
      {warnings.length > 0 && <ul className="space-y-2 break-words text-sm text-muted-foreground">{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      {hasDiscovered && found.length === 0 && <p className="py-4 text-sm">No supported conversations were found. Try another engine or machine, or inspect the history locations in Advanced.</p>}
      {found.length > 0 && <div className="min-w-0 space-y-3">
        <Field label="Search discovered conversations" hint="Search the loaded titles, engines, workspaces and profile labels. Load more to search older conversations."><Input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Title or workspace" /></Field>
        <p role="status" className="text-sm text-muted-foreground">{visible.length} of {found.length} loaded conversations shown · {selected.size} selected</p>
        {visible.length === 0 && <p className="text-sm">No loaded conversations match this search. Try another term or load more below.</p>}
        <div className="border-y border-border">{selectable.length > 0 && <label className="flex min-h-11 items-center gap-3 py-3 text-sm"><input type="checkbox" checked={selectable.every((source) => selected.has(sourceKey(source)))} onChange={(event) => setSelected((previous) => { const next = new Set(previous); for (const source of selectable) { if (event.target.checked) next.add(sourceKey(source)); else next.delete(sourceKey(source)); } return next; })} />Select all {selectable.length} new conversations shown</label>}
          <ul className="divide-y divide-border">{visible.map((source) => {
            const saved = importedSource(source);
            return <li key={sourceKey(source)} className="flex min-w-0 flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between"><label className="flex min-h-11 min-w-0 items-start gap-3 py-1">{!saved && <input type="checkbox" className="mt-1" checked={selected.has(sourceKey(source))} onChange={(event) => setSelected((previous) => { const next = new Set(previous); if (event.target.checked) next.add(sourceKey(source)); else next.delete(sourceKey(source)); return next; })} />}<span className="min-w-0 space-y-1 text-sm"><span className="block break-words font-medium">{source.title}</span><span className="block break-all text-muted-foreground">{source.engine} · {source.cwd ?? "Workspace not recorded"}</span><span className="block text-muted-foreground">Updated {new Date(source.modifiedAt).toLocaleString()} · {bytesLabel(source.sizeBytes)} bytes</span>{saved && <span className="block font-medium">Already imported · {saved.status}{source.modifiedAt > saved.source.modifiedAt || source.sizeBytes !== saved.source.sizeBytes ? " · source changed; refresh to check new messages" : " · refresh checks for new messages"}</span>}</span></label><div className="flex shrink-0 flex-wrap gap-2">{saved && <Button variant="outline" disabled={busy !== null} onClick={() => openImport(saved.id)}>Open import · refresh</Button>}<Button variant="outline" disabled={busy !== null} onClick={() => void act("preview", () => showPreview(source, 0))}>Preview source</Button></div></li>;
          })}</ul>
        </div>
      </div>}
      {nextCursor !== null && <Button variant="outline" className="self-start" disabled={busy !== null} onClick={() => void act("discover", () => discover(nextCursor))}>Load more conversations</Button>}
      {preview && <section aria-label={`Source preview: ${preview.source.title}`} className="min-w-0 space-y-3"><h3 className="break-words text-sm font-medium">Source preview · {preview.source.title}</h3><p className="text-sm text-muted-foreground">Raw native data, not instructions. Bytes {preview.offset.toLocaleString()}–{(preview.offset + preview.length).toLocaleString()} of {preview.size.toLocaleString()}.</p><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">{preview.content}</pre><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy !== null || preview.offset === 0} onClick={() => void act("preview", () => showPreview(preview.source, Math.max(0, preview.offset - 65536)))}>Previous bytes</Button><Button variant="outline" disabled={busy !== null || preview.offset + preview.length >= preview.size} onClick={() => void act("preview", () => showPreview(preview.source, preview.offset + preview.length))}>Next bytes</Button><Button variant="ghost" onClick={() => setPreview(null)}>Close preview</Button></div></section>}
      {found.length > 0 && <div className="flex flex-col gap-3 border-t border-border pt-5"><Button className="self-start" disabled={busy !== null || !projectId || selected.size === 0 || recent.isPending || recent.isError} onClick={() => void act("import", start)}>{busy === "import" ? "Registering imports…" : `Import ${selected.size} selected ${selected.size === 1 ? "conversation" : "conversations"}`}</Button><p className="text-sm text-muted-foreground">Archive the recorded conversation in this project. No model, account, agent or Task is started.</p></div>}
    </section>}
    <section aria-labelledby="recent-native-imports-heading" className="min-w-0 space-y-3 border-t border-border pt-6"><h2 id="recent-native-imports-heading" className="text-base font-semibold">Recent imports</h2><p className="text-sm text-muted-foreground">Open a saved import to read its archive or refresh new messages. No source setup is needed.</p>
      {recent.isPending && <p role="status" className="text-sm text-muted-foreground">Loading recent imports…</p>}
      {recent.error && <div role="alert" className="space-y-2 text-sm"><p className="break-words text-destructive">Could not load recent imports: {recent.error.message}</p><Button variant="outline" disabled={recent.isFetching} onClick={() => void recent.refetch()}>Retry recent imports</Button></div>}
      {recent.isSuccess && recent.data.length === 0 && <p className="text-sm text-muted-foreground">No imports yet. Find a conversation above to create your first archive.</p>}
      <ul className="divide-y divide-border">{recent.data?.map((item) => <li key={item.id} className="py-2"><button type="button" disabled={busy !== null} aria-current={item.id === importId ? "page" : undefined} className="flex min-h-11 w-full min-w-0 flex-col gap-1 rounded-md px-2 py-3 text-left text-sm hover:bg-state-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50" onClick={() => openImport(item.id)}><span className="break-words font-medium">{item.source.title}</span><span className="break-all text-muted-foreground">{item.source.engine} · {projects.data?.find((project) => project.id === item.projectId)?.name ?? "Saved project"} · {item.source.cwd ?? "Workspace not recorded"}</span><span className="break-words text-muted-foreground">{item.status === "ready" ? "Imported · refresh available" : item.status === "importing" ? "Import in progress" : `${item.status} · open to retry or refresh`} · Updated {new Date(item.updatedAt).toLocaleString()}</span></button></li>)}</ul>
    </section>
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
  const [refreshBoundary, setRefreshBoundary] = useState<{ bytes: number; records: number } | null>(null);
  const records = useQuery({ queryKey: ["native-session-import", "records", manifest.id, after, query, manifest.records], enabled: manifest.records > 0,
    queryFn: ({ signal }) => sdk.experimental_nativeSessionImports.records({ importId: manifest.id, after, query, limit: 25, signal }) });
  useEffect(() => { setAfter(0); setQuery(""); setQueryInput(""); setRaw(null); }, [manifest.id]);
  async function readRecord(record: NativeImportRecord, offset: number) {
    const result = await sdk.experimental_nativeSessionImports.bytes({ importId: manifest.id, file: "native", offset: record.offset + offset, length: Math.min(65536, record.length - offset) });
    setRaw({ record, offset, content: decode(result.content), length: atob(result.content).length });
  }
  return <section aria-labelledby="native-import-heading" className="flex min-w-0 flex-col gap-6 border-t border-border pt-6"><header className="space-y-2"><h2 id="native-import-heading" className="break-words text-base font-semibold">{manifest.source.title}</h2><p className="text-sm font-medium">{modeLabel(manifest.mode)} · {manifest.status}</p><p className="max-w-prose break-words text-sm text-muted-foreground">{manifest.reason}</p></header>
    <section aria-label="Import new messages" className="space-y-3">
      <Button disabled={busy !== null || manifest.status === "importing" || manifest.mode !== "archive"} onClick={() => void act("refresh", async () => {
        setRefreshBoundary(null);
        const next = await withProductAnalyticsContext({ ...captureProductAnalyticsContext(), projectId: manifest.projectId }, () => sdk.experimental_nativeSessionImports.refresh({ importId: manifest.id }));
        await onUpdate(next);
        setRefreshBoundary({ bytes: manifest.bytes, records: manifest.records });
      })}>{busy === "refresh" ? "Capturing latest messages…" : manifest.status === "importing" ? "Importing captured messages…" : "Refresh · import new messages"}</Button>
      <p className="max-w-prose text-sm text-muted-foreground">Refresh captures complete recorded messages available at the time you click, then updates this same BB conversation. Messages still being written or added later need another click. It never asks the source assistant to make a checkpoint or starts a model turn.</p>
      {manifest.mode === "native-admitted" && <p className="text-sm text-muted-foreground">This native identity now continues in BB. Use the Core conversation instead of refreshing an external writer.</p>}
      {manifest.mode === "new-handoff" && <p className="text-sm text-muted-foreground">This archive already supplied a separate handoff conversation. Its source archive is retained; refresh is available only before continuation.</p>}
      {refreshBoundary && manifest.status === "ready" && <p role="status" className="text-sm">{manifest.bytes === refreshBoundary.bytes && manifest.records === refreshBoundary.records ? "Refresh complete. No additional complete native records were found. The existing archive is retained." : "Refresh complete. The captured history is available in this same archive and Core conversation."}</p>}
      {manifest.status === "importing" && <p role="status" className="text-sm text-muted-foreground">Import processing is in progress. You can leave this page and reopen this saved import to see its status.</p>}
    </section>
    <dl className="grid gap-4 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">Source</dt><dd className="mt-1 break-all">{hostName} · {manifest.source.profile} · {manifest.source.engine}</dd></div><div><dt className="text-muted-foreground">Destination</dt><dd className="mt-1">{projectName}</dd></div><div><dt className="text-muted-foreground">Native state remains on the source machine</dt><dd className="mt-1 break-all">{manifest.source.path}<br />{manifest.source.cwd ?? "Workspace was not recorded"}</dd></div><div><dt className="text-muted-foreground">BB archive</dt><dd className="mt-1">Private persistent server data, under native-session-imports. Separate from model context; not a backup of all agent files.</dd></div></dl>
    <div role="status" aria-live="polite" className="space-y-2"><p className="text-sm tabular-nums">{manifest.bytes.toLocaleString()} archived bytes · {manifest.records.toLocaleString()} native records</p><progress aria-label="Native archive import progress" className="h-2 w-full accent-primary" max={1} value={manifest.status === "ready" ? 1 : undefined} /><p className="text-sm text-muted-foreground">Captured source: {manifest.source.sizeBytes.toLocaleString()} bytes. The retained archive can differ when original headers are preserved.</p></div>
    {manifest.error && <p role="alert" className="break-words whitespace-pre-wrap text-sm text-destructive">{manifest.error} The committed archive is retained. Reconnect the source machine if needed, then use Refresh to capture the latest messages. Resume only retries the already captured import.</p>}
    <div className="flex flex-wrap gap-3">
      {manifest.status === "importing" ? <Button variant="outline" disabled={busy !== null} onClick={() => void act("cancel", async () => { await onUpdate(await sdk.experimental_nativeSessionImports.cancel({ importId: manifest.id })); })}>Cancel import</Button> : manifest.status !== "ready" && <Button variant="outline" disabled={busy !== null} onClick={() => void act("resume", async () => { setRefreshBoundary(null); await onUpdate(await sdk.experimental_nativeSessionImports.resume({ importId: manifest.id })); })}>Resume interrupted processing</Button>}
      {manifest.threadId && <Link className="inline-flex min-h-11 items-center text-sm underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" to={getThreadRoutePath({ projectId: manifest.projectId, threadId: manifest.threadId })}>Open Core conversation</Link>}
      {manifest.bytes > 0 && <Download importId={manifest.id} file="native" name="native-session.jsonl">Download {manifest.status === "ready" ? "full" : "committed"} native JSONL</Download>}
    </div>
    <details className="min-w-0 text-sm"><summary className="cursor-pointer font-medium">Boundary and original identity</summary>
      <dl className="mt-3 space-y-2 break-all"><div><dt className="text-muted-foreground">Original native session ID</dt><dd>{manifest.source.sessionId}</dd></div><div><dt className="text-muted-foreground">Committed archive boundary SHA-256</dt><dd className="font-mono text-xs">{manifest.boundarySha256 ?? "No complete record has been committed yet"}</dd></div><div><dt className="text-muted-foreground">Latest captured native source boundary</dt><dd>{manifest.sourceBoundaryBytes === null ? "Not recorded for this older import" : `${manifest.sourceBoundaryBytes.toLocaleString()} bytes`}</dd></div><div><dt className="text-muted-foreground">Import reference</dt><dd className="font-mono text-xs">{manifest.id}</dd></div></dl>
      {manifest.previousSources.length > 0 && <div className="mt-4 space-y-2"><h3 className="font-medium">Previous source locations</h3><p className="text-muted-foreground">Refresh reconnected this same archive to its original native conversation. These earlier source locations remain part of its provenance.</p><ul className="space-y-2 break-all">{manifest.previousSources.map((source, index) => <li key={`${source.path}:${index}`}>{source.engine} · {source.profile} · {source.path}</li>)}</ul></div>}
      {manifest.headerVersions.length > 0 && <div className="mt-4 space-y-2"><h3 className="font-medium">Retained native header versions</h3><p className="max-w-prose text-muted-foreground">The source changed its title or header metadata. Downloaded archive JSONL retains its originally accepted headers; later observed header versions are preserved separately below. It is not a byte-identical copy of the latest live file. Conversation and tool records are not rewritten.</p><ul className="space-y-3">{manifest.headerVersions.map((version) => <li key={`${version.ordinal}:${version.file}`} className="min-w-0 space-y-1"><Download importId={manifest.id} file={version.file} name={`native-header-${version.ordinal}.jsonl`}>Download header record {version.ordinal} · observed {new Date(version.observedAt).toLocaleString()}</Download><p className="break-all text-xs text-muted-foreground">{version.sourcePath} · {version.bytes.toLocaleString()} bytes<br />SHA-256: {version.sha256}</p></li>)}</ul></div>}
    </details>
    {manifest.records > 0 && <section aria-label="Retained native record browser" className="space-y-4">
      <h3 className="text-base font-semibold">Recorded history and native state</h3>
      <p className="text-sm text-muted-foreground">Messages and tools are projected into the Core conversation. This index also keeps service records, branches, checkpoints and compaction state. Pagination changes presentation, not preservation.</p>
      <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(event) => { event.preventDefault(); setQuery(queryInput); setAfter(0); }}>
        <Input aria-label="Search complete retained history and tool results" placeholder="Search messages, tools or native IDs" value={queryInput} onChange={(event) => setQueryInput(event.target.value)} maxLength={1024} />
        <Button type="submit" variant="outline">Search retained data</Button>
      </form>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => { setAfter(0); }}>Beginning</Button>
        <Button variant="outline" size="sm" onClick={() => { setAfter(Math.max(0, Math.floor(manifest.records / 2) - 1)); }}>Middle</Button>
        <Button variant="outline" size="sm" onClick={() => { setAfter(Math.max(0, manifest.records - 25)); }}>End</Button>
      </div>
      {records.isPending && <p role="status" className="text-sm text-muted-foreground">Loading retained records…</p>}{records.error && <p role="alert" className="text-sm text-destructive">{records.error.message}</p>}{records.data && records.data.records.length === 0 && <p className="text-sm">No matching records in this window.{records.data.nextAfter !== null ? " Continue searching the next window." : " Try another search or return to the beginning."}</p>}
      <ol className="divide-y divide-border border-y border-border">{records.data?.records.map((record) => <li key={record.ordinal} className="space-y-2 py-4"><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-medium">Record {record.ordinal} · {record.type}</span><span className="text-xs text-muted-foreground">{record.timestamp === null ? "Native timestamp not recorded" : new Date(record.timestamp).toLocaleString()}</span></div><p className="whitespace-pre-wrap break-words text-sm">{record.preview || "Native state record; retained byte-for-byte."}</p><details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Original links and provenance</summary><p className="mt-2 break-all">Native ID: {record.nativeId ?? "not recorded"}<br />Native parent: {record.parentId ?? "not recorded"}<br />Original bytes: {record.offset}–{record.offset + record.length}<br />Core sequence window: {record.sourceSeqStart}–{record.sourceSeqEnd}</p></details><Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void act("record", () => readRecord(record, 0))}>Read complete native record</Button></li>)}</ol>
      {records.data?.nextAfter !== null && records.data?.nextAfter !== undefined && <Button variant="outline" disabled={records.isFetching} onClick={() => { if (records.data?.nextAfter !== null && records.data?.nextAfter !== undefined) setAfter(records.data.nextAfter); }}>Next record window</Button>}
      {raw && <div className="space-y-3">
        <h4 className="text-sm font-medium">Original record {raw.record.ordinal} · bytes {raw.offset.toLocaleString()}–{(raw.offset + raw.length).toLocaleString()} of {raw.record.length.toLocaleString()}</h4>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">{raw.content}</pre>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={busy !== null || raw.offset === 0} onClick={() => { void act("record", () => readRecord(raw.record, Math.max(0, raw.offset - 65536))); }}>Previous record bytes</Button>
          <Button variant="outline" size="sm" disabled={busy !== null || raw.offset + raw.length >= raw.record.length} onClick={() => { void act("record", () => readRecord(raw.record, raw.offset + raw.length)); }}>Next record bytes</Button>
          <Button variant="ghost" size="sm" onClick={() => setRaw(null)}>Close record</Button>
        </div>
      </div>}
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
  if (manifest.continuationThreadId) return <Link className="inline-flex min-h-11 items-center text-sm underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" to={getThreadRoutePath({ projectId: manifest.projectId, threadId: manifest.continuationThreadId })}>Open the separate new handoff conversation</Link>;
  const loadingError = environments.error ?? contexts.error ?? connections.error ?? models.error;
  return <section className="space-y-4 border-t border-border pt-5" aria-label="Explicit continuation options"><h3 className="text-base font-semibold">Continue deliberately</h3><p className="max-w-prose text-sm text-muted-foreground">History import does not select an account or take control of a native process. Native admission must prove exclusive ownership and the same identity; uncertain or active external writers refuse. A handoff starts a new dialogue with only the context you provide below.</p><Button variant="outline" onClick={() => setOpen(!open)}>{open ? "Hide continuation choices" : "Choose continuation or handoff"}</Button>
    {open && <div className="space-y-4">{loadingError && <p role="alert" className="text-sm text-destructive">{loadingError.message}</p>}<fieldset disabled={busy !== null} className="grid min-w-0 gap-4 sm:grid-cols-2"><Choice label="Destination workspace" value={environmentId} onChange={(value) => { setEnvironmentId(value); setModel(""); setLoadCatalog(false); }} options={(environments.data ?? []).filter((environment) => environment.hostId === manifest.hostId && environment.status === "ready").map((environment) => ({ value: environment.id, label: environment.name ?? environment.path ?? "Unnamed workspace" }))} /><Choice label="Execution context" value={contextId} onChange={setContextId} options={[{ value: "none", label: "No explicit execution context" }, ...(contexts.data ?? []).filter((context) => context.projectIds.length === 0 || context.projectIds.includes(manifest.projectId)).map((context) => ({ value: context.id, label: `${context.name}${context.enabled ? "" : " · disabled"}`, disabled: !context.enabled }))]} /><Choice label="Account / payer connection" value={connectionId} onChange={(value) => { setConnectionId(value); setModel(""); setLoadCatalog(false); }} options={(connections.data ?? []).filter((connection) => connection.provider === providerId && (connection.hostId === manifest.hostId || connection.gateway?.allowedHostIds.includes(manifest.hostId))).map((connection) => ({ value: connection.id, label: `${connection.name}${connection.enabled && !connection.revoked ? "" : " · unavailable"}`, disabled: !connection.enabled || connection.revoked }))} /><Choice label="Turn permissions" value={permissionMode} onChange={setPermissionMode} options={[{ value: "accept-edits", label: "Approve edits" }, { value: "auto", label: "Automatic approval" }, { value: "full", label: "Full access" }]} /><div className="space-y-3 sm:col-span-2"><Button variant="outline" size="sm" disabled={!environmentId || !connectionId || models.isFetching} onClick={() => { setLoadCatalog(true); if (loadCatalog) void models.refetch(); }}>{models.isFetching ? "Loading selected account’s catalog…" : "Load selected account’s model catalog"}</Button><Choice label="Model" value={model} onChange={setModel} options={(models.data?.models ?? []).map((model) => ({ value: model.model, label: model.displayName }))} disabled={!loadCatalog || models.isFetching} />{models.data?.modelLoadError && <p role="alert" className="text-sm text-destructive">The selected model catalog is unavailable. Nothing is substituted.</p>}{models.isSuccess && models.data.models.length === 0 && <p className="text-sm text-muted-foreground">This connection currently offers no models. Select another connection explicitly; no fallback is chosen.</p>}</div></fieldset>
      <div className="space-y-3"><Button variant="outline" disabled={busy !== null || !environmentId || !connectionId || !contextId || !model || !permissionMode} onClick={() => void act("admit", () => continueWith("admit"))}>{busy === "admit" ? "Checking exclusive native admission…" : "Request native admission · no model turn"}</Button><p className="text-sm text-muted-foreground">OMP/Claude external takeover requires an exclusive native ownership/receipt contract that these adapters cannot currently prove. They retain the archive instead of creating a second writer or forging receipts. Codex admission also verifies the exact native storage path and workspace.</p></div>
      <div className="space-y-3 border-t border-border pt-4"><Field label="Context for a separate new dialogue" hint="This is the next-turn handoff only. The full original JSONL, tool results and native state stay in the archive and are not automatically sent to the model."><Textarea rows={5} maxLength={100000} value={handoff} onChange={(event) => setHandoff(event.target.value)} /></Field><Button disabled={busy !== null || !handoff.trim() || !environmentId || !connectionId || !contextId || !model || !permissionMode} onClick={() => void act("handoff", () => continueWith("handoff"))}>{busy === "handoff" ? "Creating separate dialogue…" : "Create new thread with handoff"}</Button></div>
    </div>}
  </section>;
}
