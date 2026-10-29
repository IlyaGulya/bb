import type { BuildReviewResult } from "../../../workflows/src/build-review-contract.js";
import { Button } from "@/components/ui/button";
import { useTasksQuery } from "../../shell/data.js";
import { isVideoMime } from "../../shared/attachments.js";
import { VideoAttachment } from "./video-attachment.js";

export function WorkflowEvidence({ taskId, build }: { taskId: string; build: BuildReviewResult["build"] }) {
  const hasVideo = build.uiEvidence.some(evidence => evidence.kind === "video");
  const files = useTasksQuery(async rpc => {
    if (!hasVideo) return [];
    const [task, comments] = await Promise.all([
      rpc.call("listAttachments", { taskId }),
      rpc.call("listAttachments", { commentsOfTaskId: taskId }),
    ]);
    return [...task.attachments, ...comments.attachments];
  }, ["tasks:changed", "comments:changed"], [taskId, hasVideo]);
  if (build.uiEvidence.length === 0) return <p className="text-sm text-muted-foreground">No visual demo attached. Technical commands remain in result diagnostics.</p>;
  return <section className="min-w-0 space-y-3" aria-label="Human-review evidence">
    {hasVideo && files.isLoading && <p role="status" className="text-sm text-muted-foreground">Loading video attachments…</p>}
    {hasVideo && files.error && <div role="alert" className="space-y-2 text-sm text-destructive"><p>Video attachments are unavailable. This is not working video proof.</p><Button variant="outline" size="sm" onClick={files.refresh}>Retry attachments</Button></div>}
    {build.uiEvidence.map((evidence, index) => {
      if (evidence.kind !== "video") return <div key={index} className="space-y-1 text-sm"><p>{evidence.kind === "screenshot" ? "Screenshot" : "Preview"} · {evidence.description}</p><p className="break-all text-xs text-muted-foreground">{evidence.location}</p></div>;
      const attachment = files.data?.find(file => file.id === evidence.attachmentId);
      const source = files.data?.find(file => file.id === evidence.recording.sourceAttachmentId);
      return <div key={evidence.attachmentId} className="min-w-0 space-y-2">
        <p className="text-sm">{evidence.description}</p>
        {attachment && isVideoMime(attachment.mime) ? <VideoAttachment attachment={attachment} /> : !files.isLoading && !files.error ? <p role="alert" className="text-sm text-destructive">Video attachment is missing or unsupported. Ask the writer for an accessible real recording.</p> : null}
        <p className="text-sm text-muted-foreground">Scenario: {evidence.recording.scenario}</p>
        <p className="break-all text-xs text-muted-foreground">Recorded commit: {evidence.recording.commit} · Run: {evidence.recording.runId}</p>
        {evidence.recording.transformation ? <div className="space-y-2 text-sm"><p>Edited / sped up: {evidence.recording.transformation}</p>{source && isVideoMime(source.mime) ? <VideoAttachment attachment={source}>Watch original recording</VideoAttachment> : <p role="alert" className="text-destructive">Original recording is unavailable; the editing provenance cannot be reviewed.</p>}</div> : <p className="text-xs text-muted-foreground">Unedited original recording</p>}
      </div>;
    })}
  </section>;
}
