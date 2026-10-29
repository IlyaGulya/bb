import { useCallback, useEffect, useRef, useState, type ComponentType, type FormEvent } from "react";
import { useRpc, useSdk, type PluginRpcResult } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { memoryRpcContract } from "./server.js";
import type { MemorySelection, ReflectionProposal, TaskScope } from "./lineage.js";

type Memory = PluginRpcResult<(typeof memoryRpcContract)["listMemories"]>["memories"][number];
type Sources = PluginRpcResult<(typeof memoryRpcContract)["listMemorySources"]>;
type InitialTask = PluginRpcResult<(typeof memoryRpcContract)["resolveMemoryTask"]>;
type ArtifactInspection = PluginRpcResult<(typeof memoryRpcContract)["readMemoryArtifact"]>;
type ArtifactSource = Extract<NonNullable<Memory["lineage"]>["source"], { kind: "artifact" }>;
const selectClass = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground";
const message = (error: unknown) => error instanceof Error ? error.message : "Memory request failed. Try again.";

function useLocalAnalytics() {
  const sdk = useSdk();
  const rpc = useRpc<typeof memoryRpcContract>();
  const declarations = useRef<Promise<PluginRpcResult<(typeof memoryRpcContract)["memoryAnalytics"]>> | null>(null);
  const [gap, setGap] = useState(false);
  const opened = (action: "scope.select" | "draft.open" | "reflection.review" | "source.inspect", selection: MemorySelection, event: { isTrusted: boolean }) => {
    const operationId = crypto.randomUUID();
    const actorKind = event.isTrusted ? navigator.webdriver ? "agent" as const : "human" as const : "unknown" as const;
    const scope = selection.projectId ? { kind: "project" as const, projectId: selection.projectId } : { kind: "instance" as const };
    const timestamp = Date.now();
    const surface = window.matchMedia("(max-width: 767px)").matches ? "compact" : "web";
    declarations.current ??= Promise.resolve().then(() => rpc.call("memoryAnalytics"));
    void declarations.current.then(async ({ actions }) => {
      const identity = actions.find((entry) => entry.action === action);
      if (!identity) { setGap(true); return; }
      const { receipts } = await sdk.experimental_productAnalytics.record({ events: [{
        operationId, ...identity, scope, actorKind, actorSessionId: null, surface,
        mode: "production", stage: "opened", outcome: "none", errorCode: "none", timestamp, durationMs: null,
      }] });
      const receipt = receipts.find((entry) => entry.operationId === operationId && entry.featureId === identity.featureId && entry.action === identity.action && entry.stage === "opened" && entry.scope.kind === scope.kind && (entry.scope.kind !== "project" || (scope.kind === "project" && entry.scope.projectId === scope.projectId)));
      if (!receipt || (receipt.status !== "accepted" && receipt.status !== "duplicate")) setGap(true);
    }).catch(() => { declarations.current = null; setGap(true); });
  };
  return { opened, gap };
}

