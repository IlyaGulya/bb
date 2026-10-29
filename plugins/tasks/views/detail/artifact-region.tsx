import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Input } from "@/components/ui/input";
import type { TaskArtifactAnnotation, TaskArtifactImage } from "../../shared/artifacts.js";
import { attachmentDownloadUrl } from "../../shared/attachments.js";

type Region = TaskArtifactAnnotation["region"];

export function ArtifactRegion({ image, region, onChange, onValidityChange }: {
  image: TaskArtifactImage;
  region: Region;
  onChange: (region: Region) => void;
  onValidityChange: (valid: boolean) => void;
}) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { onValidityChange(loaded && !failed); }, [loaded, failed, onValidityChange]);
  const position = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(image.width - 1, Math.max(0, Math.floor((event.clientX - bounds.left) * image.width / bounds.width))),
      y: Math.min(image.height - 1, Math.max(0, Math.floor((event.clientY - bounds.top) * image.height / bounds.height))),
    };
  };
  const change = (key: keyof Region, value: number) => {
    if (!Number.isFinite(value)) return;
    const next = { ...region, [key]: Math.floor(value) };
    next.x = Math.max(0, Math.min(image.width - 1, next.x));
    next.y = Math.max(0, Math.min(image.height - 1, next.y));
    next.width = Math.max(1, Math.min(image.width - next.x, next.width));
    next.height = Math.max(1, Math.min(image.height - next.y, next.height));
    onChange(next);
  };
  return <div className="space-y-3">
    <p className="text-sm text-muted-foreground">Drag over the screenshot or set the selection below. Coordinates use the original {image.width} × {image.height} image, not this preview.</p>
    <div
      className="relative w-full touch-none overflow-hidden rounded-md border border-border bg-surface-recessed-solid"
      style={{ aspectRatio: `${image.width} / ${image.height}` }}
      onPointerDown={event => {
        if (!loaded || failed) return;
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = position(event);
        onChange({ ...start.current, width: 1, height: 1 });
      }}
      onPointerMove={event => {
        if (!start.current) return;
        const end = position(event);
        onChange({ x: Math.min(start.current.x, end.x), y: Math.min(start.current.y, end.y), width: Math.abs(end.x - start.current.x) + 1, height: Math.abs(end.y - start.current.y) + 1 });
      }}
      onPointerUp={() => { start.current = null; }}
      onPointerCancel={() => { start.current = null; }}
      onLostPointerCapture={() => { start.current = null; }}
    >
      <img src={attachmentDownloadUrl(image.attachmentId)} alt="Screenshot to annotate; use the selection fields for keyboard control" draggable={false} className="block size-full select-none object-fill" onLoad={event => {
        const valid = event.currentTarget.naturalWidth === image.width && event.currentTarget.naturalHeight === image.height;
        setLoaded(valid); setFailed(!valid);
      }} onError={() => { setLoaded(false); setFailed(true); }} />
      <span aria-hidden className="pointer-events-none absolute border-2 border-primary bg-primary/10" style={{ left: `${region.x / image.width * 100}%`, top: `${region.y / image.height * 100}%`, width: `${region.width / image.width * 100}%`, height: `${region.height / image.height * 100}%` }} />
    </div>
    {failed && <p role="alert" className="text-sm text-destructive">The screenshot could not be decoded at its saved dimensions. Choose another image; this selection cannot be saved.</p>}
    <fieldset disabled={!loaded || failed} className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <legend className="sr-only">Selection in original image pixels</legend>
      {(["x", "y", "width", "height"] as const).map(key => <label key={key} className="space-y-1 text-sm">
        <span>{({ x: "Left", y: "Top", width: "Width", height: "Height" })[key]}</span>
        <Input type="number" inputMode="numeric" min={key === "x" || key === "y" ? 0 : 1} max={key === "x" ? image.width - 1 : key === "y" ? image.height - 1 : key === "width" ? image.width - region.x : image.height - region.y} value={region[key]} onChange={event => change(key, Number(event.target.value))} className="min-h-11 text-base sm:min-h-9" />
      </label>)}
    </fieldset>
  </div>;
}
