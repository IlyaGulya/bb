import { useCallback, useEffect, useState, type ComponentType, type FormEvent } from "react";
import { useRpc, useSdk, type PluginRpcResult } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { memoryRpcContract } from "./server.js";
import type { MemorySelection, ReflectionProposal, TaskScope } from "./lineage.js";

type Memory = PluginRpcResult<(typeof memoryRpcContract)["listMemories"]>["memories"][number];
type Sources = PluginRpcResult<(typeof memoryRpcContract)["listMemorySources"]>;
type InitialTask = PluginRpcResult<(typeof memoryRpcContract)["resolveMemoryTask"]>;
const selectClass = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground";
const message = (error: unknown) => error instanceof Error ? error.message : "Memory request failed. Try again.";

function useLocalAnalytics() {
  const sdk = useSdk();
  const [gap, setGap] = useState(false);
  const opened = (action: "scope.select" | "draft.open" | "reflection.review", selection: MemorySelection, event: { isTrusted: boolean }) => {
    const operationId = crypto.randomUUID();
    const actorKind = event.isTrusted ? navigator.webdriver ? "agent" as const : "human" as const : "unknown" as const;
    const scope = selection.projectId ? { kind: "project" as const, projectId: selection.projectId } : { kind: "instance" as const };
    void Promise.resolve().then(() => sdk.experimental_productAnalytics.record({ events: [{
      operationId, featureId: "plugin.memory", action, version: 1, scope, actorKind,
      actorSessionId: null, surface: window.matchMedia("(max-width: 767px)").matches ? "compact" : "web",
      mode: "production", stage: "opened", outcome: "none", errorCode: "none", timestamp: Date.now(), durationMs: null,
    }] })).then(({ receipts }) => {
      const receipt = receipts.find((entry) => entry.operationId === operationId && entry.featureId === "plugin.memory" && entry.action === action && entry.stage === "opened" && entry.scope.kind === scope.kind && (entry.scope.kind !== "project" || (scope.kind === "project" && entry.scope.projectId === scope.projectId)));
      if (!receipt || (receipt.status !== "accepted" && receipt.status !== "duplicate")) setGap(true);
    }).catch(() => setGap(true));
  };
  return { opened, gap };
}

