# Readable, truthful UI demos

Use the existing OMP browser recorder and local FFmpeg. This is a worker-side
recipe, not a recorder, editor, encoding service, or task evidence schema.
The app is Operate mode: show the actual control, actual click and actual result.
Keep the whole viewport; put explanatory copy outside it. Never annotate an
unobserved success. Use safe owned data, not Work/corporate payloads.

## Get the resources on the execution machine

Tasks already ships its complete `skills` directory in the plugin package and
stages skill trees on workers. Resolve `scripts/capture-demo.mjs` and
`scripts/render-demo.mjs` relative to this skill's installed SKILL.md, not a
checkout path. No npm package, install, cloud account, or extra service is needed.
Prerequisites: the existing OMP Chromium/CDP recorder, Node (or Bun), and installed
FFmpeg/ffprobe with libx264 and libass. The capture adapter targets the inspected
OMP 18.13.3 CDP recorder contract, not Tern/cmux or a replacement frame source.
It fails rather than inventing timing when that contract differs.

From CLI, discover the actual Tasks skill ID, then fetch its resources:

```sh
bb skill list --json
bb skill files "$tasks_skill_id"
bb skill show "$tasks_skill_id" --path references/video-demo.md
bb skill show "$tasks_skill_id" --path scripts/capture-demo.mjs --json \
  | jq -rj '.content' > "$owned_resource_dir/capture-demo.mjs"
bb skill show "$tasks_skill_id" --path scripts/render-demo.mjs --json \
  | jq -rj '.content' > "$owned_resource_dir/render-demo.mjs"
```

Choose the entry with name `tasks`, scope `plugin`, and the Tasks plugin owner;
do not silently use a same-named user skill. `bb skill show` prints the resource
revision on stderr; retain the resource hashes in the run evidence. The SDK
uses the same path: `sdk.skills.list({projectId, environmentId})`,
`listFiles({projectId, environmentId, skillId})`, and
`getContent({projectId, environmentId, skillId, path})` on `sdk.skills`.
Write `result.content` to the worker's owned resource directory when necessary.
A release must include the updated Tasks skill tree; an old server cannot serve
new resources just because they exist in an author's private checkout.

## Capture a real scenario

Read OMP's installed browser documentation first. Open your own named tab, never
adopt another actor's page. Verify the target app revision independently. A
helper commit is not the app revision and a preview is not a deployment claim.
Keep the scenario in one document; SPA state changes are supported, document
navigation is not. Use a fresh, nonexistent owned capture directory.

In `tab.run`, dynamically import `beginCapture` from the installed resource's
absolute file URL. Pass the raw `page` and `tab` supplied by that run. The adapter
briefly observes the CDP session created by **the existing recorder**; it does
not start a second screencast, capture frames, replace ACKs, or draw a cursor.
OMP's `{cursor:true, contactSheet:true, fps:15, quality:85}` owns the visible
pointer and real mousedown ripples. The adapter restores `createCDPSession`
after starting, and checks that its observed frame count matches recordStop.

A safe example is opening an execution-context draft, entering a disposable name,
then dismissing it without Save. Observe the actual page before using selectors.
The following is the body of a `tab.run` function; supply `options` as a run arg
with `captureModuleUrl`, `directory`, `runId`, `applicationRevision`,
`helperRevision`, and the installed `recorderVersion`:

