import { useEffect, useRef, useState } from "react";
import { useBbNavigate, useRpc, useRealtime } from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import type { InboxEntry } from "../../shared/inbox-contract.js";
import { LOCAL_AWAY_BOUNDARY, localRouteActionSchema, type RouteAction, type RouteOutcome, type RouteProposal, type RoutingRpcContract } from "../../shared/routing.js";
import type { WorkflowDraft, WorkflowSelection, WorkflowSetupContract } from "../../shared/workflow-preparation.js";
import { WORKFLOW_TEMPLATES } from "../../shared/workflow-preparation.js";
import { useTasksQuery } from "../../shell/data.js";
import { useTasksNavigation } from "../../shell/routes.js";
import { errorMessage } from "../../shared/errors.js";
import { ExecutionTargetControl } from "../detail/execution.js";
import { WorkflowRoleFields } from "../detail/workflow-fields.js";
import { useExecutionSelections } from "../execution-selection.js";
import { ExecutionPicker } from "../execution-picker.js";
import { ResponsiveDrawerShell } from "@/components/ui/responsive-overlay";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";

const field = "min-h-11 min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm sm:min-h-9";
const actionNames = { preview: "Preview exact references", link: "Link an existing task", create: "Create one native task", target: "Save or clear a task target", "workflow-draft": "Save a workflow draft" };
const changeSchema = z.object({ changes: z.array(z.string()) });

export function InboxRoutingControl({ item, refresh }: { item: InboxEntry; refresh: () => void }) {
  const [open, setOpen] = useState(false);
  const compact = useIsCompactViewport();
  return <>
    <Button type="button" size="sm" variant="outline" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>{item.sourceKind === "task_route" ? "Review parked route" : "Routing & local away"}</Button>
    <ResponsiveDrawerShell open={open} onOpenChange={setOpen} presentation={compact ? "drawer" : "floating"} srLabel="Advisory routing and local-action away" contentClassName="max-w-2xl">
      <RoutingBody item={item} active={open} refresh={refresh} close={() => setOpen(false)} />
    </ResponsiveDrawerShell>
  </>;
}

