import { useMemo, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { Input } from "@bb/shared-ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@bb/shared-ui/dropdown-menu";
import { productAnalyticsActorSchema, productAnalyticsModeSchema, productAnalyticsSurfaceSchema, type ProductAnalyticsReportQuery, type ProductAnalyticsRow } from "@bb/server-contract";
import { SettingsSection } from "@/components/ui/settings-section";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { sdk } from "@/lib/sdk";
import { productAnalyticsOutbox } from "@/lib/product-analytics";
import { formatRelativeTime } from "@/lib/relative-time";

function Filter({ label, value, options, onChange }: { label: string; value: string; options: readonly { value: string; label: string }[]; onChange: (value: string) => void }) {
  return <DropdownMenu>
    <DropdownMenuTrigger asChild><Button variant="outline" size="sm" className="max-w-full gap-2" aria-label={label}><span className="truncate">{label}: {options.find((option) => option.value === value)?.label ?? value}</span><Icon name="ChevronDown" className="size-3.5 shrink-0" /></Button></DropdownMenuTrigger>
    <DropdownMenuContent align="start">{options.map((option) => <DropdownMenuItem key={option.value} onSelect={() => onChange(option.value)}><span className="flex-1">{option.label}</span>{value === option.value && <Icon name="Check" className="size-3.5" />}</DropdownMenuItem>)}</DropdownMenuContent>
  </DropdownMenu>;
}
function duration(value: number | null): string { return value === null ? "No completed duration" : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`; }
function FeatureRow({ row }: { row: ProductAnalyticsRow }) {
  const known = row.coverage !== "gap";
  const outcomes = row.successes + row.failures + row.denied + row.cancelled;
  const successRate = outcomes === 0 ? null : Math.round(row.successes / outcomes * 100);
  return <details className="group border-b border-border last:border-b-0">
    <summary className="flex cursor-pointer list-none flex-col gap-2 py-4 outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-row sm:items-center sm:gap-6">
      <div className="min-w-0 flex-1"><div className="flex items-start gap-2"><Icon name="ChevronDown" className="mt-0.5 size-3.5 shrink-0 transition-transform group-open:rotate-180" /><span className="break-words text-sm font-medium">{row.label}</span></div><p className="mt-1 pl-5 text-xs text-subtle-foreground">{row.coverage === "gap" ? "Coverage gap" : row.coverage === "admission" ? "Action admission" : row.coverage === "observation" ? "Observation / explicit intent" : "Lifecycle"} · {row.availability === "unknown" ? "Availability unknown" : row.availability === "unavailable" ? "Unavailable now" : "Available"}</p></div>
      <dl className="grid grid-cols-3 gap-4 pl-5 text-xs tabular-nums sm:min-w-64 sm:pl-0"><div><dt className="text-subtle-foreground">Attempts</dt><dd className="mt-1 text-sm font-medium">{known ? row.attempts : "Not covered"}</dd></div><div><dt className="text-subtle-foreground">Success</dt><dd className="mt-1 text-sm font-medium">{successRate === null ? "No outcomes" : `${successRate}%`}</dd></div><div><dt className="text-subtle-foreground">Failed / denied</dt><dd className="mt-1 text-sm font-medium">{known ? `${row.failures} / ${row.denied}` : "Not covered"}</dd></div></dl>
    </summary>
    <div className="space-y-4 pb-4 pl-5 text-xs leading-relaxed">
      {row.limitation && <p className="max-w-prose text-subtle-foreground">{row.limitation}</p>}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 tabular-nums sm:grid-cols-4">
        <div><dt className="text-subtle-foreground">Exposed → opened</dt><dd>{known ? `${row.exposures} → ${row.opens}` : "Not covered"}</dd></div>
        <div><dt className="text-subtle-foreground">Started → succeeded</dt><dd>{known ? `${row.attempts} → ${row.successes}` : "Not covered"}</dd></div>
        <div><dt className="text-subtle-foreground">Accepted / cancelled</dt><dd>{known ? `${row.accepted} / ${row.cancelled}` : "Not covered"}</dd></div>
        <div><dt className="text-subtle-foreground">Mean completion time</dt><dd>{duration(row.averageDurationMs)}</dd></div>
        <div><dt className="text-subtle-foreground">Human / agent</dt><dd>{known ? `${row.human} / ${row.agent}` : "Not covered"}</dd></div>
        <div><dt className="text-subtle-foreground">System / unknown</dt><dd>{known ? `${row.system} / ${row.unknown}` : "Not covered"}</dd></div>
        <div><dt className="text-subtle-foreground">Returning actor sessions</dt><dd>{known ? row.repeatActors : "Not covered"}</dd></div>
        <div><dt className="text-subtle-foreground">Last meaningful use</dt><dd>{row.lastUsedAt === null ? known && row.availability === "available" ? "No recorded use in this window" : "Unknown, not zero" : formatRelativeTime({ timestamp: row.lastUsedAt, now: Date.now() })}</dd></div>
      </dl>
      <p className="break-all font-mono text-subtle-foreground">{row.featureId} / {row.action} · schema v{row.version}</p>
      <p className="break-words text-subtle-foreground">Entrypoints: {row.entrypoints.join(" · ")}</p>
    </div>
  </details>;
}
export function ProductAnalyticsSettingsSection() {
  const [projectId, setProjectId] = useState("instance");
  const [days, setDays] = useState("7");
  const [mode, setMode] = useState<ProductAnalyticsReportQuery["mode"]>("production");
  const [actor, setActor] = useState("all");
  const [surface, setSurface] = useState("all");
  const [release, setRelease] = useState("");
  const [search, setSearch] = useState("");
  const [view, setView] = useState("all");
  const [page, setPage] = useState(0);
  const navigation = useSidebarNavigation();
  const local = useSyncExternalStore(productAnalyticsOutbox.subscribe, productAnalyticsOutbox.getSnapshot, productAnalyticsOutbox.getSnapshot);
  const query: ProductAnalyticsReportQuery = { days: Number(days), mode, ...(projectId === "instance" ? {} : { projectId }), ...(actor === "all" ? {} : { actorKind: productAnalyticsActorSchema.parse(actor) }), ...(surface === "all" ? {} : { surface: productAnalyticsSurfaceSchema.parse(surface) }), ...(release.trim() === "" ? {} : { release: release.trim() }) };
  const report = useQuery({ queryKey: ["private-product-analytics", query], queryFn: () => sdk.experimental_productAnalytics.report(query), refetchInterval: 10_000 });
  const projects = navigation.data ? [navigation.data.personalProject, ...navigation.data.projects] : [];
  const deliveryComplete = report.data !== undefined && report.data.diagnostics.pending === 0 && report.data.diagnostics.failed === 0 && report.data.diagnostics.gaps === 0 && report.data.diagnostics.instanceGaps === 0 && report.data.diagnostics.storage === "healthy" && local.pending === 0 && local.failed === 0 && local.gaps === 0 && local.storage === "healthy";
  const rows = useMemo(() => (report.data?.rows ?? []).filter((row) => {
    if (search !== "" && !`${row.label} ${row.featureId} ${row.action}`.toLowerCase().includes(search.toLowerCase())) return false;
    if (view === "gaps") return row.coverage === "gap" || row.availability === "unknown";
    if (view === "problems") return row.failures + row.denied > 0;
    if (view === "unused") return deliveryComplete && row.coverage !== "gap" && row.availability === "available" && row.attempts === 0 && row.opens === 0;
    if (view === "unavailable") return row.availability === "unavailable";
    return true;
  }), [report.data, search, view, deliveryComplete]);
  const pageCount = Math.max(1, Math.ceil(rows.length / 30));
  const activePage = Math.min(page, pageCount - 1);
  const state = report.data?.diagnostics;
  return <div className="space-y-6">
    <SettingsSection title="Private product analytics" description="Feature usage and real outcomes, stored on this BB server. No vendor backend. Select one logical scope; model accounts never choose the scope." action={<Button variant="outline" size="sm" disabled={report.isFetching} onClick={() => { void productAnalyticsOutbox.flush().then(() => report.refetch()); }}>Refresh</Button>}>
      <div className="flex flex-wrap gap-2">
        <Filter label="Scope" value={projectId} options={[{ value: "instance", label: "Instance-only actions" }, ...projects.map((project) => ({ value: project.id, label: project.name }))]} onChange={setProjectId} />
        <Filter label="Period" value={days} options={[{ value: "1", label: "24 hours" }, { value: "7", label: "7 days" }, { value: "30", label: "30 days" }]} onChange={setDays} />
        <Filter label="Mode" value={mode} options={productAnalyticsModeSchema.options.map((value) => ({ value, label: value }))} onChange={(value) => setMode(productAnalyticsModeSchema.parse(value))} />
        <Filter label="Actor" value={actor} options={[{ value: "all", label: "All actors" }, ...productAnalyticsActorSchema.options.map((value) => ({ value, label: value }))]} onChange={setActor} />
        <Filter label="Surface" value={surface} options={[{ value: "all", label: "All surfaces" }, ...productAnalyticsSurfaceSchema.options.map((value) => ({ value, label: value }))]} onChange={setSurface} />
      </div>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row"><Input aria-label="Server release filter" placeholder="All server releases" maxLength={100} value={release} onChange={(event) => setRelease(event.target.value)} /><Input aria-label="Find feature or action" placeholder="Find a feature or action" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} /></div>
      <p className="mt-3 text-xs leading-relaxed text-subtle-foreground">Production excludes preview, smoke and test activity. Reads, prefetch and background refresh do not become human choices. Asynchronous admission is not downstream success. Low use never authorizes automatic removal.</p>
    </SettingsSection>
    <SettingsSection title="Delivery and freshness" description="Acknowledged means durably admitted, not already projected. Queue limits, expiry, device loss and storage failures can leave gaps.">
      <div className="space-y-2 text-xs leading-relaxed tabular-nums" aria-live="polite">
        <p>Server: {state ? `${state.pending} pending · ${state.failed} failed admissions · ${state.gaps} gaps · ${state.expired} expired · storage ${state.storage}` : "Delivery state is unavailable until the server responds."}</p>
        <p>Instance-level diagnostic gaps: {state?.instanceGaps ?? "Not available"}. Missing plugin scope is a visible gap, never guessed Work or Personal activity.</p>
        <p>Last admitted: {state?.lastAcceptedAt ? formatRelativeTime({ timestamp: state.lastAcceptedAt, now: Date.now() }) : "No admission in this scope"}. Last projected: {state?.lastProjectedAt ? formatRelativeTime({ timestamp: state.lastProjectedAt, now: Date.now() }) : "No projection in this scope"}.</p>
        <p>This browser’s delivery queue: {local.pending} pending · {local.failed} retrying · {local.gaps} gaps · storage {local.storage}. These are device-wide delivery diagnostics, not cross-project popularity.</p>
        <p className="text-subtle-foreground">Server retention: 30 days, up to 100,000 events / 10,000 pending. Browser queue: 500 events / 7 days. Current server release: {report.data?.release ?? "Not available"}.</p>
      </div>
    </SettingsSection>
    <SettingsSection title="Feature coverage and outcomes" description="Available and covered with no use is different from unavailable, failing or not instrumented. Expand a feature for its funnel, actor split and entrypoints." action={<Filter label="Show" value={view} options={[{ value: "all", label: "All features" }, { value: "problems", label: "Failed or denied" }, { value: "unused", label: "Covered, available, unused" }, { value: "unavailable", label: "Unavailable" }, { value: "gaps", label: "Coverage / availability gaps" }]} onChange={(value) => { setView(value); setPage(0); }} />}>
      {report.data && !deliveryComplete && <p role="status" className="mb-3 text-xs leading-relaxed text-subtle-foreground">Delivery is incomplete. Counts show recorded activity, not proof that unobserved features were unused. The unused view stays empty while delivery has gaps.</p>}
      {report.isPending ? <p className="py-8 text-center text-sm text-subtle-foreground" role="status">Loading private analytics…</p> : report.isError ? <div role="alert" className="space-y-3 py-6"><p className="text-sm">Couldn’t load analytics. Check this server’s connection, then refresh. Your main workflow is not blocked.</p><Button variant="outline" size="sm" onClick={() => { void report.refetch(); }}>Try again</Button></div> : rows.length === 0 ? <p className="py-8 text-center text-sm text-subtle-foreground">No features match these filters. Broaden the view or select another scope.</p> : <>
        {rows.slice(activePage * 30, (activePage + 1) * 30).map((row) => <FeatureRow key={`${row.featureId}:${row.action}`} row={row} />)}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-subtle-foreground"><span>{rows.length} feature actions · page {activePage + 1} of {pageCount}</span><div className="flex gap-2"><Button size="sm" variant="outline" disabled={activePage === 0} onClick={() => setPage(activePage - 1)}>Previous</Button><Button size="sm" variant="outline" disabled={activePage + 1 >= pageCount} onClick={() => setPage(activePage + 1)}>Next</Button></div></div>
      </>}
    </SettingsSection>
  </div>;
}
