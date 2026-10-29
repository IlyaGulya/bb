import { useEffect, useState } from "react";
import { useRealtime, useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDeleteDialog, ConfirmDeleteDialogContent } from "@/components/ui/confirm-delete-dialog";
import { ExecutionPicker } from "../execution-picker.js";
import { useTasksQuery } from "../../shell/data.js";
import type { Attachment } from "../../shared/contract.js";
import type { TaskArtifact, TaskArtifactRpcContract, TaskArtifactView } from "../../shared/artifacts.js";
import { attachmentDownloadUrl } from "../../shared/attachments.js";
import { ResponsiveDrawerShell } from "@/components/ui/responsive-overlay";
import { artifactAgentReference } from "./artifact-panel.js";

const changeSchema = z.object({ taskId: z.string(), executionContextId: z.string() });
const systemSchema = z.object({ changes: z.array(z.string()) });

function ArtifactDetail({ artifact, attachments, onRemove }: {
  artifact: TaskArtifact;
  attachments: Attachment[];
  onRemove: () => Promise<void>;
}) {
  const rpc = useRpc<TaskArtifactRpcContract>();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<TaskArtifactView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const imageAttachment = attachments.find(file => file.id === artifact.annotation?.image.attachmentId);
  useEffect(() => {
    let cancelled = false;
    if (!open) return;
    setView(null); setError(null);
    rpc.call("getTaskArtifact", { taskId: artifact.taskId, executionContextId: artifact.executionContextId, artifactId: artifact.id }).then(value => {
      if (!cancelled) setView(value);
    }, () => { if (!cancelled) setError("Could not verify the source in this context. The retained selection has not been replaced."); });
    return () => { cancelled = true; };
  }, [rpc, open, artifact, retry]);
  return <article className="space-y-3 border-b border-border py-4">
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} className="min-h-11 min-w-0 flex-1 break-words rounded-sm text-left text-sm font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{artifact.decision}</button>
      <span className="text-xs text-muted-foreground">{artifact.annotation ? "Screenshot annotation" : "Decision bookmark"}</span>
    </div>
    {open && <div className="space-y-3">
      <blockquote className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{artifact.source.quote}</blockquote>
      {view === null && !error && <Skeleton className="h-5 w-48" />}
      {view && (view.sourceUrl ? <a href={view.sourceUrl} className="inline-flex min-h-11 items-center rounded-sm text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring">Open source message{view.sourceStatus === "archived" ? " (archived thread)" : ""}</a> : <p className="text-sm text-muted-foreground">{view.sourceStatus === "deleted" ? "Source thread deleted." : view.sourceStatus === "changed" ? "Source message changed." : "Source is unavailable or no longer permitted."} The selected snapshot remains with this task.</p>)}
      {artifact.annotation && <div className="space-y-2">
        <p className="whitespace-pre-wrap break-words text-sm">{artifact.annotation.comment}</p>
        <p className="text-xs text-muted-foreground">Original image pixels: left {artifact.annotation.region.x}, top {artifact.annotation.region.y}, {artifact.annotation.region.width} × {artifact.annotation.region.height}; image {artifact.annotation.image.width} × {artifact.annotation.image.height}.</p>
        {imageAttachment ? <button type="button" className="block max-w-full rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Open retained screenshot" onClick={() => setLightbox(true)}>
          <img className="max-h-64 max-w-full rounded-md border border-border object-contain" src={attachmentDownloadUrl(imageAttachment.id)} alt={artifact.annotation.comment} />
        </button> : <p role="alert" className="text-sm text-destructive">The retained image attachment could not load. Retry the task attachments before relying on this snapshot.</p>}
        <details className="text-xs text-muted-foreground"><summary className="min-h-11 cursor-pointer py-2">Image provenance</summary><p className="break-all font-mono">SHA-256 {artifact.annotation.image.sha256}</p></details>
      </div>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={view === null} onClick={async () => {
          try { await navigator.clipboard.writeText(artifactAgentReference(artifact)); setCopied(true); setError(null); }
          catch { setError("Could not copy the agent reference. Open this artifact from its source message to add it to the current prompt."); }
        }}>{copied ? "Agent reference copied" : "Copy agent reference"}</Button>
        <Button type="button" variant="ghost" onClick={() => setRetry(value => value + 1)}>Refresh source</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => setConfirm(true)}>Remove retained artifact</Button>
      </div>
      {copied && <p role="status" className="text-sm text-muted-foreground">Paste into the existing agent's prompt. This does not create or start another writer.</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>}
    <ResponsiveDrawerShell open={lightbox && imageAttachment !== undefined} onOpenChange={setLightbox} srLabel="Retained screenshot" contentClassName="max-w-4xl">
      {imageAttachment && <div className="min-h-0 space-y-3 overflow-y-auto p-4">
        <img className="max-h-full max-w-full object-contain" src={attachmentDownloadUrl(imageAttachment.id)} alt={artifact.annotation?.comment ?? imageAttachment.fileName} />
        <Button type="button" variant="outline" onClick={() => setLightbox(false)}>Close screenshot</Button>
      </div>}
    </ResponsiveDrawerShell>
    <ConfirmDeleteDialog open={confirm} onOpenChange={value => { if (!busy) setConfirm(value); }}>
      <ConfirmDeleteDialogContent title="Remove retained artifact?" description="This removes the saved decision, source snapshot and annotation metadata. The task's existing image attachment stays until you explicitly remove it. This cannot be undone." confirmLabel="Remove artifact" pending={busy} size="sm" onCancel={() => setConfirm(false)} onConfirm={async () => {
        if (busy) return;
        setBusy(true);
        try { await onRemove(); setConfirm(false); }
        catch { setError("The retained artifact was not confirmed removed. Refresh and retry."); }
        finally { setBusy(false); }
      }} />
    </ConfirmDeleteDialog>
  </article>;
}

function ScopedArtifacts({ taskId, contextId, attachments }: { taskId: string; contextId: string; attachments: Attachment[] }) {
  const rpc = useRpc<TaskArtifactRpcContract>();
  const query = useTasksQuery(async () => rpc.call("listTaskArtifacts", { taskId, executionContextId: contextId }), [], [taskId, contextId]);
  useRealtime("task-artifacts:changed", payload => {
    const change = changeSchema.safeParse(payload);
    if (change.success && change.data.taskId === taskId && change.data.executionContextId === contextId) query.refresh();
  });
  useRealtime("system:changed", payload => {
    const change = systemSchema.safeParse(payload);
    if (change.success && change.data.changes.includes("execution-contexts-changed")) query.refresh();
  });
  if (query.error) return <p role="alert" className="text-sm text-destructive">Artifacts are unavailable in this context. <button type="button" className="underline" onClick={query.refresh}>Retry</button></p>;
  if (query.data === undefined) return <Skeleton className="h-20 w-full" />;
  if (query.data.length === 0) return <p className="text-sm text-muted-foreground">No retained artifacts in this context. On a source message, choose Save decision to task to bookmark a bounded quote and optionally annotate a task screenshot.</p>;
  return <div>{query.data.map(artifact => <ArtifactDetail key={artifact.id} artifact={artifact} attachments={attachments} onRemove={async () => {
    await rpc.call("deleteTaskArtifact", { taskId, executionContextId: contextId, artifactId: artifact.id });
    query.refresh();
  }} />)}</div>;
}

export function TaskArtifactsSection({ taskId, bbProjectId, attachments }: { taskId: string; bbProjectId: string | null; attachments: Attachment[] }) {
  const sdk = useSdk();
  const [contextId, setContextId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const contexts = useTasksQuery(async () => sdk.experimental_executionContexts.list(), [], [bbProjectId]);
  useRealtime("system:changed", payload => {
    const change = systemSchema.safeParse(payload);
    if (change.success && change.data.changes.includes("execution-contexts-changed")) { setRevision(value => value + 1); contexts.refresh(); }
  });
  const choices = contexts.data?.filter(context => context.enabled && context.projectIds.length > 0) ?? [];
  const selected = choices.find(context => context.id === contextId);
  return <section aria-label="Retained decisions and annotations" className="mt-6 space-y-3">
    <h2 className="text-base font-semibold">Decisions &amp; annotations</h2>
    <p className="text-sm text-muted-foreground">Task-owned snapshots survive closing the client, server restart and source-thread archival or deletion. Moving a task or relinking its project does not change a snapshot's original context or code project.</p>
    {!bbProjectId && <p className="text-sm text-muted-foreground">Link this task project to its BB code project before retaining new source artifacts. Existing history remains in its original context.</p>}
    {contexts.error ? <p role="alert" className="text-sm text-destructive">Contexts could not load. <button type="button" className="underline" onClick={contexts.refresh}>Retry</button></p> : contexts.data === undefined ? <Skeleton className="h-11 w-full" /> : <>
      <ExecutionPicker label="Artifact context" value={contextId} dialogOpen options={choices.map(context => ({ value: context.id, label: context.name }))} onChange={setContextId} />
      {!selected && <p className="text-sm text-muted-foreground">Choose a permitted logical context to read its original retained history, including after a task move or project relink. Disabled, deleted or non-member contexts are not substituted.</p>}
      {selected && <ScopedArtifacts key={`${taskId}:${selected.id}:${revision}`} taskId={taskId} contextId={selected.id} attachments={attachments} />}
    </>}
  </section>;
}
