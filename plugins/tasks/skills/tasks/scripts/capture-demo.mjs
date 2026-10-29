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

export async function observeTarget(selector, id) {
  const capture = window[id];
  if (!capture || !capture.safeSelectors.includes(selector)) throw new Error("Observation target must be explicitly approved as nonsecret");
  const timestampMs = performance.timeOrigin + performance.now();
  const element = document.querySelector(selector);
  if (!element) return { timestampMs, state: { present: false, visible: false, digest: null }, rect: null };
  if (!(element instanceof HTMLElement)) throw new Error("Only approved HTML controls or leaf text can be observed");
  const autocomplete = (element.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/u);
  const style = getComputedStyle(element);
  const masking = style.getPropertyValue("-webkit-text-security");
  if (autocomplete.some((token) => ["current-password", "new-password", "one-time-code", "cc-number", "cc-csc"].includes(token)) || (masking && masking !== "none")) throw new Error("Protected or masked fields cannot be observed");
  let content;
  if (element instanceof HTMLInputElement) {
    if (!["text", "search", "number", "range", "checkbox", "radio", "button", "submit", "reset"].includes(element.type)) throw new Error("Protected or unsupported input fields cannot be observed");
    content = [element.type, ["checkbox", "radio"].includes(element.type) ? element.checked : element.value];
  } else if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    content = [element.tagName, element.value];
  } else {
    if (element.childElementCount !== 0 || typeof element.innerText !== "string") throw new Error("Observe an approved leaf text element, never arbitrary container text");
    content = [element.tagName, element.innerText];
  }
  const box = element.getBoundingClientRect();
  const visible = box.width > 0 && box.height > 0 && style.visibility === "visible";
  const payload = new TextEncoder().encode(JSON.stringify([content, element.getAttribute("aria-expanded")]));
  const signature = await crypto.subtle.sign("HMAC", capture.observationKey, payload);
  const digest = Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { timestampMs, state: { present: true, visible, digest }, rect: { x: box.x, y: box.y, width: box.width, height: box.height } };
}

function requireEvalOwnership(ownership) {
  if (!ownership || typeof ownership !== "object" || Array.isArray(ownership) || ownership.version !== 1 || ownership.lifetime !== "eval" || ownership.created !== true || ownership.ownsPage !== true || ["ownerGeneration", "leaseId", "targetId"].some((key) => typeof ownership[key] !== "string" || ownership[key].trim().length === 0)) throw new Error("Capture requires the native Eval-owned new-page receipt; session lifetime is not a fallback");
}

export async function captureDemo({ browser, url, viewport, options, scenario, timeout = 90 }) {
  if (typeof browser?.capabilities !== "function") throw new Error("Capture requires native browser.capabilities() and Eval lifetime protocol v1; older SDKs are not supported");
  const capabilities = await browser.capabilities();
  if (capabilities?.version !== 1 || capabilities.evalLifetime?.supported !== true || capabilities.evalLifetime.receiptVersion !== 1) throw new Error("Native Eval browser lifetime protocol v1 is unavailable; session lifetime is not a fallback");
  const ownedTab = await browser.open({ name: `bb-demo-${randomUUID()}`, url, viewport, lifetime: "eval" });
  try {
    const ownership = ownedTab.ownership;
    requireEvalOwnership(ownership);
    await ownedTab.emulate({ viewport: { width: viewport.width, height: viewport.height, scale: 1 } });
    return await ownedTab.run(async ({ tab, page }, moduleUrl, options, scenario, ownership) => {
      const { beginCapture } = await import(moduleUrl);
      const capture = await beginCapture({ ...options, tab, page, ownership });
      try {
        await scenario({ tab, page, capture });
        return await capture.finish();
      } catch (error) {
        await capture.abort();
        throw error;
      }
    }, { args: [import.meta.url, options, scenario, ownership], timeout });
  } finally {
    await ownedTab.close();
  }
}

export async function beginCapture({ tab, page, ownership, directory, title, scenario, runId, applicationRevision, helperRevision, recorderVersion, recorderSourceRevision, safeSelectors }) {
  requireEvalOwnership(ownership);
  if (![applicationRevision, helperRevision, recorderSourceRevision].every((revision) => /^[a-f0-9]{40}$/.test(revision))) throw new Error("Provide exact application, helper, and native recorder Git revisions");
  if (!recorderVersion) throw new Error("Provide the installed OMP version, not a guessed version");
  if (!Array.isArray(safeSelectors) || safeSelectors.length === 0 || safeSelectors.some((selector) => typeof selector !== "string" || selector.trim().length === 0) || new Set(safeSelectors).size !== safeSelectors.length) throw new Error("Declare unique nonsecret observation selectors explicitly");
  const approvedSelectors = [...safeSelectors];
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
  await page.evaluate(async (id, safeSelectors) => {
    if (!crypto.subtle) throw new Error("Digest-only observation requires a secure Web Crypto context");
    const observationKey = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const clicks = [];
    const listener = (event) => {
      if (event.isTrusted) clicks.push({ timestampMs: performance.timeOrigin + performance.now(), x: event.clientX, y: event.clientY, button: event.button, isTrusted: event.isTrusted });
    };
    window.addEventListener("mousedown", listener, true);
    window[id] = { clicks, safeSelectors, observationKey, cleanup: () => window.removeEventListener("mousedown", listener, true) };
  }, key, approvedSelectors);
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
    return await page.evaluate(observeTarget, selector, key);
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
      if (JSON.stringify(after.state) === JSON.stringify(before.state) || !after.rect || after.rect.width <= 0 || after.rect.height <= 0 || after.state.visible !== true) throw new Error("Expected a visible, actually changed element after a readiness assertion");
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
      if (JSON.stringify(current.state) !== JSON.stringify(pendingChange.after.state) || JSON.stringify(current.rect) !== JSON.stringify(pendingChange.after.rect)) throw new Error("Accented element changed/moved during its hold; shorten the cue to a stable recorded interval");
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
        version: 3,
        original: "original.mp4",
        originalSha256: await sha256(original),
        title,
        scenario,
        runId,
        applicationRevision,
        helperRevision,
        safeSelectors: approvedSelectors,
        capture: {
          recorder: { name: "OMP browser.recordStart", version: recorderVersion, sourceRevision: recorderSourceRevision, fps: 15, durationMs: result.durationMs, frames: result.frames, bytes: result.bytes, cursor: true },
          ownership,
          viewport,
          frameTimestampsMs: frames,
          startedAtBoundsMs,
          stoppedAtBoundsMs,
          timingToleranceMs: 1000 / 15 + 40,
          adapterSha256: await sha256(fileURLToPath(import.meta.url)),
          observation: "ephemeral-hmac-sha256",
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