function RoutingBody({ item: entry, active, refresh, close }: { item: InboxEntry; active: boolean; refresh: () => void; close: () => void }) {
  const rpc = useRpc<RoutingRpcContract>();
  const setup = useRpc<WorkflowSetupContract>();
  const navigation = useTasksNavigation();
  const navigate = useBbNavigate();
  const query = useTasksQuery(async () => active ? rpc.call("getInboxRoute", { id: entry.id }) : null, ["inbox:changed", "tasks:changed", "threads:changed", "comments:changed"], [active, entry.id, entry.revision, entry.updatedAt]);
  const item = query.data?.source ?? entry;
  const projects = useTasksQuery(async tasks => active ? (await tasks.call("listProjects", {})).projects : [], ["projects:changed"], [active]);
  const profiles = useTasksQuery(async tasks => active ? (await tasks.call("listPresets")).presets : [], ["projects:changed"], [active]);
  const machines = useTasksQuery(async tasks => active ? (await tasks.call("listMachines", {})).machines : [], [], [active]);
  const selections = useExecutionSelections(active);
  const [shown, setShown] = useState<RouteProposal | null>(null);
  const [bindingStale, setBindingStale] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [taskRef, setTaskRef] = useState("");
  const [newTask, setNewTask] = useState(false);
  const [semantic, setSemantic] = useState(false);
  const [grantId, setGrantId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<RouteOutcome | null>(null);
  const [attempts, setAttempts] = useState("5");
  const [minutes, setMinutes] = useState("10");
  const [allowed, setAllowed] = useState<Array<z.infer<typeof localRouteActionSchema>>>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [draft, setDraft] = useState<WorkflowDraft | null>(null);
  const [checks, setChecks] = useState("");
  const [parkReason, setParkReason] = useState("");
  const lock = useRef(false);
  const previewAttempt = useRef<{ key: string; operationId: string } | null>(null);
  const applyAttempt = useRef<{ key: string; operationId: string } | null>(null);
  const enableAttempt = useRef<{ key: string; operationId: string } | null>(null);
  const operation = (ref: typeof applyAttempt, input: object) => {
    const key = JSON.stringify(input);
    const prior = ref.current;
    if (prior && prior.key === key) return prior.operationId;
    const current = { key, operationId: crypto.randomUUID() };
    ref.current = current;
    return current.operationId;
  };
  useEffect(() => {
    if (!shown && query.data?.proposal) setShown(query.data.proposal);
  }, [shown, query.data?.proposal]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { void query.refresh(); }, 15000);
    return () => clearInterval(timer);
  }, [active, query.refresh]);
  useRealtime("system:changed", payload => {
    const change = changeSchema.safeParse(payload);
    if (change.success && change.data.changes.some(entry => ["execution-contexts-changed", "model-connections-changed", "project-context-defaults-changed"].includes(entry))) {
      setBindingStale(true);
      void query.refresh();
    }
  });
  async function run(work: () => Promise<void>, propagate = false) {
    if (lock.current) {
      if (propagate) throw new Error("Another local action is still pending; wait for its receipt");
      return;
    }
    lock.current = true; setBusy(true); setError(null);
    try { await work(); }
    catch (cause) { setError(errorMessage(cause)); if (propagate) throw cause; }
    finally { lock.current = false; setBusy(false); void query.refresh(); refresh(); }
  }
  const stale = bindingStale || !!query.data?.stale || !!shown && (shown.revision !== query.data?.proposal?.revision || shown.sourceRevision !== item.revision);
  const selectedGrant = query.data?.grants.find(grant => grant.id === grantId);
  const grantUnavailable = grantId !== null && selectedGrant?.state !== "active";
  const disabled = busy || !shown || !["existing", "existing-thread", "new"].includes(shown.decision.kind) || stale || !!query.error || query.isLoading || grantUnavailable;
  const can = (kind: z.infer<typeof localRouteActionSchema>) => !disabled && (grantId === null || !!selectedGrant?.actions.includes(kind));
  async function apply(action: RouteAction) {
    if (!shown) throw new Error("Preview this source before applying a local action");
    const input = { id: item.id, expectedRevision: shown.revision, grantId, action };
    const result = await rpc.call("applyInboxRoute", { ...input, operationId: operation(applyAttempt, input) });
    setOutcome(result);
    if (result.state === "parked") throw new Error(result.reason);
    setDraft(null);
  }
  const nativeTaskProject = shown?.taskId ? shown.candidates.find(candidate => candidate.id === shown.taskId)?.projectId : null;
  const codeProjectId = projects.data?.find(project => project.id === nativeTaskProject)?.linkedBbProjectId ?? null;
  function editDraft(patch: Partial<WorkflowSelection>) { if (draft) setDraft({ ...draft, selection: { ...draft.selection, ...patch } }); }
  const errors = [error, query.error, projects.error, profiles.error, machines.error, selections.contexts.error, selections.connections.error].filter((value): value is string => !!value);
  return <div className="min-h-0 flex-auto space-y-4 overflow-y-auto p-4" aria-busy={busy}>
    <header className="space-y-1"><h2 className="text-lg font-semibold">Advisory routing</h2><p className="break-words text-sm">{item.title}</p><p className="text-sm text-muted-foreground">Choose an existing owner or propose a task. Preview never sends, prepares, starts or accepts work.</p></header>
    <form className="space-y-3" onSubmit={event => {
      event.preventDefault();
      void run(async () => {
        const input = { id: item.id, sourceRevision: item.revision, expectedRevision: query.data?.proposal?.revision ?? 0, projectId: projectId || null, taskRef, newTask, semantic, grantId };
        const result = await rpc.call("previewInboxRoute", { ...input, operationId: operation(previewAttempt, input) });
        setOutcome(result);
        if (result.proposal?.revision === input.expectedRevision + 1) { setShown(result.proposal); setBindingStale(false); setDraft(current => current?.taskId === result.proposal?.taskId ? current : null); }
      });
    }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="min-w-0 space-y-1 text-sm"><span>Tracker project</span><ExecutionPicker label="Routing tracker project" value={projectId} options={[{ value: "", label: "Choose scope" }, ...(projects.data ?? []).map(project => ({ value: project.id, label: `${project.prefix} · ${project.name}` }))]} dialogOpen={active} disabled={busy} onChange={setProjectId} /></label>
        <label className="flex min-w-0 flex-col gap-1 text-sm"><span>Exact task or thread reference</span><input className={field} value={taskRef} disabled={busy} placeholder="Task key, native ID or task link" onChange={event => setTaskRef(event.target.value)} /></label>
      </div>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={newTask} disabled={busy} onChange={event => { setNewTask(event.target.checked); if (event.target.checked) setSemantic(false); }} /><span>Propose a new task if no exact existing reference resolves</span></label>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={semantic} disabled={busy || grantId !== null || newTask} onChange={event => setSemantic(event.target.checked)} /><span>Request semantic advice from the explicitly configured Core helper. One callback, not a physical model-call limit. No router-owned service/account fallback; the selected service owns downstream model requests.</span></label>
      <Button type="submit" disabled={busy || query.isLoading || !!query.error || grantUnavailable || grantId !== null && !selectedGrant?.actions.includes("preview")}>{busy ? "Working…" : "Preview route"}</Button>
    </form>
    {query.isLoading && !query.data && <div aria-label="Loading routing receipts"><Skeleton className="h-20 w-full" /></div>}
    {shown && <section className="space-y-3 rounded-lg border border-border p-3" aria-label="Routing advice">
      <p className="text-sm font-medium">{shown.decision.kind === "existing" ? `Continue ${shown.taskKey ?? "existing task"}` : shown.decision.kind === "existing-thread" ? "Continue existing native thread" : shown.decision.kind === "new" ? "Propose one new task" : shown.decision.kind === "clarify" ? "One scope decision needed" : "Semantic advice unavailable"}</p>
      <p className="text-sm">{shown.decision.reason}</p>
      {shown.decision.kind === "clarify" && <p role="status" className="text-sm font-medium">{shown.decision.question}</p>}
      {stale && <p role="status" className="text-sm text-warning-text">Advice is stale or execution definitions changed. Your choices are retained; preview again before applying.</p>}
      {query.data?.proposal && shown.revision !== query.data.proposal.revision && <Button type="button" variant="outline" size="sm" onClick={() => { const next = query.data!.proposal; setShown(next); setDraft(current => current?.taskId === next?.taskId ? current : null); }}>Load server advice · keep local draft</Button>}
      <p className="text-sm text-muted-foreground">{shown.ownerReason}</p>
      <p className="break-words text-sm">{shown.targetSummary}</p>
      {shown.targetIssue && <p role="status" className="text-sm text-warning-text">Target not ready: {shown.targetIssue}. No account or host fallback will be used.</p>}
      <div className="flex flex-wrap gap-2">
        {shown.taskKey && <Button type="button" size="sm" variant="outline" onClick={() => navigation.go({ kind: "task", taskKey: shown.taskKey! })}>Open {shown.taskKey}{shown.owner === "managed" ? " · retained workflow / Return" : ""}</Button>}
        {shown.workerThreadIds.map((threadId, index) => <Button key={threadId} type="button" size="sm" variant="outline" onClick={() => navigate.toThread(threadId)}>{threadId === shown.threadId ? shown.owner === "prepared" ? "Open retained context" : "Open retained executor" : `Open worker ${index + 1}`}</Button>)}
        {["existing", "existing-thread", "new"].includes(shown.decision.kind) && <Button type="button" size="sm" disabled={!can(shown.decision.kind === "new" ? "create" : "link") || shown.decision.kind === "existing-thread" && grantId !== null} onClick={() => void run(() => apply({ kind: shown.decision.kind === "new" ? "create" : "link" }))}>{shown.decision.kind === "new" ? "Create task once" : "Link existing owner"}</Button>}
      </div>
      {shown.taskId && shown.owner !== "managed" && shown.owner !== "prepared" && <ExecutionTargetControl taskId={shown.taskId} presets={profiles.data} execution={{ override: shown.target, resolved: shown.target, inherited: false, summary: shown.targetSummary }} executionError={shown.targetIssue} surfaceActive={active} disabled={!active || !can("target")} saveTarget={target => run(async () => apply({ kind: "target", target }), true)} />}
      <p className="text-xs text-muted-foreground">{shown.limitation}{shown.classifierService ? ` Helper: ${shown.classifierService}. Callback invocations: ${shown.callbackInvocations}.` : " No classifier callback was invoked."}</p>
    </section>}
    {shown?.taskId && shown.owner !== "managed" && shown.owner !== "prepared" && <section className="space-y-3 border-t border-border pt-3" aria-label="Local workflow draft">
      {!draft ? <Button type="button" size="sm" variant="outline" disabled={!can("workflow-draft")} onClick={() => void run(async () => { const saved = await setup.call("getTaskWorkflowDraft", { taskId: shown.taskId! }); setDraft(saved); setChecks(saved.selection.smokeCommands.join("\n")); })}>Edit saved workflow draft · no preparation</Button> : <>
        <div className="grid gap-3 sm:grid-cols-2"><ExecutionPicker label="Draft workflow template" value={draft.selection.template} options={WORKFLOW_TEMPLATES.map(template => ({ value: template.id, label: template.name }))} dialogOpen={active} disabled={disabled} onChange={value => { const template = WORKFLOW_TEMPLATES.find(entry => entry.id === value); if (template) editDraft({ template: template.id }); }} /><ExecutionPicker label="Draft execution machine" value={draft.selection.hostId} options={(machines.data ?? []).map(machine => ({ value: machine.id, label: machine.name }))} dialogOpen={active} disabled={disabled} onChange={hostId => editDraft({ hostId })} /></div>
        <label className="flex flex-col gap-1 text-sm"><span>Base branch</span><input className={field} value={draft.selection.baseBranch} disabled={disabled} onChange={event => editDraft({ baseBranch: event.target.value })} /></label>
        <WorkflowRoleFields label="Writer" role={draft.selection.writer} onChange={writer => editDraft({ writer })} profiles={profiles.data ?? []} contexts={selections.contexts.data ?? []} connections={selections.connections.data ?? []} hostId={draft.selection.hostId} projectId={codeProjectId} open={active} disabled={disabled} />
        <WorkflowRoleFields label="Independent reviewer" role={draft.selection.reviewer} onChange={reviewer => editDraft({ reviewer })} profiles={profiles.data ?? []} contexts={selections.contexts.data ?? []} connections={selections.connections.data ?? []} hostId={draft.selection.hostId} projectId={codeProjectId} open={active} disabled={disabled} />
        <label className="block space-y-1 text-sm"><span>Required platform smoke commands · not executed here</span><Textarea rows={3} value={checks} disabled={disabled} onChange={event => { setChecks(event.target.value); editDraft({ smokeCommands: event.target.value.split("\n").map(value => value.trim()).filter(Boolean) }); }} /></label>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={draft.selection.uiRequired} disabled={disabled} onChange={event => editDraft({ uiRequired: event.target.checked })} /><span>Require actual UI evidence when this workflow is explicitly launched</span></label>
        <div className="flex flex-wrap gap-2"><Button type="button" size="sm" disabled={!can("workflow-draft")} onClick={() => void run(() => apply({ kind: "workflow-draft", draftRevision: draft.revision, selection: draft.selection }))}>Save local draft only</Button><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => { const saved = await setup.call("getTaskWorkflowDraft", { taskId: shown.taskId! }); setDraft(saved); setChecks(saved.selection.smokeCommands.join("\n")); })}>Load saved draft · discard local edits</Button></div>
      </>}
    </section>}
    <section className="space-y-3 border-t border-border pt-3" aria-label="Local-action away">
      <h3 className="text-sm font-semibold">Local-action away · {selectedGrant?.state ?? "off"}</h3><p className="text-sm text-muted-foreground">{LOCAL_AWAY_BOUNDARY}</p>
      <ExecutionPicker label="Action authority" value={grantId ?? ""} options={[{ value: "", label: "Manual local action · no away grant" }, ...(query.data?.grants ?? []).map(grant => ({ value: grant.id, label: `${grant.state} · ${grant.attempts}/${grant.maxAttempts} attempts · expires ${new Date(grant.expiresAt).toLocaleString()}` }))]} dialogOpen={active} disabled={busy} onChange={value => { setGrantId(value || null); setSemantic(false); }} />
      {selectedGrant && <div className="space-y-2 text-sm"><p>Allowed: {selectedGrant.actions.map(action => actionNames[action]).join(", ")}. Project: {projects.data?.find(project => project.id === selectedGrant.projectId)?.name ?? "unavailable"}. Scope: {selectedGrant.inboxIds.length} incoming entries and {selectedGrant.taskIds.length} explicitly selected native tasks. Server rechecks expiry and revocation before every effect; unbound thread links require a manual action.</p><details><summary className="cursor-pointer text-xs">Exact grant scope</summary><pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify({ inboxIds: selectedGrant.inboxIds, taskIds: selectedGrant.taskIds }, null, 2)}</pre></details><Button type="button" variant="outline" size="sm" disabled={busy || selectedGrant.revokedAt !== null} onClick={() => void run(async () => { await rpc.call("revokeLocalAway", { id: selectedGrant.id }); enableAttempt.current = null; setGrantId(null); })}>Revoke local-away grant</Button></div>}
      <details><summary className="cursor-pointer py-2 text-sm font-medium">Enable an explicit local-action grant</summary><form className="space-y-3" onSubmit={event => {
        event.preventDefault();
        void run(async () => {
          if (!acknowledged || !projectId || !allowed.length) throw new Error("Explicitly choose scope, allowed local actions and the local-only acknowledgement before enabling away");
          const input = { projectId, inboxIds: [item.id], taskIds: shown?.taskId ? [shown.taskId] : [], actions: allowed, maxAttempts: Number(attempts), durationSeconds: Number(minutes) * 60, acknowledgedBoundary: true as const };
          const grant = await rpc.call("enableLocalAway", { ...input, operationId: operation(enableAttempt, input) });
          setGrantId(grant.id); setSemantic(false); setAcknowledged(false);
        });
      }}>
        <p className="text-xs text-muted-foreground">Choose the tracker project above. Scope is this incoming entry{shown?.taskKey ? ` and ${shown.taskKey}` : "; no existing task is granted"}. New work never starts a native worker.</p>
        <fieldset disabled={busy} className="grid gap-2 sm:grid-cols-2"><legend className="mb-2 text-sm">Allowed local actions</legend>{localRouteActionSchema.options.map(kind => <label key={kind} className="flex items-start gap-2 text-sm"><input type="checkbox" checked={allowed.includes(kind)} onChange={event => setAllowed(current => event.target.checked ? [...current, kind] : current.filter(value => value !== kind))} /><span>{actionNames[kind]}</span></label>)}</fieldset>
        <div className="grid grid-cols-2 gap-3"><label className="flex flex-col gap-1 text-sm"><span>Action attempts · max 100</span><input className={field} type="number" min={1} max={100} step={1} required value={attempts} disabled={busy} onChange={event => setAttempts(event.target.value)} /></label><label className="flex flex-col gap-1 text-sm"><span>Lifetime · minutes, max 60</span><input className={field} type="number" min={1} max={60} step={1} required value={minutes} disabled={busy} onChange={event => setMinutes(event.target.value)} /></label></div>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={acknowledged} disabled={busy} onChange={event => setAcknowledged(event.target.checked)} /><span>I allow only this local scope. Failed/stale admitted attempts consume budget. Native execution, external actions and physical model-call guarantees are not included.</span></label>
        <Button type="submit" size="sm" disabled={busy || !projectId || !allowed.length || !acknowledged}>Enable bounded local actions</Button>
      </form></details>
    </section>
    {shown && <details><summary className="cursor-pointer py-2 text-sm">Park an action requiring human authority</summary><form className="space-y-2" onSubmit={event => { event.preventDefault(); void run(() => apply({ kind: "unknown", reason: parkReason })); }}><label className="block space-y-1 text-sm"><span>Unknown, irreversible, native, external, production, governance, Jira or acceptance request</span><Textarea value={parkReason} required disabled={busy} onChange={event => setParkReason(event.target.value)} /></label><Button type="submit" size="sm" variant="outline" disabled={busy || !parkReason.trim()}>Park in Needs input · do not execute</Button></form></details>}
    {outcome && <p role="status" className="text-sm">{outcome.state === "parked" ? "Needs input: " : "Saved: "}{outcome.reason}</p>}
    {errors.length > 0 && <div role="alert" className="space-y-2 text-sm text-destructive">{errors.map((message, index) => <p key={index}>{message}</p>)}<Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { void query.refresh(); projects.refresh(); profiles.refresh(); machines.refresh(); selections.contexts.refresh(); selections.connections.refresh(); }}>Refresh receipts and choices · does not repeat an action</Button></div>}
    {!!query.data?.journal.length && <details><summary className="cursor-pointer py-2 text-sm">Action journal · {query.data.journal.length} retained attempts</summary><ol className="space-y-2 text-sm">{query.data.journal.map(entry => <li key={entry.operationId} className="space-y-1 border-t border-border py-2"><p>{entry.kind} · {entry.state} · {new Date(entry.createdAt).toLocaleString()}</p><p className="text-muted-foreground">{entry.reason}</p>{entry.callbackState !== "none" && <p className="text-xs text-muted-foreground">Completion callback: {entry.callbackState === "requested" ? "request outcome unknown; not replayed" : entry.callbackState}. Physical model requests are not measurable here.</p>}<details><summary className="cursor-pointer text-xs">Receipt identity</summary><code className="break-all text-xs">{entry.operationId}</code></details></li>)}</ol></details>}
    <footer className="sticky bottom-0 flex justify-end border-t border-border bg-background py-3"><Button type="button" variant="outline" onClick={close}>Close · no execution</Button></footer>
  </div>;
}