function ScopePicker({ selection, initialTask, threadId, boundExecutionContextId, onSelect }: { selection: MemorySelection | null; initialTask?: InitialTask; threadId?: string; boundExecutionContextId: string | null; onSelect: (selection: MemorySelection | null) => void }) {
  const rpc = useRpc<typeof memoryRpcContract>();
  const analytics = useLocalAnalytics();
  const [projects, setProjects] = useState<PluginRpcResult<(typeof memoryRpcContract)["listMemoryProjects"]>["projects"]>([]);
  const [projectId, setProjectId] = useState(selection?.projectId ?? initialTask?.projectId ?? "");
  const [tasks, setTasks] = useState<PluginRpcResult<(typeof memoryRpcContract)["listMemoryTasks"]>["tasks"]>(initialTask ? [initialTask.task] : []);
  const [taskId, setTaskId] = useState(selection?.task?.taskId ?? initialTask?.task.id ?? "");
  const [context, setContext] = useState(selection?.task?.context ?? "");
  const [search, setSearch] = useState(initialTask?.task.key ?? "");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [contexts, setContexts] = useState<PluginRpcResult<(typeof memoryRpcContract)["listMemoryExecutionContexts"]>["contexts"]>([]);
  const [executionContextId, setExecutionContextId] = useState(selection?.executionContextId ?? boundExecutionContextId ?? "");
  const [contextsLoading, setContextsLoading] = useState(false);
  const [contextsError, setContextsError] = useState<string | null>(null);
  useEffect(() => {
    if (!projectId || !taskId) { setContexts([]); setContextsError(null); setContextsLoading(false); return; }
    let active = true;
    setContextsLoading(true); setContextsError(null);
    void rpc.call("listMemoryExecutionContexts", { projectId }).then(({ contexts: available }) => { if (active) setContexts(available); })
      .catch((failure: unknown) => { if (active) { setContexts([]); setContextsError(message(failure)); } })
      .finally(() => { if (active) setContextsLoading(false); });
    return () => { active = false; };
  }, [rpc, projectId, taskId, retry]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void Promise.all([
      rpc.call("listMemoryProjects"),
      projectId ? rpc.call("listMemoryTasks", { projectId, search }) : Promise.resolve({ tasks: [] }),
    ]).then(([projectResult, taskResult]) => {
      if (!active) return;
      setProjects(projectResult.projects);
      setTasks(taskResult.tasks);
    }).catch((failure: unknown) => { if (active) setError(message(failure)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [rpc, projectId, search, retry]);
  const change = () => onSelect(null);
  return <form className="space-y-3 border-b border-border pb-4" onSubmit={(event) => {
    event.preventDefault();
    const next: MemorySelection = { projectId: projectId || null, task: taskId ? { taskId, context } : null, executionContextId: taskId ? executionContextId || null : null };
    analytics.opened("scope.select", next, event);
    onSelect(next);
  }}>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="space-y-1 text-sm">Project
        <select aria-label="Memory project" className={selectClass} value={projectId} onChange={(event) => {
          change(); setProjectId(event.target.value); setTaskId(""); setContext(""); setTasks([]);
          if (!threadId) setExecutionContextId("");
        }}>
          <option value="">Global general notes</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </label>
      {projectId ? <label className="space-y-1 text-sm">Find a task
        <Input aria-label="Find memory task" value={search} maxLength={200} placeholder="Task key or title" onChange={(event) => { change(); setSearch(event.target.value); setTaskId(""); }} />
      </label> : null}
      {projectId ? <label className="space-y-1 text-sm">Task
        <select aria-label="Memory task" className={selectClass} value={taskId} disabled={loading || error !== null} onChange={(event) => { change(); setTaskId(event.target.value); }}>
          <option value="">Project general notes</option>
          {taskId && !tasks.some((task) => task.id === taskId) ? <option value={taskId}>{initialTask?.task.key ?? "Explicit bound task"} · {context || "choose context"}</option> : null}
          {tasks.map((task) => <option key={task.id} value={task.id}>{task.key} · {task.title}</option>)}
        </select>
      </label> : null}
      {taskId ? <label className="space-y-1 text-sm">Logical context
        <Input aria-label="Memory logical context" value={context} required pattern="[a-z0-9][a-z0-9._-]{0,79}" maxLength={80} placeholder="personal-research" onChange={(event) => { change(); setContext(event.target.value); }} />
      </label> : null}
      {taskId ? <label className="space-y-1 text-sm">Retained thread evidence context
        <select aria-label="Memory execution context" className={selectClass} value={executionContextId} disabled={Boolean(threadId) || contextsLoading || contextsError !== null} onChange={(event) => { change(); setExecutionContextId(event.target.value); }}>
          <option value="">Task/comment sources only</option>
          {executionContextId && !contexts.some((entry) => entry.id === executionContextId) ? <option value={executionContextId}>{contextsLoading ? "Loading selected context…" : "Selected context is unavailable"}</option> : null}
          {contexts.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select>
      </label> : null}
    </div>
    <p className="text-xs text-muted-foreground">Task notes stay in the selected project and logical context. Providers, model subscriptions and tool identities do not select scope.</p>
    {loading ? <p role="status" className="text-sm text-muted-foreground">Loading available scopes…</p> : null}
    {error ? <p role="alert" className="text-sm text-destructive">{error} <Button type="button" variant="ghost" size="sm" onClick={() => setRetry((value) => value + 1)}>Retry scopes</Button></p> : null}
    {contextsLoading ? <p role="status" className="text-sm text-muted-foreground">Loading permitted execution contexts…</p> : null}
    {contextsError ? <p role="alert" className="text-sm text-destructive">{contextsError} <Button type="button" variant="ghost" size="sm" onClick={() => setRetry((value) => value + 1)}>Retry execution contexts</Button></p> : null}
    {taskId ? <p className="text-xs text-muted-foreground">Retained thread decisions use an actual permitted execution context, not this logical-context name or a model account. {threadId ? "This panel uses the thread's authoritative binding." : "Select a context to include its visible retained decisions."}</p> : null}
    {projectId && !loading && !error && tasks.length === 0 ? <p className="text-sm text-muted-foreground">No matching tasks linked to this project. Search by key or open project general notes.</p> : null}
    <Button type="submit" size="sm" disabled={loading || error !== null || Boolean(taskId && !context) || contextsLoading || Boolean(taskId && executionContextId && (contextsError || !contexts.some((entry) => entry.id === executionContextId)))}>Open memories</Button>
    {analytics.gap ? <p role="status" className="text-xs text-muted-foreground">Local action analytics delivery was not acknowledged.</p> : null}
  </form>;
}

function RetainedOriginal({ inspection }: { inspection: ArtifactInspection }) {
  const { view, source } = inspection;
  return <section aria-label="Retained thread original" className="space-y-2 border-t border-border pt-3">
    <h3 className="text-sm font-medium">Retained thread decision</h3>
    <p className="text-xs text-muted-foreground">Read {new Date(source.observedAt).toLocaleString()} · original status: {view.sourceStatus}. This is a retained selected quote, not a full message or thread archive.</p>
    <p className="whitespace-pre-wrap break-words text-sm">{view.artifact.decision}</p>
    <blockquote className="whitespace-pre-wrap break-words text-sm">{view.artifact.source.quote}</blockquote>
    <p className="break-all text-xs text-muted-foreground">Raw source hash: {view.artifact.source.textSha256}</p>
    <p className="text-xs text-muted-foreground">{view.artifact.source.role} · event {view.artifact.source.eventSeq} · retained {new Date(view.artifact.createdAt).toLocaleString()}</p>
    {view.sourceUrl ? <Button asChild size="sm" variant="outline"><a href={view.sourceUrl}>Open native original</a></Button> : <p className="text-xs text-muted-foreground">The native original is not currently available. The retained selected quote and raw hash remain visible under their stored context permissions.</p>}
  </section>;
}

function TaskDraft({ selection, sources, memory, replacing, onSaved, onCancel, onInspect }: {
  selection: MemorySelection; sources: Sources | null; memory: Memory | null; replacing: boolean;
  onSaved: () => Promise<void>; onCancel: () => void; onInspect: (event: { isTrusted: boolean }) => void;
}) {
  const rpc = useRpc<typeof memoryRpcContract>();
  const [name, setName] = useState(replacing ? "" : memory?.name ?? "");
  const [summary, setSummary] = useState(memory?.summary ?? "");
  const [details, setDetails] = useState(memory?.details ?? "");
  const [classification, setClassification] = useState<"observation" | "decision" | "assumption">(memory?.lineage?.classification ?? "observation");
  const [state, setState] = useState<"current" | "obsolete">(memory?.lineage?.state === "obsolete" ? "obsolete" : "current");
  const [selectedSource, setSelectedSource] = useState<(Sources["sources"][number] & { observedAt: number }) | null>(null);
  const [quote, setQuote] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inspection, setInspection] = useState<ArtifactInspection | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const sourceRequest = useRef(0);
  const editing = memory !== null && !replacing;
  const sourceIndex = selectedSource && sources ? sources.sources.findIndex((source) =>
    source.kind === selectedSource.kind && source.commentId === selectedSource.commentId && source.revision === selectedSource.revision &&
    (source.kind !== "artifact" || selectedSource.kind === "artifact" && source.artifactId === selectedSource.artifactId && source.executionContextId === selectedSource.executionContextId)) : -1;
  const selectSource = async (value: string, event: { isTrusted: boolean }) => {
    const request = ++sourceRequest.current;
    const source = value === "" ? undefined : sources?.sources[Number(value)];
    setSelectedSource(null); setInspection(null); setError(null); setInspecting(false);
    if (!source) return;
    if (source.kind !== "artifact") { setSelectedSource({ ...source, observedAt: Date.now() }); return; }
    onInspect(event);
    setInspecting(true);
    try {
      const inspected = await rpc.call("readMemoryArtifact", { ...selection, artifactId: source.artifactId,
        pin: { artifactId: source.artifactId, executionContextId: source.executionContextId, revision: source.revision, quote: "" } });
      if (request !== sourceRequest.current) return;
      if (inspected.source.artifactId !== source.artifactId || inspected.source.executionContextId !== source.executionContextId || inspected.source.revision !== source.revision) throw new Error("Retained evidence changed; refresh and explicitly select it again");
      setSelectedSource({ ...source, observedAt: inspected.source.observedAt }); setInspection(inspected);
    } catch (failure) { if (request === sourceRequest.current) setError(message(failure)); }
    finally { if (request === sourceRequest.current) setInspecting(false); }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedSource || sourceIndex < 0 || inspecting) return;
    setPending(true); setError(null);
    const evidence = { revision: selectedSource.revision, observedAt: selectedSource.observedAt, quote };
    const source = selectedSource.kind === "artifact"
      ? { ...evidence, kind: "artifact" as const, commentId: null, artifactId: selectedSource.artifactId, executionContextId: selectedSource.executionContextId }
      : { ...evidence, kind: selectedSource.kind, commentId: selectedSource.commentId };
    try {
      if (editing) {
        await rpc.call("proposeReflection", { ...selection, changes: [{ id: memory.id, expectedVersion: memory.version, summary, details, classification, state, source, reason }] });
      } else {
        await rpc.call("createTaskMemory", { ...selection, draft: { name, summary, details, classification, source, reason,
          replaces: replacing && memory ? { id: memory.id, version: memory.version } : null } });
      }
      await onSaved();
    } catch (failure) { setError(message(failure)); }
    finally { setPending(false); }
  };
  return <form onSubmit={(event) => void save(event)} className="space-y-3 border-y border-border py-4">
    <h3 className="text-sm font-medium">{editing ? `Propose change to ${memory.name} v${memory.version}` : replacing ? `Replace ${memory?.name} without erasing its original` : "Remember a task fact"}</h3>
    {!editing ? <label className="block space-y-1 text-sm">Memory name<Input aria-label="Task memory name" value={name} required maxLength={80} pattern="[a-z0-9][a-z0-9._-]{0,79}" onChange={(event) => setName(event.target.value)} /></label> : null}
    <label className="block space-y-1 text-sm">Summary<Input aria-label="Task memory summary" value={summary} required maxLength={400} onChange={(event) => setSummary(event.target.value)} /></label>
    <label className="block space-y-1 text-sm">Details<Textarea aria-label="Task memory details" className="min-h-28 text-sm" value={details} required maxLength={16000} onChange={(event) => setDetails(event.target.value)} /></label>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="space-y-1 text-sm">Evidence type<select aria-label="Task memory evidence type" className={selectClass} value={classification} onChange={(event) => {
        const value = event.target.value;
        if (value === "observation" || value === "decision" || value === "assumption") setClassification(value);
      }}><option value="observation">Observation</option><option value="decision">Decision</option><option value="assumption">Assumption — not verified</option></select></label>
      {editing ? <label className="space-y-1 text-sm">Applicability<select aria-label="Task memory applicability" className={selectClass} value={state} onChange={(event) => {
        if (event.target.value === "current" || event.target.value === "obsolete") setState(event.target.value);
      }}><option value="current">Current</option><option value="obsolete">Obsolete — keep history</option></select></label> : null}
    </div>
    <label className="block space-y-1 text-sm">Original source revision<select aria-label="Task memory source" aria-invalid={selectedSource !== null && sourceIndex < 0} className={selectClass} value={sourceIndex < 0 ? "" : String(sourceIndex)} required disabled={pending || sources === null} onChange={(event) => void selectSource(event.target.value, event)}>
      <option value="">Select an inspected original</option>
      {sources?.sources.map((source, index) => <option key={source.kind === "artifact" ? `artifact:${source.executionContextId}:${source.artifactId}` : `${source.kind}:${source.commentId ?? "task"}:${source.revision}`} value={index}>{source.label}</option>)}
    </select></label>
    {selectedSource && sourceIndex < 0 ? <p role="alert" className="text-sm text-destructive">The selected source revision changed or is unavailable. Inspect the original and explicitly select a current revision before saving. Your draft has been kept.</p> : null}
    {inspecting ? <p role="status" className="text-sm text-muted-foreground">Inspecting the selected retained original…</p> : null}
    {inspection ? <RetainedOriginal inspection={inspection} /> : null}
    <label className="block space-y-1 text-sm">Exact source excerpt (optional, at most 600 characters)<Textarea aria-label="Task memory source excerpt" value={quote} maxLength={600} onChange={(event) => setQuote(event.target.value)} /></label>
    <label className="block space-y-1 text-sm">Why remember or change this?<Input aria-label="Task memory reason" value={reason} required maxLength={500} onChange={(event) => setReason(event.target.value)} /></label>
    <p className="text-xs text-muted-foreground">Keep only bounded evidence and decisions. Never paste auth, tool payloads, provider prompts, transcripts or configuration dumps. Proposals do not change current memory until explicitly applied.</p>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>Cancel draft</Button><Button type="submit" disabled={pending || inspecting || sourceIndex < 0}>{pending ? "Saving…" : editing ? "Propose diff" : "Save task fact"}</Button></div>
  </form>;
}

function ProposalReview({ proposal, pending, canApply, onInspect, onDecide }: { proposal: ReflectionProposal; pending: boolean; canApply: boolean; onInspect: (source: ArtifactSource, event: { isTrusted: boolean }) => void; onDecide: (decision: "apply" | "reject") => void }) {
  return <section className="space-y-3 border-t border-border pt-4" aria-label={`Reflection from ${new Date(proposal.createdAt).toLocaleString()}`}>
    <h3 className="text-sm font-medium">Reflection · {proposal.state} · {new Date(proposal.createdAt).toLocaleString()}</h3>
    {proposal.diffs.map((diff) => <div key={diff.before.id} className="space-y-2">
      <p className="text-xs text-muted-foreground">Base v{diff.before.version} · {diff.after.reason}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0 space-y-1"><h4 className="text-sm font-medium">Before</h4><p className="text-xs">{diff.before.lineage.classification} · {diff.before.lineage.state}</p><p className="break-words text-sm">{diff.before.summary}</p><pre className="whitespace-pre-wrap break-words font-sans text-sm">{diff.before.details}</pre><p className="break-words text-xs text-muted-foreground">Source {diff.before.lineage.source.kind} · {diff.before.lineage.source.revision}</p></div>
        <div className="min-w-0 space-y-1"><h4 className="text-sm font-medium">Proposed</h4><p className="text-xs">{diff.after.classification} · {diff.after.state}</p><p className="break-words text-sm">{diff.after.summary}</p><pre className="whitespace-pre-wrap break-words font-sans text-sm">{diff.after.details}</pre><p className="break-words text-xs text-muted-foreground">Source {diff.after.source.kind} · {diff.after.source.revision} · observed {new Date(diff.after.source.observedAt).toLocaleString()}</p>{diff.after.source.quote ? <blockquote className="break-words text-sm">{diff.after.source.quote}</blockquote> : null}</div>
      </div>
      {diff.before.lineage.source.kind === "artifact" ? <Button size="sm" variant="ghost" disabled={pending} onClick={(event) => { const source = diff.before.lineage.source; if (source.kind === "artifact") onInspect(source, event); }}>Read retained before-original</Button> : null}
      {diff.after.source.kind === "artifact" ? <Button size="sm" variant="ghost" disabled={pending} onClick={(event) => { const source = diff.after.source; if (source.kind === "artifact") onInspect(source, event); }}>Read retained proposed original</Button> : null}
    </div>)}
    {proposal.state === "pending" ? <div className="flex flex-wrap gap-2"><Button size="sm" disabled={pending || !canApply} onClick={() => onDecide("apply")}>{pending ? "Deciding…" : "Apply reviewed diff"}</Button><Button size="sm" variant="outline" disabled={pending} onClick={() => onDecide("reject")}>Reject proposal</Button></div> : <p className="text-xs text-muted-foreground">Explicit decision recorded {proposal.decidedAt ? new Date(proposal.decidedAt).toLocaleString() : ""}. Original revisions are retained.</p>}
  </section>;
}

function TaskMemories({ selection, threadId }: { selection: MemorySelection; threadId?: string }) {
  const rpc = useRpc<typeof memoryRpcContract>();
  const analytics = useLocalAnalytics();
  type LiveEvidence = { available: true; summary: string; generatedAt: number; sources: Sources } | { available: false; error: string };
  const [data, setData] = useState<{ memories: Memory[]; page: PluginRpcResult<(typeof memoryRpcContract)["listMemories"]> | null; proposals: ReflectionProposal[]; live: LiveEvidence } | null>(null);
  const [draft, setDraft] = useState<{ memory: Memory | null; replacing: boolean } | null>(null);
  const [history, setHistory] = useState<PluginRpcResult<(typeof memoryRpcContract)["memoryHistory"]>["history"] | null>(null);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [bindings, setBindings] = useState<{ version: number; tasks: TaskScope[] } | null>(null);
  const [retry, setRetry] = useState(0);
  const [original, setOriginal] = useState<ArtifactInspection | null>(null);
  const load = useCallback(async () => {
    const live: Promise<LiveEvidence> = Promise.all([rpc.call("taskSummary", selection), rpc.call("listMemorySources", selection)])
      .then(([summary, sources]) => ({ available: true as const, summary: summary.summary, generatedAt: summary.generatedAt, sources }))
      .catch((failure: unknown) => ({ available: false as const, error: message(failure) }));
    const [records, proposals, evidence, bindingState] = await Promise.all([
      query
        ? rpc.call("searchMemories", { ...selection, query }).then(({ memories }) => ({ memories, page: null }))
        : rpc.call("listMemories", { ...selection, offset }).then((page) => ({ memories: page.memories, page })),
      rpc.call("listReflections", selection), live,
      threadId && selection.projectId ? rpc.call("getTaskBindings", { projectId: selection.projectId, threadId }) : Promise.resolve(null),
    ]);
    return { data: { memories: records.memories, page: records.page, proposals: proposals.proposals, live: evidence }, bindings: bindingState };
  }, [rpc, selection, query, offset, threadId]);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(null); setHistory(null);
    void load().then((result) => { if (active) { setData(result.data); setBindings(result.bindings); } })
      .catch((failure: unknown) => { if (active) { setData(null); setError(message(failure)); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [load, retry]);
  const refresh = async () => { const result = await load(); setData(result.data); setBindings(result.bindings); };
  const act = async (action: () => Promise<unknown>) => {
    setPending(true); setError(null);
    try { await action(); await refresh(); }
    catch (failure) { setError(message(failure)); }
    finally { setPending(false); }
  };
  const inspectOriginal = (source: ArtifactSource, event: { isTrusted: boolean }) => {
    analytics.opened("source.inspect", selection, event);
    void act(async () => { setOriginal(null); setOriginal(await rpc.call("readMemoryArtifact", { ...selection, artifactId: source.artifactId,
      pin: { artifactId: source.artifactId, executionContextId: source.executionContextId, revision: source.revision, quote: source.quote } })); });
  };
  if (loading && data === null) return <p role="status" className="text-sm text-muted-foreground">Loading scoped task memory and source revisions…</p>;
  return <div aria-busy={loading} className="space-y-4">
    {loading ? <p role="status" className="text-sm text-muted-foreground">Loading scoped task memory and source revisions…</p> : null}
    {error ? <p role="alert" className="text-sm text-destructive">{error} <Button variant="ghost" size="sm" onClick={() => setRetry((value) => value + 1)}>Reload task memory</Button></p> : null}
    {data ? <fieldset disabled={loading || pending} className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-medium">{data.live.available ? data.live.sources.taskKey : data.memories[0]?.lineage?.taskKey ?? data.proposals[0]?.diffs[0]?.before.lineage.taskKey ?? "Retained task memory"} · {selection.task?.context}</h2>
        {data.live.available ? <Button asChild size="sm" variant="outline"><a href={`/plugins/tasks/tasks/task/${encodeURIComponent(data.live.sources.taskKey)}`}>Open original task</a></Button> : null}
        <Button size="sm" variant="ghost" onClick={() => setRetry((value) => value + 1)}>Refresh evidence</Button>
      </div>
      {data.live.available ? <section className="space-y-2" aria-label="Current task summary"><h3 className="text-sm font-medium">Shared runtime summary</h3><p className="text-xs text-muted-foreground">Read {new Date(data.live.generatedAt).toLocaleString()}. Source revisions and observation times below show freshness; read time is not new evidence.</p><pre className="whitespace-pre-wrap break-words font-sans text-sm">{data.live.summary}</pre></section> : <p role="alert" className="text-sm text-destructive">{data.live.error} Retained records, version history and explicit proposal rejection remain available. New facts, changes and applying diffs require live task evidence. Use Refresh evidence after restoring the task or project link.</p>}
      {original ? <RetainedOriginal inspection={original} /> : null}
      {bindings && selection.task && selection.projectId && threadId ? <div className="space-y-2">
        <p className="text-xs text-muted-foreground">This thread has {bindings.tasks.length} explicit task/context bindings. Changing runtime keeps these bindings. Multiple bindings never select a most-recent task.</p>
        <Button size="sm" variant="outline" disabled={pending || (!data.live.available && !bindings.tasks.some((entry) => entry.taskId === selection.task?.taskId && entry.context === selection.task?.context))} onClick={() => {
          const task = selection.task;
          const projectId = selection.projectId;
          if (!task || !projectId) return;
          const attached = bindings.tasks.some((entry) => entry.taskId === task.taskId && entry.context === task.context);
          const tasks = attached ? bindings.tasks.filter((entry) => entry.taskId !== task.taskId || entry.context !== task.context) : [...bindings.tasks, task];
          void act(() => rpc.call("setTaskBindings", { projectId, threadId, expectedVersion: bindings.version, tasks }));
        }}>{bindings.tasks.some((entry) => entry.taskId === selection.task?.taskId && entry.context === selection.task?.context) ? "Detach this task/context" : "Bind this task/context to thread"}</Button>
      </div> : null}
      <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); setOffset(0); setQuery(search.trim()); }}><Input aria-label="Search scoped task memories" className="min-w-0 flex-1" value={search} maxLength={200} onChange={(event) => setSearch(event.target.value)} /><Button type="submit" variant="outline">Search task memory</Button></form>
      <Button size="sm" disabled={!data.live.available || draft !== null || pending} onClick={(event) => { analytics.opened("draft.open", selection, event); setDraft({ memory: null, replacing: false }); }}>Remember task fact</Button>
      {draft ? <TaskDraft selection={selection} sources={data.live.available ? data.live.sources : null} memory={draft.memory} replacing={draft.replacing} onCancel={() => setDraft(null)} onSaved={async () => { await refresh(); setDraft(null); }} onInspect={(event) => analytics.opened("source.inspect", selection, event)} /> : null}
      {data.memories.length === 0 ? <p className="text-sm text-muted-foreground">{query ? "No memories match in this task/context. Clear the search to inspect all records." : data.live.available ? "No task facts yet. Inspect an original, then remember an observation, decision or explicitly unverified assumption." : "No retained task facts in this scope. New facts require live task evidence."}</p> : null}
      <ul className="divide-y divide-border">{data.memories.map((memory) => <li key={memory.id} className="space-y-2 py-3">
        <h3 className="break-words text-sm font-medium">{memory.name} · v{memory.version} · {memory.lineage?.classification} · {memory.lineage?.state}</h3>
        <p className="break-words text-sm">{memory.summary}</p>
        <details><summary className="cursor-pointer text-sm">Details and provenance for {memory.name}</summary><div className="mt-2 space-y-2"><p className="whitespace-pre-wrap break-words text-sm">{memory.details}</p><p className="break-words text-xs text-muted-foreground">Source {memory.lineage?.source.kind} · revision {memory.lineage?.source.revision} · observed {memory.lineage ? new Date(memory.lineage.source.observedAt).toLocaleString() : ""}</p>{memory.lineage?.source.quote ? <blockquote className="break-words text-sm">{memory.lineage.source.quote}</blockquote> : null}</div></details>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => void act(async () => { setHistory((await rpc.call("memoryHistory", { ...selection, name: memory.name })).history); })}>History of {memory.name}</Button>
          {memory.lineage?.source.kind === "artifact" ? <Button size="sm" variant="ghost" disabled={pending} onClick={(event) => { const source = memory.lineage?.source; if (source?.kind === "artifact") inspectOriginal(source, event); }}>Read retained original for {memory.name}</Button> : null}
          {memory.lineage?.state !== "replaced" ? <Button size="sm" variant="outline" disabled={!data.live.available || pending || draft !== null} onClick={(event) => { analytics.opened("draft.open", selection, event); setDraft({ memory, replacing: false }); }}>Propose change to {memory.name}</Button> : null}
          {memory.lineage?.state === "current" ? <Button size="sm" variant="outline" disabled={!data.live.available || pending || draft !== null} onClick={(event) => { analytics.opened("draft.open", selection, event); setDraft({ memory, replacing: true }); }}>Replace {memory.name}</Button> : null}
          {[memory.lineage?.replaces, memory.lineage?.replacedBy].map((link, index) => link ? <Button key={index} size="sm" variant="ghost" disabled={pending} onClick={() => void act(async () => { setHistory((await rpc.call("memoryHistory", { ...selection, name: link.id, version: link.version })).history); })}>{index === 0 ? "Inspect replaced original" : "Inspect replacement"} v{link.version}</Button> : null)}
        </div>
      </li>)}</ul>
      {data.page ? <MemoryPagination previousOffset={data.page.previousOffset} nextOffset={data.page.nextOffset} disabled={loading || pending || draft !== null} onPage={setOffset} /> : <p className="text-xs text-muted-foreground">Search shows ranked matches. Clear the search to browse every record.</p>}
      {history ? <section className="space-y-2 border-t border-border pt-4" aria-label="Memory version history">
        <h3 className="text-sm font-medium">Retained original revisions</h3>
        {history.length === 0 ? <p className="text-sm text-muted-foreground">No retained revision is available for that version in this scope. Refresh the evidence and inspect the stored replacement link.</p> : null}
        {history.map((entry) => <details key={`${entry.snapshot.id}:${entry.version}`}>
          <summary className="cursor-pointer break-words text-sm">{entry.snapshot.name} v{entry.version} · {entry.action} · {new Date(entry.createdAt).toLocaleString()}</summary>
          <p className="break-words text-sm">{entry.snapshot.summary}</p>
          <p className="whitespace-pre-wrap break-words text-sm">{entry.snapshot.details}</p>
          <p className="break-words text-xs text-muted-foreground">{entry.snapshot.lineage?.classification} · {entry.snapshot.lineage?.state} · source revision {entry.snapshot.lineage?.source.revision}</p>
          {entry.snapshot.lineage?.source.kind === "artifact" ? <Button size="sm" variant="ghost" disabled={pending} onClick={(event) => { const source = entry.snapshot.lineage?.source; if (source?.kind === "artifact") inspectOriginal(source, event); }}>Read retained original for {entry.snapshot.name} v{entry.version}</Button> : null}
        </details>)}
      </section> : null}
      <section className="space-y-3" aria-label="Reflection proposals">
        <h2 className="text-base font-medium">Diff-first reflection</h2>
        <p className="text-sm text-muted-foreground">No automatic rewriting, deletion or governance changes. Review each proposed revision before explicitly applying it.</p>
        {data.proposals.length === 0 ? <p className="text-sm text-muted-foreground">No reflection proposals in this task/context. Use “Propose change” on a record to draft an actual diff.</p> : data.proposals.map((proposal) => <details key={proposal.id}>
          <summary className="cursor-pointer text-sm" onClick={(event) => {
            const details = event.currentTarget.parentElement;
            if (details instanceof HTMLDetailsElement && !details.open) analytics.opened("reflection.review", selection, event);
          }}>Review {proposal.state} reflection · {new Date(proposal.createdAt).toLocaleString()}</summary>
          <ProposalReview proposal={proposal} pending={pending} canApply={data.live.available} onInspect={inspectOriginal} onDecide={(decision) => void act(() => rpc.call("decideReflection", { ...selection, id: proposal.id, decision }))} />
        </details>)}
      </section>
    </fieldset> : null}
    {analytics.gap ? <p role="status" className="text-xs text-muted-foreground">Local action analytics delivery was not acknowledged.</p> : null}
  </div>;
}

