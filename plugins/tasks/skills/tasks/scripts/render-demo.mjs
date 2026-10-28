import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ownPath = fileURLToPath(import.meta.url);
const shaPattern = /^[a-f0-9]{40}$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function object(value, keys, label) {
  requireValue(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  requireValue(Object.keys(value).every((key) => keys.includes(key)), `${label} has unsupported fields`);
}

function text(value, label, max = 120) {
  requireValue(typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value), `${label} must be printable text (1-${max} characters)`);
}

function number(value, min, max, label) {
  requireValue(Number.isFinite(value) && value >= min && value <= max, `${label} must be in ${min}..${max}`);
}

export async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}

export async function run(binary, args, cwd) {
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-24000); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`${binary} exited ${code}: ${stderr}`)));
  });
}

async function probe(file) {
  return JSON.parse(await run("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_streams", "-show_format", "-of", "json", file]));
}

export function mediaTime(timestampMs, capture, durationMs) {
  number(timestampMs, capture.frameTimestampsMs[0], capture.frameTimestampsMs[0] + capture.recorder.durationMs, "event timestamp");
  const relative = timestampMs - capture.frameTimestampsMs[0];
  requireValue(relative <= durationMs, "Event falls outside original media duration");
  return relative;
}

export function validateCapture(input, video) {
  object(input, ["version", "original", "originalSha256", "title", "scenario", "runId", "applicationRevision", "helperRevision", "capture", "clicks", "changes", "holds", "voiceover"], "input");
  requireValue(input.version === 1, "Unsupported capture version");
  for (const key of ["original", "scenario", "runId", "title"]) text(input[key], key, key === "original" ? 4096 : 160);
  text(input.title, "title", 64);
  requireValue(/^[a-f0-9]{64}$/.test(input.originalSha256), "originalSha256 is required");
  for (const key of ["applicationRevision", "helperRevision"]) requireValue(shaPattern.test(input[key]), `${key} must be a full Git SHA`);
  const capture = input.capture;
  object(capture, ["recorder", "viewport", "frameTimestampsMs", "startedAtBoundsMs", "stoppedAtBoundsMs", "timingToleranceMs", "adapterSha256"], "capture");
  object(capture.recorder, ["name", "version", "fps", "durationMs", "frames", "bytes", "cursor"], "recorder");
  text(capture.recorder.name, "recorder name");
  text(capture.recorder.version, "recorder version");
  requireValue(capture.recorder.cursor === true, "The original must contain the recorder's real cursor/click overlay");
  number(capture.recorder.fps, 1, 60, "fps");
  number(capture.recorder.durationMs, 1, 3600000, "recording duration");
  requireValue(/^[a-f0-9]{64}$/.test(capture.adapterSha256), "Capture adapter hash is required");
  object(capture.viewport, ["width", "height"], "viewport");
  const { width, height } = capture.viewport;
  requireValue(Number.isInteger(width) && Number.isInteger(height) && width === video.width && height === video.height, "Viewport must match the original video pixel dimensions; no implicit coordinate scaling");
  const timestamps = capture.frameTimestampsMs;
  requireValue(Array.isArray(timestamps) && timestamps.length > 0 && timestamps.length === capture.recorder.frames, "Missing actual recorder frame timestamps");
  let previous = 0;
  for (const timestamp of timestamps) {
    number(timestamp, previous, Number.MAX_SAFE_INTEGER, "frame timestamp");
    previous = timestamp;
  }
  for (const key of ["startedAtBoundsMs", "stoppedAtBoundsMs"]) {
    requireValue(Array.isArray(capture[key]) && capture[key].length === 2, `${key} requires two timestamps`);
    number(capture[key][0], 0, capture[key][1], key);
    number(capture[key][1], capture[key][0], Number.MAX_SAFE_INTEGER, key);
  }
  requireValue(timestamps[0] >= capture.startedAtBoundsMs[0] && timestamps.at(-1) <= capture.stoppedAtBoundsMs[1], "Frame and adapter clocks do not agree");
  const tolerance = 1000 / capture.recorder.fps + 40;
  requireValue(capture.timingToleranceMs === tolerance, "Invalid recorder concat/CFR timing tolerance");
  requireValue(Math.abs(video.durationMs - capture.recorder.durationMs) <= tolerance + 1000 / capture.recorder.fps, "Original duration does not match recorder result");
  requireValue(Array.isArray(input.clicks) && input.clicks.length > 0, "At least one real trusted click is required");
  for (const click of input.clicks) {
    object(click, ["timestampMs", "x", "y", "button", "isTrusted"], "click");
    requireValue(click.isTrusted === true, "Synthetic clicks are not evidence");
    number(click.x, 0, width - 1, "click x");
    number(click.y, 0, height - 1, "click y");
    number(click.button, 0, 2, "click button");
    mediaTime(click.timestampMs, capture, video.durationMs);
  }
  requireValue(Array.isArray(input.changes) && input.changes.length > 0, "At least one observed change is required");
  for (const change of input.changes) {
    object(change, ["timestampMs", "untilTimestampMs", "caption", "selector", "before", "after"], "change");
    text(change.caption, "caption", 80);
    text(change.selector, "selector", 1000);
    const start = mediaTime(change.timestampMs, capture, video.durationMs);
    const end = mediaTime(change.untilTimestampMs, capture, video.durationMs);
    requireValue(end - start >= 500, "Change cues need at least 500ms of actual readable recorded state");
    for (const state of [change.before, change.after]) {
      object(state, ["timestampMs", "state", "rect"], "observed state");
      requireValue(typeof state.state === "string", "State must be observed serialized data");
      number(state.timestampMs, timestamps[0], change.timestampMs, "state timestamp");
    }
    requireValue(change.after.timestampMs === change.timestampMs && change.before.timestampMs <= change.after.timestampMs, "Change time must be its actual observation time");
    requireValue(change.before.state !== change.after.state, "Cannot accent an unchanged state");
    const afterState = JSON.parse(change.after.state);
    object(afterState, ["text", "value", "checked", "expanded", "visible"], "change after-state");
    requireValue(afterState.visible === true, "Change after-state must be observed visible");
    const rect = change.after.rect;
    object(rect, ["x", "y", "width", "height"], "change rectangle");
    for (const key of ["x", "y"]) number(rect[key], 0, key === "x" ? width : height, `region ${key}`);
    number(rect.width, 1, width - rect.x, "region width");
    number(rect.height, 1, height - rect.y, "region height");
    requireValue(input.clicks.some((click) => click.timestampMs <= change.timestampMs), "A change must follow a recorded click");
  }
  const ordered = [...input.changes].sort((a, b) => a.timestampMs - b.timestampMs);
  for (let i = 1; i < ordered.length; i++) requireValue(ordered[i - 1].untilTimestampMs <= ordered[i].timestampMs, "Caption/change intervals must not overlap");
  requireValue(Array.isArray(input.holds), "holds must be explicit, including an empty list");
  for (const hold of input.holds) {
    object(hold, ["fromTimestampMs", "toTimestampMs", "reason"], "hold");
    text(hold.reason, "hold reason");
    requireValue(mediaTime(hold.toTimestampMs, capture, video.durationMs) >= mediaTime(hold.fromTimestampMs, capture, video.durationMs), "Invalid hold interval");
  }
  return ordered;
}

