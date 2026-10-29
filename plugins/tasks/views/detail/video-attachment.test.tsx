// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoAttachment } from "./video-attachment.js";

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("probably");
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { configurable: true, value: true });
  });
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, "readyState", { configurable: true, value: 0 });
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const attachment = { id: "owned-video-fixture", fileName: "demo.mp4", mime: "video/mp4", sizeBytes: 4096 };
function fixture() {
  return renderSlot({ component: () => <main aria-label="Existing task"><p>Task result stays here</p><VideoAttachment attachment={attachment} /></main> }, {}, { pluginId: "tasks" });
}

function media(slot: ReturnType<typeof fixture>): HTMLVideoElement {
  const element = slot.getByLabelText("Video: demo.mp4");
  if (!(element instanceof HTMLVideoElement)) throw new Error("Expected an actual HTML video element");
  return element;
}

describe("task video popup lifecycle", () => {
  it.each(["close", "Escape", "unmount"] as const)("stops playback and releases the media on %s without navigating away", async close => {
    const slot = fixture();
    const location = window.location.href;
    const trigger = slot.getByRole("button", { name: "Watch demo.mp4" });
    fireEvent.click(trigger);
    await slot.findByRole("dialog");
    const video = media(slot);
    expect(video.controls).toBe(true);
    expect(video.autoplay).toBe(false);
    Object.defineProperty(video, "paused", { configurable: true, value: false });
    fireEvent.play(video);
    fireEvent.playing(video);
    if (close === "unmount") slot.unmount();
    else if (close === "Escape") fireEvent.keyDown(video, { key: "Escape" });
    else fireEvent.click(slot.getByRole("button", { name: "Close video" }));
    await waitFor(() => expect(video.paused).toBe(true));
    expect(video.getAttribute("src")).toBeNull();
    expect(window.location.href).toBe(location);
    if (close !== "unmount") {
      await waitFor(() => expect(document.activeElement).toBe(trigger));
      expect(slot.getByText("Task result stays here")).toBeTruthy();
      fireEvent.click(trigger);
      await waitFor(() => expect(media(slot).getAttribute("src")).toContain("/attachments/download?"));
      expect(media(slot).autoplay).toBe(false);
    }
  });

  it("keeps decoder failure visible, offers a separate file download and retries in the same task", async () => {
    const slot = fixture();
    fireEvent.click(slot.getByRole("button", { name: "Watch demo.mp4" }));
    const video = media(slot);
    Object.defineProperty(video, "error", { configurable: true, value: { code: 3 } });
    fireEvent.error(video);
    await slot.findByRole("alert");
    expect(video.hasAttribute("src")).toBe(false);
    const download = slot.getByRole("link", { name: "Download video file" });
    expect(download.getAttribute("href")).toContain("download=1");
    expect(download.getAttribute("download")).toBe("demo.mp4");
    fireEvent.click(slot.getByRole("button", { name: "Retry video" }));
    expect(slot.queryByRole("alert")).toBeNull();
    expect(media(slot).getAttribute("src")).toContain("/attachments/download?");
  });

  it("shows unsupported playback rather than presenting a broken player as a successful demo", async () => {
    vi.mocked(HTMLMediaElement.prototype.canPlayType).mockReturnValue("");
    const slot = fixture();
    fireEvent.click(slot.getByRole("button", { name: "Watch demo.mp4" }));
    await slot.findByRole("alert");
    expect(media(slot).hasAttribute("src")).toBe(false);
    expect(slot.getByRole("link", { name: "Download video file" })).toBeTruthy();
  });

  it("stops a compact drawer's retained media without hiding or inerting the existing task", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation(query => ({
      matches: true, media: query, onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    }));
    const slot = fixture();
    const task = slot.getByRole("main", { name: "Existing task" });
    fireEvent.click(slot.getByRole("button", { name: "Watch demo.mp4" }));
    const video = await waitFor(() => media(slot));
    expect(task.closest('[inert], [aria-hidden="true"]')).toBeNull();
    Object.defineProperty(video, "paused", { configurable: true, value: false });
    fireEvent.play(video);
    fireEvent.playing(video);
    fireEvent.click(slot.getByRole("button", { name: "Close video" }));
    expect(video.paused).toBe(true);
    expect(video.hasAttribute("src")).toBe(false);
    expect(task.closest('[inert], [aria-hidden="true"]')).toBeNull();
  });
});