function ScopePicker({ selection, initialTask, onSelect }: { selection: MemorySelection | null; initialTask?: InitialTask; onSelect: (selection: MemorySelection | null) => void }) {
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
    const next: MemorySelection = { projectId: projectId || null, task: taskId ? { taskId, context } : null };
    analytics.opened("scope.select", next, event);
    onSelect(next);
  }}>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="space-y-1 text-sm">Project
        <select aria-label="Memory project" className={selectClass} value={projectId} onChange={(event) => {
          change(); setProjectId(event.target.value); setTaskId(""); setContext(""); setTasks([]);
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
    </div>
    <p className="text-xs text-muted-foreground">Task notes stay in the selected project and logical context. Providers, model subscriptions and tool identities do not select scope.</p>
    {loading ? <p role="status" className="text-sm text-muted-foreground">Loading available scopes…</p> : null}
    {error ? <p role="alert" className="text-sm text-destructive">{error} <Button type="button" variant="ghost" size="sm" onClick={() => setRetry((value) => value + 1)}>Retry scopes</Button></p> : null}
    {projectId && !loading && !error && tasks.length === 0 ? <p className="text-sm text-muted-foreground">No matching tasks linked to this project. Search by key or open project general notes.</p> : null}
    <Button type="submit" size="sm" disabled={loading || error !== null || Boolean(taskId && !context)}>Open memories</Button>
    {analytics.gap ? <p role="status" className="text-xs text-muted-foreground">Local action analytics delivery was not acknowledged.</p> : null}
  </form>;
}

function TaskDraft({ selection, sources, memory, replacing, onSaved, onCancel }: {
  selection: MemorySelection; sources: Sources; memory: Memory | null; replacing: boolean;
  onSaved: () => Promise<void>; onCancel: () => void;
}) {
  const rpc = useRpc<typeof memoryRpcContract>();
  const [name, setName] = useState(replacing ? "" : memory?.name ?? "");
  const [summary, setSummary] = useState(memory?.summary ?? "");
  const [details, setDetails] = useState(memory?.details ?? "");
  const [classification, setClassification] = useState<"observation" | "decision" | "assumption">(memory?.lineage?.classification ?? "observation");
  const [state, setState] = useState<"current" | "obsolete">(memory?.lineage?.state === "obsolete" ? "obsolete" : "current");
  const [sourceIndex, setSourceIndex] = useState("");
  const [quote, setQuote] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = memory !== null && !replacing;
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const selected = sources.sources[Number(sourceIndex)];
    if (!selected || sourceIndex === "") return;
    setPending(true); setError(null);
    const source = { kind: selected.kind, commentId: selected.commentId, revision: selected.revision, observedAt: Date.now(), quote };
    try {
      if (editing) {
        await rpc.call("proposeReflection", { selection, changes: [{ id: memory.id, expectedVersion: memory.version, summary, details, classification, state, source, reason }] });
      } else {
        await rpc.call("createTaskMemory", { selection, draft: { name, summary, details, classification, source, reason,
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
    <label className="block space-y-1 text-sm">Original source revision<select aria-label="Task memory source" className={selectClass} value={sourceIndex} required onChange={(event) => setSourceIndex(event.target.value)}>
      <option value="">Select an inspected original</option>
      {sources.sources.map((source, index) => <option key={`${source.kind}:${source.commentId ?? "task"}`} value={index}>{source.label}</option>)}
    </select></label>
    <label className="block space-y-1 text-sm">Exact source excerpt (optional, at most 600 characters)<Textarea aria-label="Task memory source excerpt" value={quote} maxLength={600} onChange={(event) => setQuote(event.target.value)} /></label>
    <label className="block space-y-1 text-sm">Why remember or change this?<Input aria-label="Task memory reason" value={reason} required maxLength={500} onChange={(event) => setReason(event.target.value)} /></label>
    <p className="text-xs text-muted-foreground">Keep only bounded evidence and decisions. Never paste auth, tool payloads, provider prompts, transcripts or configuration dumps. Proposals do not change current memory until explicitly applied.</p>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>Cancel draft</Button><Button type="submit" disabled={pending || sourceIndex === ""}>{pending ? "Saving…" : editing ? "Propose diff" : "Save task fact"}</Button></div>
  </form>;
}

function ProposalReview({ proposal, pending, onDecide }: { proposal: ReflectionProposal; pending: boolean; onDecide: (decision: "apply" | "reject") => void }) {
  return <section className="space-y-3 border-t border-border pt-4" aria-label={`Reflection from ${new Date(proposal.createdAt).toLocaleString()}`}>
    <h3 className="text-sm font-medium">Reflection · {proposal.state} · {new Date(proposal.createdAt).toLocaleString()}</h3>
    {proposal.diffs.map((diff) => <div key={diff.before.id} className="space-y-2">
      <p className="text-xs text-muted-foreground">Base v{diff.before.version} · {diff.after.reason}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0 space-y-1"><h4 className="text-sm font-medium">Before</h4><p className="text-xs">{diff.before.lineage.classification} · {diff.before.lineage.state}</p><p className="break-words text-sm">{diff.before.summary}</p><pre className="whitespace-pre-wrap break-words font-sans text-sm">{diff.before.details}</pre><p className="break-words text-xs text-muted-foreground">Source {diff.before.lineage.source.kind} · {diff.before.lineage.source.revision}</p></div>
        <div className="min-w-0 space-y-1"><h4 className="text-sm font-medium">Proposed</h4><p className="text-xs">{diff.after.classification} · {diff.after.state}</p><p className="break-words text-sm">{diff.after.summary}</p><pre className="whitespace-pre-wrap break-words font-sans text-sm">{diff.after.details}</pre><p className="break-words text-xs text-muted-foreground">Source {diff.after.source.kind} · {diff.after.source.revision} · observed {new Date(diff.after.source.observedAt).toLocaleString()}</p>{diff.after.source.quote ? <blockquote className="break-words text-sm">{diff.after.source.quote}</blockquote> : null}</div>
      </div>
    </div>)}
    {proposal.state === "pending" ? <div className="flex flex-wrap gap-2"><Button size="sm" disabled={pending} onClick={() => onDecide("apply")}>{pending ? "Deciding…" : "Apply reviewed diff"}</Button><Button size="sm" variant="outline" disabled={pending} onClick={() => onDecide("reject")}>Reject proposal</Button></div> : <p className="text-xs text-muted-foreground">Explicit decision recorded {proposal.decidedAt ? new Date(proposal.decidedAt).toLocaleString() : ""}. Original revisions are retained.</p>}
  </section>;
}

function TaskMemories({ selection, threadId }: { selection: MemorySelection; threadId?: string }) {
  const rpc = useRpc<typeof memoryRpcContract>();
  const analytics = useLocalAnalytics();
  const [data, setData] = useState<{ memories: Memory[]; proposals: ReflectionProposal[]; summary: string; generatedAt: number; sources: Sources } | null>(null);
  const [draft, setDraft] = useState<{ memory: Memory | null; replacing: boolean } | null>(null);
  const [history, setHistory] = useState<PluginRpcResult<(typeof memoryRpcContract)["memoryHistory"]>["history"] | null>(null);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [bindings, setBindings] = useState<{ version: number; tasks: TaskScope[] } | null>(null);
  const [retry, setRetry] = useState(0);
  const load = useCallback(async () => {
    const [records, proposals, summary, sources, bindingState] = await Promise.all([
      query ? rpc.call("searchMemories", { selection, query }) : rpc.call("listMemories", selection),
      rpc.call("listReflections", selection), rpc.call("taskSummary", selection), rpc.call("listMemorySources", selection),
      threadId && selection.projectId ? rpc.call("getTaskBindings", { projectId: selection.projectId, threadId }) : Promise.resolve(null),
    ]);
    return { data: { memories: records.memories, proposals: proposals.proposals, summary: summary.summary, generatedAt: summary.generatedAt, sources }, bindings: bindingState };
  }, [rpc, selection, query, threadId]);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(null); setData(null); setHistory(null);
    void load().then((result) => { if (active) { setData(result.data); setBindings(result.bindings); } })
      .catch((failure: unknown) => { if (active) setError(message(failure)); })
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
  if (loading) return <p role="status" className="text-sm text-muted-foreground">Loading scoped task memory and source revisions…</p>;
  return <div className="space-y-4">
    {error ? <p role="alert" className="text-sm text-destructive">{error} <Button variant="ghost" size="sm" onClick={() => setRetry((value) => value + 1)}>Reload task memory</Button></p> : null}
    {data ? <>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-medium">{data.sources.taskKey} · {selection.task?.context}</h2>
        <Button asChild size="sm" variant="outline"><a href={`/plugins/tasks/tasks/task/${encodeURIComponent(data.sources.taskKey)}`}>Open original task</a></Button>
        <Button size="sm" variant="ghost" onClick={() => setRetry((value) => value + 1)}>Refresh evidence</Button>
      </div>
      <section className="space-y-2" aria-label="Current task summary"><h3 className="text-sm font-medium">Shared runtime summary</h3><p className="text-xs text-muted-foreground">Read {new Date(data.generatedAt).toLocaleString()}. Source revisions and observation times below show freshness; read time is not new evidence.</p><pre className="whitespace-pre-wrap break-words font-sans text-sm">{data.summary}</pre></section>
      {bindings && selection.task && selection.projectId && threadId ? <div className="space-y-2">
        <p className="text-xs text-muted-foreground">This thread has {bindings.tasks.length} explicit task/context bindings. Changing runtime keeps these bindings. Multiple bindings never select a most-recent task.</p>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => {
          const task = selection.task;
          const projectId = selection.projectId;
          if (!task || !projectId) return;
          const attached = bindings.tasks.some((entry) => entry.taskId === task.taskId && entry.context === task.context);
          const tasks = attached ? bindings.tasks.filter((entry) => entry.taskId !== task.taskId || entry.context !== task.context) : [...bindings.tasks, task];
          void act(() => rpc.call("setTaskBindings", { projectId, threadId, expectedVersion: bindings.version, tasks }));
        }}>{bindings.tasks.some((entry) => entry.taskId === selection.task?.taskId && entry.context === selection.task?.context) ? "Detach this task/context" : "Bind this task/context to thread"}</Button>
      </div> : null}
      <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); setQuery(search.trim()); }}><Input aria-label="Search scoped task memories" className="min-w-0 flex-1" value={search} maxLength={200} onChange={(event) => setSearch(event.target.value)} /><Button type="submit" variant="outline">Search task memory</Button></form>
      <Button size="sm" disabled={draft !== null || pending} onClick={(event) => { analytics.opened("draft.open", selection, event); setDraft({ memory: null, replacing: false }); }}>Remember task fact</Button>
      {draft ? <TaskDraft selection={selection} sources={data.sources} memory={draft.memory} replacing={draft.replacing} onCancel={() => setDraft(null)} onSaved={async () => { await refresh(); setDraft(null); }} /> : null}
      {data.memories.length === 0 ? <p className="text-sm text-muted-foreground">{query ? "No memories match in this task/context. Clear the search to inspect all records." : "No task facts yet. Inspect an original, then remember an observation, decision or explicitly unverified assumption."}</p> : null}
      <ul className="divide-y divide-border">{data.memories.map((memory) => <li key={memory.id} className="space-y-2 py-3">
        <h3 className="break-words text-sm font-medium">{memory.name} · v{memory.version} · {memory.lineage?.classification} · {memory.lineage?.state}</h3>
        <p className="break-words text-sm">{memory.summary}</p>
        <details><summary className="cursor-pointer text-sm">Details and provenance for {memory.name}</summary><div className="mt-2 space-y-2"><p className="whitespace-pre-wrap break-words text-sm">{memory.details}</p><p className="break-words text-xs text-muted-foreground">Source {memory.lineage?.source.kind} · revision {memory.lineage?.source.revision} · observed {memory.lineage ? new Date(memory.lineage.source.observedAt).toLocaleString() : ""}</p>{memory.lineage?.source.quote ? <blockquote className="break-words text-sm">{memory.lineage.source.quote}</blockquote> : null}</div></details>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => void act(async () => { setHistory((await rpc.call("memoryHistory", { selection, name: memory.name })).history); })}>History of {memory.name}</Button>
          {memory.lineage?.state !== "replaced" ? <Button size="sm" variant="outline" disabled={pending || draft !== null} onClick={(event) => { analytics.opened("draft.open", selection, event); setDraft({ memory, replacing: false }); }}>Propose change to {memory.name}</Button> : null}
          {memory.lineage?.state === "current" ? <Button size="sm" variant="outline" disabled={pending || draft !== null} onClick={(event) => { analytics.opened("draft.open", selection, event); setDraft({ memory, replacing: true }); }}>Replace {memory.name}</Button> : null}
          {[memory.lineage?.replaces, memory.lineage?.replacedBy].map((link, index) => link ? <Button key={index} size="sm" variant="ghost" disabled={pending} onClick={() => void act(async () => { setHistory((await rpc.call("memoryHistory", { selection, name: link.id })).history); })}>{index === 0 ? "Inspect replaced original" : "Inspect replacement"} v{link.version}</Button> : null)}
        </div>
      </li>)}</ul>
      {history ? <section className="space-y-2 border-t border-border pt-4" aria-label="Memory version history"><h3 className="text-sm font-medium">Retained original revisions</h3>{history.map((entry) => <details key={`${entry.snapshot.id}:${entry.version}`}><summary className="cursor-pointer break-words text-sm">{entry.snapshot.name} v{entry.version} · {entry.action} · {new Date(entry.createdAt).toLocaleString()}</summary><p className="break-words text-sm">{entry.snapshot.summary}</p><p className="whitespace-pre-wrap break-words text-sm">{entry.snapshot.details}</p><p className="break-words text-xs text-muted-foreground">{entry.snapshot.lineage?.classification} · {entry.snapshot.lineage?.state} · source revision {entry.snapshot.lineage?.source.revision}</p></details>)}</section> : null}
      <section className="space-y-3" aria-label="Reflection proposals">
        <h2 className="text-base font-medium">Diff-first reflection</h2>
        <p className="text-sm text-muted-foreground">No automatic rewriting, deletion or governance changes. Review each proposed revision before explicitly applying it.</p>
        {data.proposals.length === 0 ? <p className="text-sm text-muted-foreground">No reflection proposals in this task/context. Use “Propose change” on a record to draft an actual diff.</p> : data.proposals.map((proposal) => <details key={proposal.id}>
          <summary className="cursor-pointer text-sm" onClick={(event) => {
            const details = event.currentTarget.parentElement;
            if (details instanceof HTMLDetailsElement && !details.open) analytics.opened("reflection.review", selection, event);
          }}>Review {proposal.state} reflection · {new Date(proposal.createdAt).toLocaleString()}</summary>
          <ProposalReview proposal={proposal} pending={pending} onDecide={(decision) => void act(() => rpc.call("decideReflection", { selection, id: proposal.id, decision }))} />
        </details>)}
      </section>
    </> : null}
    {analytics.gap ? <p role="status" className="text-xs text-muted-foreground">Local action analytics delivery was not acknowledged.</p> : null}
  </div>;
}

export function MemoryWorkspace({ general: General, threadId, initialTask }: { general: ComponentType<{ selection: MemorySelection }>; threadId?: string; initialTask?: InitialTask }) {
  const rpc = useRpc<typeof memoryRpcContract>();
  const [selection, setSelection] = useState<MemorySelection | null>(threadId || initialTask ? null : { projectId: null, task: null });
  const [loading, setLoading] = useState(Boolean(threadId));
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!threadId) return;
    let active = true;
    setLoading(true); setError(null);
    void rpc.call("threadMemoryState", { threadId }).then((result) => {
      if (active) setSelection(result.bindings.tasks.length > 1 ? null : { projectId: result.projectId, task: result.bindings.tasks[0] ?? null });
    }).catch((failure: unknown) => { if (active) setError(message(failure)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [rpc, threadId, retry]);
  if (loading) return <p role="status" className="text-sm text-muted-foreground">Loading explicit memory bindings…</p>;
  return <div className="min-w-0 space-y-4">
    {error ? <p role="alert" className="text-sm text-destructive">{error} <Button variant="ghost" size="sm" onClick={() => setRetry((value) => value + 1)}>Retry bindings</Button></p> : null}
    <ScopePicker selection={selection} initialTask={initialTask} onSelect={setSelection} />
    {selection ? selection.task ? <TaskMemories key={JSON.stringify(selection)} selection={selection} threadId={threadId} /> : <General key={JSON.stringify(selection)} selection={selection} /> : <p className="text-sm text-muted-foreground">Choose a named project/task and logical context, then open memories. Nothing from the previous scope is shown while you choose.</p>}
  </div>;
}
