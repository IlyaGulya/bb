import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}

export async function beginCapture({ tab, page, directory, title, scenario, runId, applicationRevision, helperRevision, recorderVersion }) {
  if (![applicationRevision, helperRevision].every((revision) => /^[a-f0-9]{40}$/.test(revision))) throw new Error("Provide exact application and helper Git revisions");
  if (!recorderVersion) throw new Error("Provide the installed OMP version, not a guessed version");
  await fs.mkdir(directory);
  const original = path.resolve(directory, "original.mp4");
  const key = `__bbDemo_${randomUUID().replaceAll("-", "")}`;
  const frames = [];
  const changes = [];
  const holds = [];
  let recorderSession;
  let closed = false;
  let pendingChange;
  const createSession = page.createCDPSession;
  const createSessionDescriptor = Object.getOwnPropertyDescriptor(page, "createCDPSession");
  let clockError;
  const onFrame = (event) => {
    if (typeof event.metadata.timestamp !== "number") clockError = new Error("Recorder frame has no genuine CDP timestamp");
    else frames.push(event.metadata.timestamp * 1000);
  };
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await page.evaluate((id) => {
    const clicks = [];
    const listener = (event) => {
      if (event.isTrusted) clicks.push({ timestampMs: performance.timeOrigin + performance.now(), x: event.clientX, y: event.clientY, button: event.button, isTrusted: event.isTrusted });
    };
    window.addEventListener("mousedown", listener, true);
    window[id] = { clicks, cleanup: () => window.removeEventListener("mousedown", listener, true) };
  }, key);
  const startedAtBoundsMs = [Date.now()];
  const cleanup = async () => {
    try {
      recorderSession?.off("Page.screencastFrame", onFrame);
    } finally {
      await page.evaluate((id) => { window[id]?.cleanup(); delete window[id]; }, key);
    }
  };
  page.createCDPSession = async function (...args) {
    const session = await createSession.apply(this, args);
    if (recorderSession) throw new Error("Unexpected extra CDP session while starting recorder");
    recorderSession = session;
    session.on("Page.screencastFrame", onFrame);
    return session;
  };
  try {
    await tab.recordStart(original, { cursor: true, contactSheet: true, fps: 15, quality: 85 });
  } catch (error) {
    await cleanup();
    throw error;
  } finally {
    if (createSessionDescriptor) Object.defineProperty(page, "createCDPSession", createSessionDescriptor);
    else delete page.createCDPSession;
  }
  startedAtBoundsMs.push(Date.now());
  try {
    if (!recorderSession) throw new Error("This OMP recorder does not expose its CDP session through page.createCDPSession; do not guess its frame clock");
  } catch (error) {
    await tab.recordStop();
    await cleanup();
    throw error;
  }
  const snapshot = async (selector) => {
    if (closed) throw new Error("Capture is already closed");
    return await page.evaluate((selector) => {
      const element = document.querySelector(selector);
      const timestampMs = performance.timeOrigin + performance.now();
      if (!element) return { timestampMs, state: "absent", rect: null };
      const box = element.getBoundingClientRect();
      const state = JSON.stringify({ text: element.textContent, value: "value" in element ? element.value : null, checked: "checked" in element ? element.checked : null, expanded: element.getAttribute("aria-expanded"), visible: box.width > 0 && box.height > 0 && getComputedStyle(element).visibility === "visible" });
      return { timestampMs, state, rect: { x: box.x, y: box.y, width: box.width, height: box.height } };
    }, selector);
  };
  return {
    async ready() {
      if (closed) throw new Error("Capture is already closed");
      await new Promise((resolve, reject) => {
        if (frames.length) return resolve();
        const timeout = setTimeout(() => { recorderSession.off("Page.screencastFrame", ready); reject(new Error("No real recorder frame received after actual pointer movement")); }, 10000);
        const ready = () => { clearTimeout(timeout); recorderSession.off("Page.screencastFrame", ready); resolve(); };
        recorderSession.on("Page.screencastFrame", ready);
      });
    },
    snapshot,
    async change(caption, selector, before) {
      if (pendingChange) throw new Error("End the current cue after its readability hold before observing another change");
      const after = await snapshot(selector);
      if (after.state === before.state || !after.rect || after.rect.width <= 0 || after.rect.height <= 0 || JSON.parse(after.state).visible !== true) throw new Error("Expected a visible, actually changed element after a readiness assertion");
      pendingChange = { timestampMs: after.timestampMs, caption, selector, before, after };
    },
    async hold(milliseconds, reason) {
      if (closed || !Number.isFinite(milliseconds) || milliseconds < 500 || milliseconds > 20000 || !reason) throw new Error("Use explicit 0.5–20s readability holds only after real readiness");
      const fromTimestampMs = await page.evaluate(() => performance.timeOrigin + performance.now());
      await new Promise((resolve) => setTimeout(resolve, milliseconds));
      const toTimestampMs = await page.evaluate(() => performance.timeOrigin + performance.now());
      holds.push({ fromTimestampMs, toTimestampMs, reason });
    },
    async endChange() {
      if (!pendingChange) throw new Error("No current change cue");
      const current = await snapshot(pendingChange.selector);
      if (current.state !== pendingChange.after.state || JSON.stringify(current.rect) !== JSON.stringify(pendingChange.after.rect)) throw new Error("Accented element changed/moved during its hold; shorten the cue to a stable recorded interval");
      changes.push({ ...pendingChange, untilTimestampMs: current.timestampMs });
      pendingChange = undefined;
    },
    async finish() {
      if (closed || pendingChange) throw new Error("End change cues before finishing exactly once");
      const clicks = await page.evaluate((id) => {
        if (!window[id]) throw new Error("Page navigated; this adapter intentionally supports one document only");
        return window[id].clicks;
      }, key);
      const stoppedAtBoundsMs = [Date.now()];
      let result;
      try {
        result = await tab.recordStop();
      } finally {
        stoppedAtBoundsMs.push(Date.now());
        await cleanup();
      }
      closed = true;
      if (clockError) throw clockError;
      if (result.frames !== frames.length || frames.length === 0) throw new Error("Observed frame count differs from the existing recorder; timing is not trustworthy");
      const receipt = {
        version: 1,
        original: "original.mp4",
        originalSha256: await sha256(original),
        title,
        scenario,
        runId,
        applicationRevision,
        helperRevision,
        capture: {
          recorder: { name: "OMP browser.recordStart", version: recorderVersion, fps: 15, durationMs: result.durationMs, frames: result.frames, bytes: result.bytes, cursor: true },
          viewport,
          frameTimestampsMs: frames,
          startedAtBoundsMs,
          stoppedAtBoundsMs,
          timingToleranceMs: 1000 / 15 + 40,
          adapterSha256: await sha256(fileURLToPath(import.meta.url)),
        },
        clicks,
        changes,
        holds,
      };
      const receiptPath = path.resolve(directory, "capture.json");
      await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
      return { receiptPath, receipt, recorder: result };
    },
    async abort() {
      if (closed) return;
      try {
        if ((await tab.recording()).active) await tab.recordStop();
      } finally {
        await cleanup();
      }
      closed = true;
    },
  };
}
