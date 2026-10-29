import { describe, expect, it } from "vitest";
import { mediaTime, validateCapture } from "./skills/tasks/scripts/render-demo.mjs";

const video = { width: 1440, height: 1000, durationMs: 10000 };

function receipt() {
  return {
    version: 3,
    original: "original.mp4",
    originalSha256: "a".repeat(64),
    title: "Unsaved draft",
    scenario: "disposable-draft",
    runId: "local-run",
    applicationRevision: "b".repeat(40),
    helperRevision: "c".repeat(40),
    safeSelectors: ["input"],
    capture: {
      recorder: { name: "OMP browser.recordStart", version: "test-native-sdk", sourceRevision: "1".repeat(40), fps: 15, durationMs: 10000, frames: 3, bytes: 1024, cursor: true },
      ownership: { version: 1, lifetime: "eval", ownerGeneration: "test-eval-generation", leaseId: "test-native-lease", targetId: "test-owned-target", created: true, ownsPage: true },
      viewport: { width: 1440, height: 1000 },
      frameTimestampsMs: [1000, 4000, 9000],
      startedAtBoundsMs: [990, 1010],
      stoppedAtBoundsMs: [11000, 11100],
      timingToleranceMs: 1000 / 15 + 40,
      adapterSha256: "d".repeat(64),
      observation: "ephemeral-hmac-sha256",
    },
    clicks: [{ timestampMs: 3000, x: 300, y: 200, button: 0, isTrusted: true }],
    changes: [{ timestampMs: 4000, untilTimestampMs: 7000, caption: "The unsaved name changed", selector: "input", before: { timestampMs: 2000, state: { present: true, visible: true, digest: "e".repeat(64) }, rect: { x: 40, y: 220.796875, width: 428, height: 50 } }, after: { timestampMs: 4000, state: { present: true, visible: true, digest: "f".repeat(64) }, rect: { x: 40, y: 220.796875, width: 428, height: 50 } } }],
    holds: [{ fromTimestampMs: 4000, toTimestampMs: 7000, reason: "Read the actual value" }],
  };
}

describe("local video demo cue boundaries", () => {
  it("orders disjoint observed changes without altering input and accepts exact viewport edges", () => {
    const input = receipt();
    const later = structuredClone(input.changes[0]);
    later.timestampMs = 8000;
    later.untilTimestampMs = 10000;
    later.before.timestampMs = 7500;
    later.after.timestampMs = 8000;
    later.caption = "A later observed change";
    later.after.rect = { x: 1400, y: 960, width: 40, height: 40 };
    input.changes.unshift(later);
    const before = structuredClone(input);
    expect(validateCapture(input, video).map((change) => change.caption)).toEqual([
      "The unsaved name changed",
      "A later observed change",
    ]);
    expect(input).toEqual(before);
  });

  it.each([
    [1000, 0],
    [4500, 3500],
    [11000, 10000],
  ])("maps a genuine clock timestamp %s relative to the first frame", (timestamp, expected) => {
    expect(mediaTime(timestamp, receipt().capture, video.durationMs)).toBe(expected);
  });

  it.each([999, 11001, Number.NaN])("rejects outside-media timestamp %s instead of silently clamping it", (timestamp) => {
    expect(() => mediaTime(timestamp, receipt().capture, video.durationMs)).toThrow();
  });

  it.each([false, undefined, "true"])("rejects positive-size changed elements without observed visibility: %s", (visible) => {
    const input = receipt();
    input.changes[0].after.state.visible = visible;
    const before = structuredClone(input);
    expect(() => validateCapture(input, video)).toThrow();
    expect(input).toEqual(before);
  });

  it.each([
    ["legacy raw-content receipt", (input) => { input.version = 1; }],
    ["legacy session-lifetime receipt", (input) => { input.version = 2; }],
    ["missing native ownership receipt", (input) => { delete input.capture.ownership; }],
    ["unsupported native ownership protocol", (input) => { input.capture.ownership.version = 2; }],
    ["session-owned page", (input) => { input.capture.ownership.lifetime = "session"; }],
    ["borrowed native page", (input) => { input.capture.ownership.ownsPage = false; }],
    ["reused native page", (input) => { input.capture.ownership.created = false; }],
    ["missing Eval owner generation", (input) => { input.capture.ownership.ownerGeneration = ""; }],
    ["missing native lease identity", (input) => { delete input.capture.ownership.leaseId; }],
    ["missing native target identity", (input) => { input.capture.ownership.targetId = ""; }],
    ["unverified native source revision", (input) => { input.capture.recorder.sourceRevision = "main"; }],
    ["unapproved observation", (input) => { input.safeSelectors = ["other"]; }],
    ["missing digest", (input) => { input.changes[0].after.state.digest = null; }],
    ["raw before value", (input) => { input.changes[0].before.state.value = "FAKE_NONSECRET_RAW_VALUE"; }],
    ["raw after text", (input) => { input.changes[0].after.state.text = "FAKE_NONSECRET_RAW_TEXT"; }],
    ["raw rectangle payload", (input) => { input.changes[0].before.rect.value = "FAKE_NONSECRET_RAW_VALUE"; }],
    ["stringified raw observation", (input) => { input.changes[0].after.state = JSON.stringify({ value: "FAKE_NONSECRET_RAW_VALUE", visible: true }); }],
    ["content in absent observation", (input) => { input.changes[0].before.state.present = false; }],
    ["negative region", (input) => { input.changes[0].after.rect.x = -1; }],
    ["region beyond viewport", (input) => { input.changes[0].after.rect.width = 1440; }],
    ["zero region", (input) => { input.changes[0].after.rect.height = 0; }],
    ["synthetic click", (input) => { input.clicks[0].isTrusted = false; }],
    ["unchanged state", (input) => { input.changes[0].before.state = input.changes[0].after.state; }],
    ["postdated observation", (input) => { input.changes[0].after.timestampMs += 1; }],
    ["cue beyond original", (input) => { input.changes[0].untilTimestampMs = 11001; }],
    ["overlapping cues", (input) => { input.changes.push(structuredClone(input.changes[0])); }],
    ["mismatched clocks", (input) => { input.capture.frameTimestampsMs[0] = 0; }],
    ["lost frames", (input) => { input.capture.frameTimestampsMs.pop(); }],
    ["backwards clock", (input) => { input.capture.frameTimestampsMs[1] = 9500; }],
    ["invented precision", (input) => { input.capture.timingToleranceMs = 0; }],
    ["ignored edit option", (input) => { input.speed = 2; }],
    ["unknown app revision", (input) => { input.applicationRevision = "main"; }],
    ["unobserved cursor", (input) => { input.capture.recorder.cursor = false; }],
  ])("rejects %s without mutating capture input", (_name, mutate) => {
    const input = receipt();
    mutate(input);
    const before = structuredClone(input);
    expect(() => validateCapture(input, video)).toThrow();
    expect(input).toEqual(before);
  });

  it("rejects scaled media coordinates and duration changes", () => {
    expect(() => validateCapture(receipt(), { ...video, width: 720 })).toThrow();
    expect(() => validateCapture(receipt(), { ...video, durationMs: 5000 })).toThrow();
  });
});
