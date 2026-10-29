import { useEffect, useRef, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { Preset } from "../../shared/contract.js";
import type { TaskWorkflow, TaskWorkflowRpcContract } from "../../shared/workflow-contract.js";
import { WORKFLOW_TEMPLATES, type WorkflowPreparation, type WorkflowSelection, type WorkflowSetupContract } from "../../shared/workflow-preparation.js";
import { useTasksQuery } from "../../shell/data.js";
import { useExecutionSelections } from "../execution-selection.js";
import { useWorkflowDraft } from "./workflow-draft.js";
import { WorkflowPicker, WorkflowRoleFields } from "./workflow-fields.js";
import { Dialog, DialogTrigger, DialogClose, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { evidenceRequirement } from "../../../workflows/src/build-review-contract.js";
import { WorkflowEvidence } from "./workflow-evidence.js";

export function TaskWorkflowPanel({ taskId, profiles }: { taskId: string; profiles: Preset[] }) {
  const rpc = useRpc<TaskWorkflowRpcContract>();
  const setup = useRpc<WorkflowSetupContract>();
  const navigate = useBbNavigate();
  const draft = useWorkflowDraft(taskId);
  const [open, setOpen] = useState(false);
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
  return <section className="space-y-3">
    <Dialog open={open} onOpenChange={next => { setOpen(next); if (!next) void draft.flush(); }}>
      <DialogTrigger asChild><Button variant="outline">{active ? "Workflow details" : "Launch workflow"}</Button></DialogTrigger>
      {draft.error && !open && <p role="alert" className="text-sm text-destructive">Draft not saved. Reopen workflow to retry; your choices are still held in this window.</p>}
      {connectionError && !open && <p role="alert" className="text-sm text-destructive">Workflow connection lost. Last observed state is retained.</p>}
      {preparation && !active && <p role="status" className="text-sm text-muted-foreground">{preparation.error ?? preparation.progress}</p>}
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto" compactContentClassName="max-w-full">
        <DialogHeader><DialogTitle>Launch workflow</DialogTitle><DialogDescription>Choose the roles, prepare a private workspace, then start explicitly. Closing never starts or cancels an agent.</DialogDescription></DialogHeader>
        {!selection ? <div className="space-y-3" aria-label="Loading saved workflow draft"><Skeleton className="h-10 w-full" /><Skeleton className="h-40 w-full" /></div> : <div className="min-w-0 space-y-4">
          <p className="text-sm text-muted-foreground">Code project: {project.data?.name ?? "Link this task's tracker project to a code project first"}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="min-w-0 space-y-1 text-sm"><span>Workflow</span><WorkflowPicker label="Workflow template" value={selection.template} options={WORKFLOW_TEMPLATES.map(entry => ({ value: entry.id, label: entry.name }))} dialogOpen={open} disabled={frozen} onChange={value => { const next = WORKFLOW_TEMPLATES.find(entry => entry.id === value); if (next) { change({ template: next.id }); setChecksText(null); } }} /></label>
            <label className="min-w-0 space-y-1 text-sm"><span>Execution machine</span><WorkflowPicker label="Execution machine" value={selection.hostId} options={(machines.data ?? []).map(machine => ({ value: machine.id, label: machine.name }))} dialogOpen={open} disabled={frozen} onChange={hostId => change({ hostId })} /></label>
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
              <label className="block space-y-1 text-sm"><span>Human-review evidence policy</span><WorkflowPicker label="Human-review evidence policy" value={selection.evidencePolicy?.requirement ?? (selection.uiRequired ? "legacy-ui" : "legacy-technical")} options={[
                { value: "technical", label: "Backend / CLI · technical smoke required" },
                { value: "video", label: "UI / interactive · video required (default for new UI work)" },
                { value: "ui", label: "Explicit exception · screenshot or preview accepted" },
                ...(!selection.evidencePolicy ? [{ value: selection.uiRequired ? "legacy-ui" : "legacy-technical", label: selection.uiRequired ? "Saved legacy policy · screenshot or preview required" : "Saved legacy policy · technical smoke required" }] : []),
              ]} dialogOpen={open} disabled={frozen} onChange={value => { if (value === "technical" || value === "ui" || value === "video") change({ evidencePolicy: { version: 1, requirement: value } }); }} /></label>
              <p className="text-xs text-muted-foreground">{evidenceRequirement(selection) === "video" ? "A short real recording on the reviewed commit is required. Attach MP4 or WebM (up to 25 MiB); screenshots, previews and local paths cannot replace it. If safe recording is unavailable, the workflow is blocked." : "Technical smoke and independent review remain required. New UI / interactive work defaults to video when selected; saved legacy choices are unchanged."} Human Accept is separate from merge or deployment.</p>
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
        </div>}
        <DialogFooter className="sticky bottom-0 items-center gap-2 bg-background py-2">
          <span role="status" className="mr-auto text-xs text-muted-foreground">{draft.saving ? "Saving draft…" : draft.error ? "Draft not saved" : draft.draft?.revision ? "Draft saved on server" : "Choose workflow settings"}</span>
          <DialogClose asChild><Button variant="outline">Close</Button></DialogClose>
          {!active && <Button disabled={busy || draft.saving || !!draft.error || !project.data || !selection?.hostId || !selection.writer || !selection.reviewer || !selection.smokeCommands.length || !!connectionError} onClick={() => void act(async () => {
            if (!await draft.flush()) return;
            if (ready && preparation) {
              const run = await rpc.call("launchTaskWorkflow", { taskId, preparationId: preparation.id });
              setRuns(current => [run, ...current.filter(entry => entry.id !== run.id)]);
              setOpen(false);
            } else {
              setPreparation(await setup.call("prepareTaskWorkflow", { taskId, revision: draft.savedRevision() }));
            }
          })}>{busy ? "Working…" : ready ? "Start workflow" : preparation ? "Check preparation" : "Prepare workspace"}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {runs.map(run => <article key={run.id} className="space-y-2 border-t border-border pt-3">
      <p className="text-sm">Workflow · {run.state.replaceAll("_", " ")}{run.native?.phase ? ` · ${run.native.phase}` : ""} · revision {run.revision}</p>
      <p className="text-xs text-muted-foreground">Evidence policy: {run.native?.evidencePolicy ? `v1 · ${run.native.evidencePolicy.requirement === "video" ? "video required" : run.native.evidencePolicy.requirement === "ui" ? "screenshot or preview accepted" : "technical smoke required"}` : run.native?.uiRequired !== undefined ? `legacy · ${run.native.uiRequired ? "screenshot or preview required" : "technical smoke required"}` : "legacy · not recorded in this saved result"}</p>
      {run.error && <p role="alert" className="text-sm text-destructive">{run.error}</p>}
      <div className="flex flex-wrap gap-2">{run.native?.workers.map(worker => <Button key={worker.threadId} size="sm" variant="outline" onClick={() => navigate.toThread(worker.threadId)}>Open {worker.role === "writer" ? "writer" : "independent reviewer"}</Button>)}</div>
      {run.native?.result && <><p className="text-sm">Independent review: {run.native.result.review.verdict.replaceAll("_", " ")} · {run.native.result.review.summary}</p><details><summary className="cursor-pointer text-sm">Result diagnostics and observed evidence</summary><Button size="sm" variant="ghost" onClick={() => void act(async () => { await navigator.clipboard.writeText(JSON.stringify(run.native?.result, null, 2)); })}>Copy result diagnostics</Button><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(run.native.result, null, 2)}</pre></details></>}
      {run.native?.result && <WorkflowEvidence taskId={taskId} build={run.native.result.build} />}
      {run.native?.policyLimitations.map(limit => <p key={limit} className="text-xs text-muted-foreground">{limit}</p>)}
      {run.state === "in_review" && <Button disabled={busy} onClick={() => void act(async () => { const accepted = await rpc.call("acceptTaskWorkflow", { id: run.id, revision: run.revision }); setRuns(current => current.map(entry => entry.id === accepted.id ? accepted : entry)); })}>Accept reviewed result</Button>}
      {["in_review", "failed"].includes(run.state) && <div className="space-y-2"><label className="block space-y-1 text-sm"><span>Human feedback</span><Textarea value={feedback} onChange={event => setFeedback(event.target.value)} /></label><Button variant="outline" disabled={busy || !feedback.trim()} onClick={() => void act(async () => { const returned = await rpc.call("returnTaskWorkflow", { id: run.id, revision: run.revision, feedback }); setRuns(current => current.map(entry => entry.id === returned.id ? returned : entry)); })}>{run.native?.contextStarted === false ? "Retry first writer with feedback" : "Return to same writer"}</Button></div>}
    </article>)}
    {error && !open && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