export function MemoryPagination({ previousOffset, nextOffset, disabled, onPage }: {
  previousOffset: number | null; nextOffset: number | null; disabled: boolean; onPage: (offset: number) => void;
}) {
  if (previousOffset === null && nextOffset === null) return null;
  return <nav aria-label="Memory pages" className="flex flex-wrap justify-between gap-2">
    <Button type="button" size="sm" variant="outline" disabled={disabled || previousOffset === null} onClick={() => { if (previousOffset !== null) onPage(previousOffset); }}>Previous memories</Button>
    <Button type="button" size="sm" variant="outline" disabled={disabled || nextOffset === null} onClick={() => { if (nextOffset !== null) onPage(nextOffset); }}>Next memories</Button>
  </nav>;
}

export function MemoryWorkspace({ general: General, threadId, initialTask }: { general: ComponentType<{ selection: MemorySelection }>; threadId?: string; initialTask?: InitialTask }) {
  const rpc = useRpc<typeof memoryRpcContract>();
  const [selection, setSelection] = useState<MemorySelection | null>(threadId || initialTask ? null : { projectId: null, task: null, executionContextId: null });
  const [loading, setLoading] = useState(Boolean(threadId));
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [boundExecutionContextId, setBoundExecutionContextId] = useState<string | null>(null);
  useEffect(() => {
    if (!threadId) return;
    let active = true;
    setLoading(true); setError(null);
    void rpc.call("threadMemoryState", { threadId }).then((result) => {
      if (active) {
        setBoundExecutionContextId(result.executionContextId);
        setSelection(result.bindings.tasks.length > 1 ? null : { projectId: result.projectId, task: result.bindings.tasks[0] ?? null, executionContextId: result.bindings.tasks[0] ? result.executionContextId : null });
      }
    }).catch((failure: unknown) => { if (active) setError(message(failure)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [rpc, threadId, retry]);
  if (loading) return <p role="status" className="text-sm text-muted-foreground">Loading explicit memory bindings…</p>;
  return <div className="min-w-0 space-y-4">
    {error ? <p role="alert" className="text-sm text-destructive">{error} <Button variant="ghost" size="sm" onClick={() => setRetry((value) => value + 1)}>Retry bindings</Button></p> : null}
    <ScopePicker selection={selection} initialTask={initialTask} threadId={threadId} boundExecutionContextId={boundExecutionContextId} onSelect={setSelection} />
    {selection ? selection.task ? <TaskMemories key={JSON.stringify(selection)} selection={selection} threadId={threadId} /> : <General key={JSON.stringify(selection)} selection={selection} /> : <p className="text-sm text-muted-foreground">Choose a named project/task and logical context, then open memories. Nothing from the previous scope is shown while you choose.</p>}
  </div>;
}