```js
const { beginCapture } = await import(options.captureModuleUrl);
const capture = await beginCapture({
  tab, page,
  directory: options.directory,
  title: "Unsaved draft; no settings saved",
  scenario: "execution-context-unsaved-name",
  runId: options.runId,
  applicationRevision: options.applicationRevision,
  helperRevision: options.helperRevision,
  recorderVersion: options.recorderVersion,
});
try {
  await tab.waitFor('role/button[name="New execution context" exact]');
  await page.mouse.move(720, 500, { steps: 20 });
  await capture.ready();
  await capture.hold(2000, "Read the ready settings page");
  const heading = 'form h2';
  const beforeOpen = await capture.snapshot(heading);
  await tab.click('role/button[name="New execution context" exact]');
  await tab.waitForSelector('input[placeholder="e.g. Work or Personal"]');
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations()
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => undefined)));
  });
  await capture.change("The new execution-context draft is open", heading, beforeOpen);
  await capture.hold(4000, "Read the actual unsaved editor");
  await capture.endChange();
  const name = 'input[placeholder="e.g. Work or Personal"]';
  const beforeName = await capture.snapshot(name);
  await tab.click(name);
  await tab.type(name, "Demo draft - not saved");
  await page.waitForFunction((selector) => document.querySelector(selector)?.value === "Demo draft - not saved", {}, name);
  await capture.change("Only the unsaved name has changed", name, beforeName);
  await capture.hold(4000, "Read the typed value without saving");
  await capture.endChange();
  await tab.press("Escape");
  await tab.waitForSelector(name, { hidden: true });
  await capture.hold(2000, "Confirm the editor is dismissed");
  return await capture.finish();
} catch (error) {
  await capture.abort();
  throw error;
}
```

Wait for actual application readiness, **then** use explicit readability holds.
A timeout is a failure deadline, not readiness. For slower pointer movement,
use actual `tab.mouseMove` with intermediate real points before clicking. Do not
postproduce fake pointer paths or click rings. The adapter saves only trusted
mousedown events (page epoch time, viewport coordinates, button), real CDP frame
timestamps, observed before/after element state and bounds, explicit hold times,
recordStop statistics, exact declared app/helper revisions, and SHA-256 of the
original and adapter. Captured text must itself be safe to retain.

A static page may send no CDP screencast frames until an actual visual update.
Move the real pointer after starting, then call `ready()` before taking snapshots
or readability holds. Do not insert artificial animation or a second recorder.
The example uses the center of a 1440×1000 owned viewport; adapt the real action
to your viewport and check that original pixel dimensions match CSS coordinates.

Call `snapshot(selector)` before the action, wait for the actual new state, then
`change(caption, selector, before)`. The after-element must be visible, changed,
and within the viewport. Keep its state/bounds stable through `endChange()`;
use a smaller element rather than a moving panel. Each cue needs at least 500ms.
End the cue before another action. `hold(ms, reason)` supports 500–20000ms and
records the real wait; it inserts no frames. `abort()` finalizes the existing
recorder and removes event instrumentation after a failed scenario. Close only
your own tab in a finally block after inspecting the result.

## Render locally, or call programmatically

```sh
node "$resource_dir/render-demo.mjs" "$capture_dir/capture.json" "$new_output_dir"
```

Equivalent: `await renderDemo(captureJsonPath, newOutputDirectory)` from
`render-demo.mjs`. The JSON input is the adapter's version-1 receipt. It contains
`original`, `originalSha256`, `title` (up to 64 printable characters), `scenario`,
`runId`, full 40-character `applicationRevision` and `helperRevision`, `capture`,
`clicks`, `changes`, and `holds`. See the adapter for the exact producer shape.
No ignored options: unsupported fields, synthetic clicks, missing clocks,
unchanged/out-of-bounds regions, overlapping cues and out-of-duration events
are rejected. Labels are plain text (no ASS braces/backslashes or control codes).
Use short captions, up to 80 characters, with one or two lines at a normal desktop
viewport. Inspect actual text rendering before delivery.

The new output directory must not exist. Neither input nor existing outputs are
overwritten, including failed partial output directories. Choose a new directory
for a retry. The helper copies the exact original, burns short captions in an
added 144px band and a 2px amber outline on the measured changed region, then
writes H.264/yuv420p MP4 with faststart. The band says `Demo annotation · 1× uncut`;
it is not app UI. No cuts, speedups, inserted pauses, zooms or synthetic outcomes.
Original audio, if present, is preserved through AAC encoding.

The bundle contains:

- `original.mp4`: unchanged original bytes, independently hash-checked again.
- `capture.json`: exact input receipt bytes, including real event/frame clocks.
- `render-input.json`: same receipt with bundle-relative media paths for replay.
- `captions.ass`, `filters.txt`: inspectable FFmpeg edit instructions.
- `demo.mp4`: final playable video; optional `voiceover.audio` retains supplied audio.
- `manifest.json`: original/final sizes and SHA-256 hashes, source/helper revisions,
  run/scenario, adapter/renderer hashes, FFmpeg version and invocation, duration,
  click/cue media times, rectangles, all recorded holds and explicit empty cut list.

The recorder starts media time at its **first CDP frame**, not at recordStart's
return. The adapter passively retains that genuine timestamp. Event time minus
that origin maps into the original video. OMP's JPEG concat timebase is 25Hz before
conversion to 15fps, so the manifest reports a conservative `40ms + 1/fps`
timing tolerance (about 107ms at 15fps), not false millisecond precision. No clock
or duration mismatch is silently clamped. Inspect adjacent frames around a click
and cue boundary; record the observed synchronization against this tolerance.
The adapter receipt is trusted local run evidence, **not cryptographic proof**
that an arbitrary supplied JSON file describes real actions. Do not fabricate it.

To replay from the portable bundle, use the matching shipped renderer:

```sh
node "$resource_dir/render-demo.mjs" "$bundle/render-input.json" "$new_output_dir"
```

## Optional local voiceover

No audio is generated or uploaded by default. Use an already-installed local
`espeak-ng`, `espeak`, macOS `say`, or owner-provided audio only with explicit
approval for the safe narration. Do not install TTS, send video/text to vendors,
or speak private/work payloads. With an approved local WAV already generated,
add this optional field to a **new** receipt file; leave the original receipt:

```json
{"voiceover":{"path":"narration.wav","startMs":2500,"approval":"local-approved","description":"Approved local narration of the disposable draft"}}
```

The field is an addition to the full receipt, not a replacement for it. The
renderer retains/hashes the audio, delays it by the explicit media offset, pads
silence and ends at the unchanged video duration. It rejects audio overruns and
refuses to replace existing source audio. FFmpeg inputs are restricted to local
file/pipe protocols. Align speech to observed cue times; never imply success
before the actual frame. Local voices may have poor language/voice quality and
must be listened to. If no local voice is installed, deliver complete silent
cursor/click/change/caption evidence and state that optional narration was not
produced; absence of narration is not a video blocker.

## Inspect and attach through existing Tasks attachments

The renderer runs a full decode and verifies original hashes/duration. This does
not certify visual quality. Inspect original and final frames at the actual
clicks and cue starts/midpoints; verify a visible cursor/ripple, correct change
region, readable unobscured captions and genuine state. Use ffprobe for codec,
size and duration, and play the MP4 in your owned browser tab. Retain notes.
Never call the recorder's contact sheet alone proof of the finished feature.

When authorized to attach to the private owned task, use the existing path:

```sh
bb tasks attachment add ABC-12 --file "$bundle/demo.mp4"
bb tasks attachment add ABC-12 --file "$bundle/original.mp4"
bb tasks attachment add ABC-12 --file "$bundle/manifest.json"
bb tasks attachment add ABC-12 --file "$bundle/capture.json"
```

Keep the complete portable bundle available and include its renderer/resource
hashes and exact replay command in the task evidence. Verify original and final
attachments are downloadable/playable using existing task access, not a public
video host. If a controller owns attachment/publication approval, hand over the
paths/hashes; do not acquire auth or upload around that boundary. This recipe
changes neither Task video evidence schemas nor the task popup/viewer contract.

Analytics integration belongs to the central analytics capability, not this
script: the parent may publish only product metadata such as run/scenario key,
app/helper revision, duration, output bytes, narration presence and result.
No telemetry transport, event table, automatic analytics write, transcript,
captured state, coordinates, filename/private URL or media content is emitted
here. Wire the released central API/CLI before final release; do not invent a
parallel analytics channel.