function assTime(ms) {
  const cs = Math.round(ms / 10);
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

function assText(value) {
  requireValue(!/[{}\\]/u.test(value), "Caption/title ASS control characters are not allowed");
  return value;
}

export async function renderDemo(inputPath, outputDirectory) {
  const inputBytes = await fs.readFile(inputPath);
  const input = JSON.parse(inputBytes.toString("utf8"));
  requireValue(typeof input.original === "string", "original path is required");
  const original = path.resolve(path.dirname(inputPath), input.original);
  requireValue(path.extname(original).toLowerCase() === ".mp4", "Use an original MP4 from the existing recorder");
  const beforeHash = await hashFile(original);
  requireValue(beforeHash === input.originalSha256, "Original hash does not match capture receipt");
  const originalProbe = await probe(original);
  const videos = originalProbe.streams.filter((stream) => stream.codec_type === "video");
  requireValue(videos.length === 1, "Original must have exactly one video stream");
  const video = { width: videos[0].width, height: videos[0].height, durationMs: Number(videos[0].duration) * 1000 };
  number(video.durationMs, 1, 3600000, "media duration");
  const changes = validateCapture(input, video);
  assText(input.title);
  const band = 144;
  const fontSize = Math.max(20, Math.min(32, Math.floor(video.width / 44)));
  const captionLines = changes.map((change) => `Dialogue: 0,${assTime(mediaTime(change.timestampMs, input.capture, video.durationMs))},${assTime(mediaTime(change.untilTimestampMs, input.capture, video.durationMs))},Caption,,0,0,0,,${assText(change.caption)}`);
  const subtitles = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${video.width}\nPlayResY: ${video.height + band}\nWrapStyle: 0\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Caption,DejaVu Sans,${fontSize},&H00F7F3E8,&H00F7F3E8,&H0035291F,&H0035291F,0,0,0,0,100,100,0,0,1,0,0,2,28,28,22,1\nStyle: Title,DejaVu Sans,${Math.round(fontSize * 0.7)},&H00E8D9C2,&H00E8D9C2,&H0035291F,&H0035291F,0,0,0,0,100,100,0,0,1,0,0,2,28,28,102,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,${assTime(video.durationMs)},Title,,0,0,0,,Demo annotation · 1× uncut · ${input.title}\n${captionLines.join("\n")}\n`;
  const filters = [`pad=iw:ih+${band}:0:0:color=0x1f2935`];
  for (const change of changes) {
    const rect = change.after.rect;
    const start = mediaTime(change.timestampMs, input.capture, video.durationMs) / 1000;
    const end = mediaTime(change.untilTimestampMs, input.capture, video.durationMs) / 1000;
    filters.push(`drawbox=x=${rect.x}:y=${rect.y}:w=${rect.width}:h=${rect.height}:color=0xf2bf66:t=2:enable='gte(t,${start})*lt(t,${end})'`);
  }
  filters.push("ass=captions.ass");
  let voice = null;
  if (input.voiceover !== undefined) {
    object(input.voiceover, ["path", "startMs", "approval", "description"], "voiceover");
    requireValue(input.voiceover.approval === "local-approved", "Voiceover needs explicit local approval");
    text(input.voiceover.path, "voiceover path", 4096);
    text(input.voiceover.description, "voiceover description", 160);
    number(input.voiceover.startMs, 0, video.durationMs, "voiceover start");
    requireValue(!originalProbe.streams.some((stream) => stream.codec_type === "audio"), "Do not silently replace original audio with narration");
    const source = path.resolve(path.dirname(inputPath), input.voiceover.path);
    const voiceProbe = await probe(source);
    requireValue(voiceProbe.streams.some((stream) => stream.codec_type === "audio"), "Voiceover has no audio stream");
    const durationMs = Number(voiceProbe.format.duration) * 1000;
    number(durationMs, 1, video.durationMs - input.voiceover.startMs, "voiceover duration (no truncation)");
    voice = { source, sha256: await hashFile(source), durationMs, startMs: input.voiceover.startMs, description: input.voiceover.description };
  }
  await fs.mkdir(outputDirectory);
  const out = path.resolve(outputDirectory);
  await fs.copyFile(original, path.join(out, "original.mp4"), 1);
  await fs.writeFile(path.join(out, "capture.json"), inputBytes, { flag: "wx" });
  const portableInput = { ...input, original: "original.mp4", ...(voice ? { voiceover: { ...input.voiceover, path: "voiceover.audio" } } : {}) };
  await fs.writeFile(path.join(out, "render-input.json"), `${JSON.stringify(portableInput, null, 2)}\n`, { flag: "wx" });
  await fs.writeFile(path.join(out, "captions.ass"), subtitles, { flag: "wx" });
  await fs.writeFile(path.join(out, "filters.txt"), filters.join(","), { flag: "wx" });
  const args = ["-nostdin", "-v", "error", "-n", "-protocol_whitelist", "file,pipe", "-i", "original.mp4"];
  if (voice) {
    await fs.copyFile(voice.source, path.join(out, "voiceover.audio"), 1);
    args.push("-protocol_whitelist", "file,pipe", "-i", "voiceover.audio");
  }
  args.push("-filter_script:v", "filters.txt", "-map", "0:v:0");
  if (voice) args.push("-map", "1:a:0", "-af", `adelay=${Math.round(voice.startMs)}:all=1,apad,atrim=duration=${video.durationMs / 1000}`);
  else args.push("-map", "0:a?");
  args.push("-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", "demo.mp4");
  await run("ffmpeg", args, out);
  await run("ffmpeg", ["-nostdin", "-v", "error", "-i", "demo.mp4", "-f", "null", "-"], out);
  requireValue(await hashFile(original) === beforeHash && await hashFile(path.join(out, "original.mp4")) === beforeHash, "Original changed during processing");
  if (voice) requireValue(await hashFile(voice.source) === voice.sha256 && await hashFile(path.join(out, "voiceover.audio")) === voice.sha256, "Voiceover changed during processing");
  const resultProbe = await probe(path.join(out, "demo.mp4"));
  const resultVideo = resultProbe.streams.find((stream) => stream.codec_type === "video");
  requireValue(Math.abs(Number(resultVideo.duration) * 1000 - video.durationMs) <= input.capture.timingToleranceMs, "Postprocessing changed video duration");
  const artifact = async (name) => ({ path: name, sha256: await hashFile(path.join(out, name)), bytes: (await fs.stat(path.join(out, name))).size });
  const manifest = {
    version: 1,
    scenario: input.scenario,
    runId: input.runId,
    applicationRevision: input.applicationRevision,
    helperRevision: input.helperRevision,
    rendererSha256: await hashFile(ownPath),
    adapterSha256: input.capture.adapterSha256,
    createdAt: new Date().toISOString(),
    edits: { playbackRate: 1, cuts: [], insertedHolds: [], recordedReadabilityHolds: input.holds, captionBandPixels: band, changeAccents: "2px outline of observed changed element; no simulated clicks or states" },
    timing: { originTimestampMs: input.capture.frameTimestampsMs[0], method: "OMP CDP timestamps relative to first recorded frame; concat 25Hz quantization then CFR", toleranceMs: input.capture.timingToleranceMs, changes: changes.map((change) => ({ caption: change.caption, startMs: mediaTime(change.timestampMs, input.capture, video.durationMs), endMs: mediaTime(change.untilTimestampMs, input.capture, video.durationMs), rect: change.after.rect })), clicks: input.clicks.map((click) => ({ ...click, mediaMs: mediaTime(click.timestampMs, input.capture, video.durationMs) })) },
    artifacts: await Promise.all(["original.mp4", "capture.json", "render-input.json", "captions.ass", "filters.txt", "demo.mp4", ...(voice ? ["voiceover.audio"] : [])].map(artifact)),
    voiceover: voice ? { ...voice, source: undefined, approval: "local-approved" } : null,
    originalVideo: video,
    outputVideo: { codec: resultVideo.codec_name, pixelFormat: resultVideo.pix_fmt, width: resultVideo.width, height: resultVideo.height, durationMs: Number(resultVideo.duration) * 1000 },
    ffmpeg: (await run("ffmpeg", ["-version"])).split("\n")[0],
    reproduction: { command: "node render-demo.mjs render-input.json NEW_OUTPUT_DIRECTORY", ffmpegArgs: args, cwd: "output directory" },
    verification: { originalHashPreserved: true, fullDecode: true, visualInspection: "Required separately: inspect original/final frames at click and change moments" },
  };
  await fs.writeFile(path.join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === ownPath) {
  if (process.argv.length !== 4) {
    console.error("Usage: node render-demo.mjs CAPTURE_JSON NEW_OUTPUT_DIRECTORY");
    process.exitCode = 1;
  } else {
    renderDemo(path.resolve(process.argv[2]), path.resolve(process.argv[3])).then((manifest) => console.log(JSON.stringify(manifest, null, 2))).catch((error) => { console.error(error.message); process.exitCode = 1; });
  }
}
