import { useEffect, useRef, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { Preset } from "../../shared/contract.js";
import type { TaskWorkflow, TaskWorkflowRpcContract } from "../../shared/workflow-contract.js";
import { WORKFLOW_TEMPLATES, type WorkflowPreparation, type WorkflowSelection, type WorkflowSetupContract } from "../../shared/workflow-preparation.js";
import { useTasksQuery } from "../../shell/data.js";
import { useExecutionSelections, executionSelectionsValid } from "../execution-selection.js";
import { useWorkflowDraft } from "./workflow-draft.js";
import { WorkflowRoleFields } from "./workflow-fields.js";
import { ExecutionPicker } from "../execution-picker.js";
import { ResponsiveDrawerShell } from "@/components/ui/responsive-overlay";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";

export function TaskWorkflowPanel({ taskId, profiles }: { taskId: string; profiles: Preset[] }) {
  const rpc = useRpc<TaskWorkflowRpcContract>();
  const setup = useRpc<WorkflowSetupContract>();
  const navigate = useBbNavigate();
  const draft = useWorkflowDraft(taskId);
  const [open, setOpen] = useState(false);
  const isCompactViewport = useIsCompactViewport();
  const [runs, setRuns] = useState<TaskWorkflow[]>([]);
  const [preparation, setPreparation] = useState<WorkflowPreparation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [settings, setSettings] = useState<{ revision: number; selection: WorkflowSelection | null } | null>(null);
  const [checksText, setChecksText] = useState<string | null>(null);
  const lock = useRef(false);
  const selections = useExecutionSelections(open);
  const machines = useTasksQuery(async query => (await query.call("listMachines", {})).machines, [], []);
  const project = useTasksQuery(async () => setup.call("getTaskWorkflowProject", { taskId }), ["projects:changed"], [taskId]);
  const selection = draft.draft?.selection;
  const active = runs.some(run => run.state !== "accepted");
  const ready = preparation?.state === "ready" && JSON.stringify(selection) === JSON.stringify(preparation.selection);
  const template = WORKFLOW_TEMPLATES.find(entry => entry.id === selection?.template);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        const [result, prepared] = await Promise.all([rpc.call("taskWorkflows", { taskId }), setup.call("getTaskWorkflowPreparation", { taskId })]);
        if (!disposed) { setRuns(result.runs); setPreparation(prepared); setConnectionError(null); }
      } catch (cause) {
        if (!disposed) setConnectionError(cause instanceof Error ? cause.message : String(cause));
      }
      if (!disposed) timer = setTimeout(refresh, 3000);
    }
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [rpc, setup, taskId]);
  useEffect(() => {
    if (!selection) return;
    let disposed = false;
    setSettings(null);
    void setup.call("getProjectWorkflowSettings", { taskId, template: selection.template }).then(value => { if (!disposed) setSettings(value); }).catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { disposed = true; };
  }, [setup, taskId, selection?.template]);

  async function act(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(null);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { lock.current = false; setBusy(false); }
  }
  function change(patch: Partial<WorkflowSelection>) { if (selection) draft.change({ ...selection, ...patch }); }
  const errors = [error, connectionError, draft.error, machines.error, project.error, selections.contexts.error, selections.connections.error].filter((value): value is string => !!value);
  const preparationError = preparation?.error ?? null;
  const frozen = active || busy;
  const repairingFirstLaunch = runs.some(run => run.state === "failed" && run.native?.contextStarted === false);
  const roleFrozen = busy || active && !repairingFirstLaunch;
  const rolesAvailable = !!selection?.hostId && !!project.data && machines.data?.some(machine => machine.id === selection.hostId) && [selection.writer, selection.reviewer].every(role => role && role.executionContextId && role.modelConnectionId && role.model && executionSelectionsValid(selections, role.executionContextId, role.modelConnectionId, role.provider, selection.hostId ?? undefined, project.data?.id));
  return <section className="mb-4 space-y-3" aria-label="Task workflow">
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" className="min-h-11 sm:min-h-9" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>{active ? "Workflow details" : "Launch workflow"}</Button>
      <span className="text-xs text-muted-foreground">Plan, build, independent review, then human acceptance</span>
    </div>
    {draft.error && !open && <p role="alert" className="text-sm text-destructive">Draft not saved. Reopen workflow to retry; your choices are still held in this window.</p>}
    {connectionError && !open && <p role="alert" className="text-sm text-destructive">Workflow connection lost. Last observed state is retained.</p>}
    {preparation && !active && <p role="status" className="text-sm text-muted-foreground">{preparation.error ?? preparation.progress}</p>}
    <ResponsiveDrawerShell open={open} presentation={isCompactViewport ? "drawer" : "floating"} onOpenChange={next => { setOpen(next); if (!next) void draft.flush(); }} srLabel="Launch workflow" contentClassName="max-w-2xl">
      <div className="min-h-0 flex-auto space-y-4 overflow-y-auto p-4">
        <header className="space-y-1"><h2 className="text-lg font-semibold">Launch workflow</h2><p className="text-sm text-muted-foreground">Choose the roles, prepare a private workspace, then start explicitly. Closing never starts or cancels an agent.</p></header>
        {!selection ? <div className="space-y-3" aria-label="Loading saved workflow draft"><Skeleton className="h-10 w-full" /><Skeleton className="h-40 w-full" /></div> : <div className="min-w-0 space-y-4">
          <p className="text-sm text-muted-foreground">Code project: {project.data?.name ?? "Link this task's tracker project to a code project first"}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="min-w-0 space-y-1 text-sm"><span>Workflow</span><ExecutionPicker label="Workflow template" value={selection.template} options={WORKFLOW_TEMPLATES.map(entry => ({ value: entry.id, label: entry.name }))} dialogOpen={open} disabled={frozen} onChange={value => { const next = WORKFLOW_TEMPLATES.find(entry => entry.id === value); if (next) { change({ template: next.id }); setChecksText(null); } }} /></label>
            <label className="min-w-0 space-y-1 text-sm"><span>Execution machine</span><ExecutionPicker label="Execution machine" value={selection.hostId} options={(machines.data ?? []).map(machine => ({ value: machine.id, label: machine.name }))} dialogOpen={open} disabled={frozen} onChange={hostId => change({ hostId })} /></label>
            {(error ?? preparationError)?.toLowerCase().startsWith("machine:") && <p role="alert" className="text-sm text-destructive">{error ?? preparationError}</p>}
          </div>
          <p className="text-sm text-muted-foreground">{template?.description}</p>
          <p className="text-xs text-muted-foreground">The reviewer starts in a fresh separate conversation. The same provider, model version and account are allowed for both roles.</p>
          {repairingFirstLaunch && <p className="text-sm text-muted-foreground">No writer session was created. You can explicitly repair the role choices here, save the draft, then Return with feedback to retry. Existing or uncertain sessions are never replaced.</p>}
          <WorkflowRoleFields label="Writer" role={selection.writer} onChange={writer => change({ writer })} profiles={profiles} contexts={selections.contexts.data ?? []} connections={selections.connections.data ?? []} hostId={selection.hostId} projectId={project.data?.id ?? null} open={open} disabled={roleFrozen} error={(error ?? preparationError)?.toLowerCase().startsWith("writer:") ? error ?? preparationError ?? undefined : undefined} />
          <WorkflowRoleFields label="Independent reviewer" role={selection.reviewer} onChange={reviewer => change({ reviewer })} profiles={profiles} contexts={selections.contexts.data ?? []} connections={selections.connections.data ?? []} hostId={selection.hostId} projectId={project.data?.id ?? null} open={open} disabled={roleFrozen} error={(error ?? preparationError)?.toLowerCase().startsWith("reviewer:") ? error ?? preparationError ?? undefined : undefined} />
          <details open={selection.smokeCommands.length === 0 ? true : undefined} className="border-t border-border pt-3">
            <summary className="cursor-pointer text-sm font-medium">{selection.smokeCommands.length ? `Project checks · ${selection.smokeCommands.length} configured` : "First-use setup · configure real project checks"}</summary>
            <div className="mt-3 space-y-3">
              <p className="text-sm text-muted-foreground">Checks come from this project and template. Nothing has passed until the native writer executes them. Saving project settings is always explicit.</p>
              {settings?.selection && <Button type="button" variant="outline" size="sm" disabled={frozen} onClick={() => { draft.change(settings.selection!); setChecksText(null); }}>Use saved project settings</Button>}
              <label className="block space-y-1 text-sm"><span>Required platform smoke commands · one per line</span><Textarea disabled={frozen} value={checksText ?? selection.smokeCommands.join("\n")} onChange={event => { setChecksText(event.target.value); change({ smokeCommands: event.target.value.split("\n").map(command => command.trim()).filter(Boolean) }); }} rows={4} /></label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={frozen} checked={selection.uiRequired} onChange={event => change({ uiRequired: event.target.checked })} />Require real UI screenshot or preview evidence</label>
              <Button type="button" variant="outline" size="sm" disabled={frozen || !settings || !!draft.error || draft.saving} onClick={() => void act(async () => {
                if (!await draft.flush() || !settings) return;
                const saved = await setup.call("saveProjectWorkflowSettings", { taskId, revision: settings.revision, selection });
                setSettings(saved);
              })}>Save as this project's template settings</Button>
            </div>
          </details>
          {preparation && <div className="space-y-1 border-t border-border pt-3 text-sm" aria-live="polite">
            <p>{preparation.progress}</p>
            {preparationError && <p role="alert" className="text-destructive">{preparationError}</p>}
            {preparation.workspacePath && <p className="break-all text-muted-foreground">Workspace: {preparation.workspacePath}</p>}
            {preparation.head && <p className="text-muted-foreground">Source revision verified by the workspace status.</p>}
            {!ready && JSON.stringify(selection) !== JSON.stringify(preparation.selection) && <Button variant="ghost" size="sm" disabled={frozen} onClick={() => { draft.change(preparation.selection); setChecksText(null); }}>Restore prepared choices</Button>}
            <Button variant="ghost" size="sm" onClick={() => void act(async () => { await navigator.clipboard.writeText(JSON.stringify({ preparation, selection }, null, 2)); })}>Copy execution diagnostics</Button>
          </div>}
        </div>}
        {errors.length > 0 && <div className="space-y-2" role="alert">{errors.map((message, index) => <p key={index} className="text-sm text-destructive">{message}</p>)}
          {draft.error && <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => void draft.retry()}>Retry saving</Button><Button variant="outline" size="sm" onClick={() => { setChecksText(null); void draft.reload(); }}>Load saved draft</Button><Button variant="outline" size="sm" onClick={() => void draft.keepLocalChoices()}>Save my choices over latest draft</Button></div>}
          {!selection && <Button variant="outline" size="sm" onClick={() => void draft.reload()}>Retry loading draft</Button>}
          {(machines.error || project.error || selections.contexts.error || selections.connections.error) && <Button type="button" variant="outline" size="sm" onClick={() => { machines.refresh(); project.refresh(); selections.contexts.refresh(); selections.connections.refresh(); }}>Retry execution choices</Button>}
        </div>}
        <footer className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-border bg-background py-3">
          <span role="status" className="mr-auto text-xs text-muted-foreground">{draft.saving ? "Saving draft…" : draft.error ? "Draft not saved" : draft.draft?.revision ? "Draft saved on server" : "Choose workflow settings"}</span>
          <Button type="button" variant="outline" onClick={() => { setOpen(false); void draft.flush(); }}>Close</Button>
          {!active && <Button className="min-h-11 sm:min-h-9" disabled={busy || draft.saving || !!draft.error || !rolesAvailable || !selection?.smokeCommands.length || !!connectionError} onClick={() => void act(async () => {
            if (!await draft.flush()) return;
            if (ready && preparation) {
              const run = await rpc.call("launchTaskWorkflow", { taskId, preparationId: preparation.id });
              setRuns(current => [run, ...current.filter(entry => entry.id !== run.id)]);
              setOpen(false);
            } else {
              setPreparation(await setup.call("prepareTaskWorkflow", { taskId, revision: draft.savedRevision() }));
            }
          })}>{busy ? "Working…" : ready ? "Start workflow" : preparation ? "Check preparation" : "Prepare workspace"}</Button>}
        </footer>
      </div>
    </ResponsiveDrawerShell>
    {runs.map(run => { const result = run.native?.result; return <article key={run.id} className="space-y-3 border-t border-border pt-4 max-sm:[&_button]:min-h-11">
      <p className="text-sm font-medium">{run.state === "in_review" ? "Waiting for human review" : run.state === "failed" ? "Workflow needs attention" : `Workflow · ${run.state.replaceAll("_", " ")}`}{run.native?.phase ? ` · ${run.native.phase.replaceAll("_", " ")}` : ""} · revision {run.revision}</p>
      {run.error && <p role="alert" className="text-sm text-destructive">{run.error}</p>}
      <div className="flex flex-wrap gap-2">{run.native?.workers.map(worker => <Button key={worker.threadId} size="sm" variant="outline" onClick={() => navigate.toThread(worker.threadId)}>Open {worker.role === "writer" ? "writer" : "independent reviewer"}</Button>)}</div>
      {result && <section className="min-w-0 space-y-3" aria-label="Reviewed result package">
        <h3 className="text-sm font-semibold">Reviewed result</h3>
        <p className="break-words text-sm">Independent review: {result.review.verdict.replaceAll("_", " ")} · {result.review.summary}</p>
        {result.review.findings.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm">{result.review.findings.map((finding, index) => <li key={index} className="break-words">{finding}</li>)}</ul>}
        <dl className="space-y-1 text-sm"><div><dt className="inline font-medium">Branch: </dt><dd className="inline break-all">{result.build.branch}</dd></div><div><dt className="inline font-medium">Reviewed commit: </dt><dd className="inline break-all font-mono text-xs">{result.build.commit}</dd></div></dl>
        <details><summary className="cursor-pointer py-2 text-sm font-medium">Plan and changes</summary><p className="whitespace-pre-wrap break-words text-sm">{result.plan}</p><pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{result.build.diff}</pre></details>
        <div className="space-y-2"><h4 className="text-sm font-medium">Observed verification</h4>{result.build.commands.map((command, index) => <details key={index}><summary className="cursor-pointer break-words py-2 text-sm">{command.exitCode === 0 ? "Passed" : "Failed"} · {command.command} · exit {command.exitCode}</summary><pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words text-xs">{command.output}</pre></details>)}</div>
        {result.build.uiEvidence.map((evidence, index) => <div key={index} className="space-y-1 text-sm"><p className="break-words">{evidence.kind}: {evidence.description}</p><p className="break-all text-xs text-muted-foreground">{evidence.location}</p></div>)}
        {result.build.limitations.map((limitation, index) => <p key={index} className="break-words text-sm text-warning-text">{limitation}</p>)}
        <p className="break-words text-sm"><span className="font-medium">Next decision: </span>{result.build.nextDecision}</p>
        <details><summary className="cursor-pointer py-2 text-sm">Result diagnostics</summary><Button size="sm" variant="ghost" onClick={() => void act(async () => { await navigator.clipboard.writeText(JSON.stringify(result, null, 2)); })}>Copy result diagnostics</Button><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(result, null, 2)}</pre></details>
      </section>}
      {run.native?.policyLimitations.map(limit => <p key={limit} className="text-xs text-muted-foreground">{limit}</p>)}
      {run.state === "in_review" && <Button disabled={busy} onClick={() => void act(async () => { const accepted = await rpc.call("acceptTaskWorkflow", { id: run.id, revision: run.revision }); setRuns(current => current.map(entry => entry.id === accepted.id ? accepted : entry)); })}>Accept reviewed result</Button>}
      {["in_review", "failed"].includes(run.state) && <div className="space-y-2"><label className="block space-y-1 text-sm"><span>Human feedback</span><Textarea value={feedback} onChange={event => setFeedback(event.target.value)} /></label><Button variant="outline" disabled={busy || !feedback.trim()} onClick={() => void act(async () => {
        let repairDraftRevision: number | null = null;
        if (run.native?.contextStarted === false) {
          if (!draft.draft) throw new Error("Wait for the saved workflow draft to load before retrying");
          if (draft.savedRevision() > 0 || draft.saving || draft.error !== null) {
            if (!await draft.flush()) return;
            repairDraftRevision = draft.savedRevision();
          }
        }
        const returned = await rpc.call("returnTaskWorkflow", { id: run.id, revision: run.revision, feedback, repairDraftRevision });
        setRuns(current => current.map(entry => entry.id === returned.id ? returned : entry));
      })}>{run.native?.contextStarted === false ? "Retry first writer with feedback" : "Return to same writer"}</Button></div>}
    </article>; })}
    {error && !open && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
