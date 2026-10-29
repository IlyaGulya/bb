import { useEffect, useRef, useState } from "react";
import { useComposer, useRpc, type PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { ExecutionPicker } from "../execution-picker.js";
import { useTasksRpc } from "../../shell/data.js";
import { uploadAttachment } from "./attachments.js";
import { ArtifactRegion } from "./artifact-region.js";
import type { Attachment } from "../../shared/contract.js";
import { artifactAnnotationSchema, type TaskArtifact, type TaskArtifactAnnotation, type TaskArtifactImage, type TaskArtifactRpcContract } from "../../shared/artifacts.js";

const sourceParams = z.object({
  sourceThreadId: z.string().startsWith("thr_"),
  eventSeq: z.number().int().nonnegative(),
  quote: z.string().max(4000),
}).strict();
type Targets = { executionContextId: string; contextName: string; tasks: { id: string; key: string; title: string }[] };

export function artifactAgentReference(artifact: TaskArtifact): string {
  return `Read retained task artifact ${artifact.id} with bb_task_artifact_read before changing the UI. Inspect both its image and original-pixel coordinates. Do not launch another writer or change task acceptance.`;
}

function ArtifactPanelForm({ source }: { source: z.infer<typeof sourceParams> }) {
  const rpc = useRpc<TaskArtifactRpcContract>();
  const tasksRpc = useTasksRpc();
  const composer = useComposer();
  const [search, setSearch] = useState("");
  const [targets, setTargets] = useState<Targets | null>(null);
  const [targetError, setTargetError] = useState(false);
  const [reload, setReload] = useState(0);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentsLoading, setAttachmentsLoading] = useState(false);
  const [attachmentsError, setAttachmentsError] = useState(false);
  const [image, setImage] = useState<TaskArtifactImage | null>(null);
  const [imageId, setImageId] = useState("");
  const [imageLoading, setImageLoading] = useState(false);
  const [region, setRegion] = useState<TaskArtifactAnnotation["region"]>({ x: 0, y: 0, width: 1, height: 1 });
  const [quote, setQuote] = useState(source.quote);
  const [decision, setDecision] = useState("");
  const [comment, setComment] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<TaskArtifact | null>(null);
  const [inserted, setInserted] = useState(false);
  const [imageReady, setImageReady] = useState(false);
  const imageRequest = useRef(0);
  const [saveId] = useState(() => crypto.randomUUID());
  const fileInput = useRef<HTMLInputElement>(null);
  const selectedTask = targets?.tasks.find(task => task.id === taskId);

  useEffect(() => {
    let cancelled = false;
    setTargetError(false);
    const timer = setTimeout(() => {
      rpc.call("taskArtifactTargets", { threadId: source.sourceThreadId, search }).then(value => {
        if (!cancelled) setTargets(value);
      }, () => { if (!cancelled) { setTargetError(true); setTargets(null); } });
    }, 150);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [rpc, source.sourceThreadId, search, reload]);

  useEffect(() => {
    let cancelled = false;
    setAttachments([]);
    setAttachmentsError(false);
    setAttachmentsLoading(taskId !== null);
    if (taskId) tasksRpc.call("listAttachments", { taskId }).then(value => {
      if (!cancelled) { setAttachments(value.attachments); setAttachmentsLoading(false); }
    }, () => { if (!cancelled) { setAttachmentsError(true); setAttachmentsLoading(false); } });
    return () => { cancelled = true; };
  }, [taskId, tasksRpc, reload]);

  const inspect = async (attachmentId: string) => {
    const request = ++imageRequest.current;
    setImageId(attachmentId);
    setImage(null);
    setImageReady(false);
    setError(null);
    if (!attachmentId || !taskId || !targets) return;
    setImageLoading(true);
    try {
      const result = await rpc.call("inspectTaskArtifactImage", { taskId, executionContextId: targets.executionContextId, attachmentId });
      if (request !== imageRequest.current) return;
      setImage(result);
      setRegion({ x: 0, y: 0, width: result.width, height: result.height });
    } catch {
      if (request === imageRequest.current) setError("Could not inspect this image. Choose a readable PNG, JPEG, WebP or GIF task screenshot (up to 64 megapixels), then retry.");
    } finally {
      if (request === imageRequest.current) setImageLoading(false);
    }
  };

  const annotation = image ? { image, coordinateFrame: "decoded-image-pixels" as const, region, comment } : null;
  const valid = !!selectedTask && quote.trim().length > 0 && decision.trim().length > 0 && confirmed &&
    !imageLoading && (!imageId || imageReady && artifactAnnotationSchema.safeParse(annotation).success);

  return <form className="h-full space-y-4 overflow-y-auto p-4" onSubmit={async event => {
    event.preventDefault();
    if (!valid || busy || !taskId || !targets) return;
    setBusy(true);
    setError(null);
    try {
      setSaved(await rpc.call("createTaskArtifact", { artifactId: saveId, taskId, executionContextId: targets.executionContextId, source: { threadId: source.sourceThreadId, eventSeq: source.eventSeq, quote }, decision, annotation, retentionConfirmed: true }));
    } catch {
      setError("The artifact was not confirmed saved. Check source/context access and the image, then retry. Your selection is retained; retrying the same selection does not duplicate it.");
    } finally { setBusy(false); }
  }}>
    <h2 className="text-lg font-semibold">Save decision to task</h2>
    <p className="text-sm text-muted-foreground">Retain only the selected source quote and an optional task screenshot. This does not start an agent or change task status.</p>
    {saved ? <div className="space-y-3" role="status">
      <p className="text-sm">Saved to {selectedTask?.key ?? "the task"}. The source snapshot and image belong to the task, not the thread tab.</p>
      <Button type="button" disabled={inserted} onClick={() => {
        composer.insert([artifactAgentReference(saved), " "], { at: "end" });
        composer.focus();
        setInserted(true);
      }}>{inserted ? "Added to prompt" : "Add to current prompt"}</Button>
      <p className="text-sm text-muted-foreground">Review the prompt before sending. The existing agent reads the actual retained image with its coordinates; no second writer is created.</p>
    </div> : <fieldset disabled={busy} className="min-w-0 space-y-4">
      <label className="block space-y-1 text-sm"><span>Find task in the source project</span><Input value={search} maxLength={200} onChange={event => setSearch(event.target.value)} className="min-h-11 text-base" /></label>
      {targetError ? <p role="alert" className="text-sm text-destructive">Tasks or the source context could not load. <button type="button" className="underline" onClick={() => setReload(value => value + 1)}>Retry</button></p> : targets === null ? <Skeleton className="h-11 w-full" /> : <>
        <p className="text-sm text-muted-foreground">Retain in {targets.contextName}. Context comes from the source thread, independently of the model account.</p>
        <ExecutionPicker label="Task" dialogOpen value={taskId} disabled={busy} options={targets.tasks.map(task => ({ value: task.id, label: `${task.key} · ${task.title}` }))} onChange={value => {
          imageRequest.current++;
          setTaskId(value); setImageId(""); setImage(null); setImageReady(false); setImageLoading(false); setConfirmed(false); setError(null);
        }} />
        {targets.tasks.length === 0 && <p className="text-sm text-muted-foreground">No matching tasks in this source project. Create or link the intended task first; saving here never creates another queue.</p>}
      </>}
      <label className="block space-y-1 text-sm"><span>Source quote</span><Textarea value={quote} maxLength={4000} required onChange={event => setQuote(event.target.value)} className="min-h-24 text-base" /><span className="text-xs text-muted-foreground">Up to 4000 characters from this exact message. Select a short passage in the timeline for longer messages.</span></label>
      <label className="block space-y-1 text-sm"><span>Decision or requested change</span><Textarea value={decision} maxLength={4000} required onChange={event => setDecision(event.target.value)} className="min-h-24 text-base" /></label>
      {taskId && <div className="space-y-3">
        <h3 className="text-sm font-medium">Screenshot annotation (optional)</h3>
        <p className="text-sm text-muted-foreground">Upload an authorized screenshot or choose an existing task image. Live browser capture and element picking remain desktop-only.</p>
        {attachmentsLoading ? <Skeleton className="h-11 w-full" /> : <ExecutionPicker label="Screenshot" dialogOpen value={imageId} disabled={busy || imageLoading} options={[{ value: "", label: "No screenshot — retain decision only" }, ...attachments.filter(file => file.isImage).map(file => ({ value: file.id, label: file.fileName }))]} onChange={value => { void inspect(value); }} />}
        {attachmentsError && <p role="alert" className="text-sm text-destructive">Task images could not load. <button type="button" className="underline" onClick={() => setReload(value => value + 1)}>Retry</button></p>}
        <Button type="button" variant="outline" disabled={busy || imageLoading} onClick={() => fileInput.current?.click()}>Upload screenshot</Button>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" aria-label="Upload task screenshot" onChange={async event => {
          const file = event.target.files?.[0]; event.target.value = "";
          if (!file || !taskId) return;
          setBusy(true); setError(null);
          try {
            const uploaded = await uploadAttachment(file, { taskId });
            const current = await tasksRpc.call("listAttachments", { taskId });
            setAttachments(current.attachments);
            await inspect(uploaded.attachmentId);
          } catch { setError("Screenshot upload was not confirmed. Check task attachments before retrying; uploaded images stay with the task even if you cancel this artifact."); }
          finally { setBusy(false); }
        }} />
        {imageLoading && <p role="status" className="text-sm text-muted-foreground">Inspecting screenshot…</p>}
        {image && <>
          <ArtifactRegion key={image.attachmentId} image={image} region={region} onChange={setRegion} onValidityChange={setImageReady} />
          <label className="block space-y-1 text-sm"><span>Annotation comment</span><Textarea value={comment} maxLength={4000} required onChange={event => setComment(event.target.value)} className="min-h-20 text-base" /></label>
        </>}
      </div>}
      <label className="flex min-h-11 items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} className="mt-1 size-4 shrink-0 accent-primary" /><span>I have reviewed this bounded quote and screenshot for secrets and permission. Retain them with this task even if the source thread is archived or deleted.</span></label>
      <Button type="submit" disabled={!valid || busy}>{busy ? "Saving…" : "Save retained artifact"}</Button>
    </fieldset>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </form>;
}

export function TaskArtifactPanel({ params }: PluginThreadPanelProps) {
  const parsed = sourceParams.safeParse(params);
  if (!parsed.success) return <p className="p-4 text-sm text-muted-foreground">Use Save decision to task on a source message or a selected passage to retain it here.</p>;
  return <ArtifactPanelForm key={`${parsed.data.sourceThreadId}:${parsed.data.eventSeq}`} source={parsed.data} />;
}
