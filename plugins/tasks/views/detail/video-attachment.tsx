import { experimental_saveFile, experimental_useProductAnalytics } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { attachmentDownloadUrl, attachmentFileDownloadUrl } from "../../shared/attachments.js";
import type { Attachment } from "../../shared/contract.js";
import { formatFileSize } from "../activity/time.js";

type VideoFile = Pick<Attachment, "id" | "fileName" | "mime" | "sizeBytes">;
type Action = "video.open" | "video.play" | "video.seek" | "video.close" | "video.error";
type Outcome = "succeeded" | "failed" | "cancelled";

function durationLabel(seconds: number): string {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function VideoAttachment({ attachment, children }: { attachment: VideoFile; children?: ReactNode }) {
  const record = experimental_useProductAnalytics();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "buffering" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const video = useRef<HTMLVideoElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const active = useRef(false);
  const failed = useRef(false);
  const operations = useRef(new Map<Action, { id: string; start: number }>());

  const begin = useCallback((action: Action) => {
    if (operations.current.has(action)) return;
    const operation = { id: crypto.randomUUID(), start: performance.now() };
    operations.current.set(action, operation);
    record(action, "started", { operationId: operation.id });
  }, [record]);
  const finish = useCallback((action: Action, outcome: Outcome, errorCode: "none" | "unavailable" | "cancelled" | "invalid" = "none") => {
    const operation = operations.current.get(action);
    if (!operation) return;
    operations.current.delete(action);
    record(action, "completed", { operationId: operation.id, outcome, errorCode, durationMs: performance.now() - operation.start });
  }, [record]);
  const stop = useCallback(() => {
    const element = video.current;
    if (element) {
      element.pause();
      element.removeAttribute("src");
      element.load();
    }
    finish("video.play", "cancelled", "cancelled");
    finish("video.seek", "cancelled", "cancelled");
    finish("video.open", "cancelled", "cancelled");
  }, [finish]);
  const fail = useCallback((message: string, errorCode: "unavailable" | "invalid") => {
    if (!active.current || failed.current) return;
    failed.current = true;
    begin("video.error");
    setState("error");
    setError(message);
    finish("video.play", "failed", errorCode);
    finish("video.seek", "failed", errorCode);
    finish("video.error", "failed", errorCode);
    video.current?.pause();
  }, [begin, finish]);
  const attachVideo = useCallback((element: HTMLVideoElement | null) => {
    if (!element && video.current) {
      video.current.pause();
      video.current.removeAttribute("src");
      video.current.load();
    }
    video.current = element;
    if (!element || !active.current) return;
    if (!element.hasAttribute("src") && !failed.current) element.src = attachmentDownloadUrl(attachment.id);
    const operation = operations.current.get("video.open");
    if (operation) record("video.open", "opened", { operationId: operation.id });
    finish("video.open", "succeeded");
    if (!element.canPlayType(attachment.mime)) fail("This browser does not support this video format. Download the original or use a browser with MP4 / WebM support.", "unavailable");
  }, [attachment.id, attachment.mime, fail, finish, record]);
  const changeOpen = useCallback((next: boolean) => {
    if (next === active.current) return;
    active.current = next;
    if (next) {
      failed.current = false;
      setState("loading"); setError(null); setDuration(null);
      begin("video.open");
    } else {
      begin("video.close");
      stop();
      finish("video.close", "succeeded");
    }
    setOpen(next);
  }, [begin, finish, stop]);
  useEffect(() => () => {
    if (active.current) {
      active.current = false;
      setOpen(false);
      begin("video.close");
      stop();
      finish("video.close", "succeeded");
    }
  }, [begin, finish, stop]);

  const updateDuration = useCallback((event: SyntheticEvent<HTMLVideoElement>) => {
    const seconds = event.currentTarget.duration;
    setDuration(Number.isFinite(seconds) && seconds > 0 ? seconds : null);
  }, []);

  const downloadUrl = attachmentFileDownloadUrl(attachment.id);
  return <Dialog open={open} onOpenChange={changeOpen} modal={false}>
    <DialogTrigger asChild>
      <Button ref={trigger} variant="outline" className="h-auto min-w-0 max-w-full justify-start gap-2 py-2" aria-label={`Watch ${attachment.fileName}`}>
        <Icon name="Play" className="size-4 shrink-0" />
        {children ?? <span className="min-w-0 text-left"><span className="block truncate">{attachment.fileName}</span><span className="block text-xs text-muted-foreground">Video · {formatFileSize(attachment.sizeBytes)}</span></span>}
      </Button>
    </DialogTrigger>
    <DialogContent className="max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-4xl overflow-y-auto" compactContentClassName="max-w-full" hideCloseButton onAfterCloseAutoFocus={() => trigger.current?.focus({ preventScroll: true })}>
      <DialogHeader className="pr-12">
        <DialogTitle className="break-words">{attachment.fileName}</DialogTitle>
        <DialogDescription>{formatFileSize(attachment.sizeBytes)} · {duration === null ? "Duration unknown" : durationLabel(duration)} · {attachment.mime === "video/mp4" ? "MP4" : "WebM"}</DialogDescription>
      </DialogHeader>
      <DialogClose asChild><Button variant="ghost" size="icon" className="absolute right-3 top-3" aria-label="Close video"><Icon name="X" className="size-4" /></Button></DialogClose>
      <div className="min-w-0 space-y-3">
        <div className="relative overflow-hidden rounded-md border border-border bg-secondary">
          {open && <video key={attempt} ref={attachVideo} src={error ? undefined : attachmentDownloadUrl(attachment.id)} controls playsInline preload="metadata" aria-label={`Video: ${attachment.fileName}`} className="block max-h-[65dvh] w-full object-contain"
            onLoadedMetadata={updateDuration}
            onDurationChange={updateDuration}
            onCanPlay={() => { if (active.current) setState("ready"); }}
            onWaiting={() => { if (active.current && !error) setState("buffering"); }}
            onPlay={event => { if (!active.current) { event.currentTarget.pause(); return; } begin("video.play"); }}
            onPlaying={event => { if (!active.current) { event.currentTarget.pause(); return; } setState("ready"); finish("video.play", "succeeded"); }}
            onPause={() => finish("video.play", "cancelled", "cancelled")}
            onSeeking={() => { if (active.current) begin("video.seek"); }}
            onSeeked={() => { if (active.current) finish("video.seek", "succeeded"); }}
            onError={event => {
              const code = event.currentTarget.error?.code;
              fail(code === 3 ? "This video could not be decoded. It may be damaged; download the original or ask for a new recording." : code === 4 ? "This video format or codec is not supported here. Download the original or ask for an MP4 / H.264 or WebM recording." : "Video is unavailable or could not be loaded. Retry, download the original, or ask for a new attachment.", code === 3 ? "invalid" : "unavailable");
            }}
          >Your browser does not support HTML video. Download the original recording below.</video>}
        </div>
        {(state === "loading" || state === "buffering") && !error && <p role="status" className="text-sm text-muted-foreground">{state === "buffering" ? "Buffering video…" : "Loading video…"} Playback starts only when you press Play.</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex flex-wrap items-center gap-2">
          {error && <Button variant="outline" onClick={() => { failed.current = false; setState("loading"); setError(null); setDuration(null); setAttempt(value => value + 1); }}>Retry video</Button>}
          <Button variant="outline" asChild><a href={downloadUrl} download={attachment.fileName} onClick={event => { event.preventDefault(); void experimental_saveFile({ url: downloadUrl, fileName: attachment.fileName }); }}>Download video file</a></Button>
          <span className="text-xs text-muted-foreground">Human demo only · technical smoke and review remain separate.</span>
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}
