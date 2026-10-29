import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createTasksStore } from "../db/index.js";
import { registerAttachments, saveAttachmentFromBytes } from "./index.js";

const hosts: FakePluginHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.dispose(); });
const fixtureUrl = new URL("../../../apps/web/public/blog/tweets/tiling.mp4", import.meta.url);

async function setup() {
  const host = createFakePluginHost({ pluginId: "tasks" });
  hosts.push(host);
  const database = host.bb.storage.database();
  const store = createTasksStore(database);
  registerAttachments(host.bb, store);
  const project = store.createProject({ name: "Media", prefix: "MEDIA", color: "blue" });
  const task = store.createTask({ projectId: project.id, title: "Media owner" });
  const bytes = await readFile(fixtureUrl);
  const attachment = await saveAttachmentFromBytes(store, bytes, { taskId: task.id, fileName: "fixture.mp4" });
  const main = database.prepare<[], { name: string; file: string }>("PRAGMA database_list").all().find(row => row.name === "main")!;
  const url = `/attachments/download?attachmentId=${attachment.id}`;
  return { ...host, store, task, bytes, attachment, url, root: dirname(main.file) };
}

describe("task video HTTP delivery", () => {
  it("serves inline MP4 and metadata-only HEAD with actual lengths and separate download disposition", async () => {
    const fixture = await setup();
    const head = await fixture.harness.fetchHttp("HEAD", fixture.url, { headers: { range: "bytes=0-7" } });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("video/mp4");
    expect(head.headers.get("content-length")).toBe(String(fixture.bytes.length));
    expect(head.headers.get("accept-ranges")).toBe("bytes");
    expect(head.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(await head.text()).toBe("");
    const full = await fixture.harness.fetchHttp("GET", fixture.url);
    expect(full.status).toBe(200);
    expect(Buffer.from(await full.arrayBuffer())).toEqual(fixture.bytes);
    const download = await fixture.harness.fetchHttp("GET", `${fixture.url}&download=1`);
    expect(download.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(download.headers.get("content-type")).toBe("video/mp4");
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await download.arrayBuffer())).toEqual(fixture.bytes);
  });

  it("supports closed, open-ended and suffix byte ranges for seeking without changing the returned bytes", async () => {
    const fixture = await setup();
    for (const [range, start, end] of [
      ["bytes=4-19", 4, 19],
      ["bytes=24-", 24, fixture.bytes.length - 1],
      ["bytes=-16", fixture.bytes.length - 16, fixture.bytes.length - 1],
    ] as const) {
      const response = await fixture.harness.fetchHttp("GET", fixture.url, { headers: { range } });
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe(`bytes ${start}-${end}/${fixture.bytes.length}`);
      expect(response.headers.get("content-length")).toBe(String(end - start + 1));
      expect(Buffer.from(await response.arrayBuffer())).toEqual(fixture.bytes.subarray(start, end + 1));
    }
  });

  it("returns unsatisfiable ranges with the resource size and ignores malformed/multipart or unverifiable If-Range", async () => {
    const fixture = await setup();
    for (const range of [`bytes=${fixture.bytes.length}-`, "bytes=-0", "bytes=999999999999999999999999999999999-"]) {
      const response = await fixture.harness.fetchHttp("GET", fixture.url, { headers: { range } });
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe(`bytes */${fixture.bytes.length}`);
      expect(response.headers.get("content-length")).toBe("0");
      expect(await response.text()).toBe("");
    }
    for (const headers of [{ range: "bytes=4-2" }, { range: "bytes=0-1,4-5" }, { range: "bytes=0-1", "if-range": '"unknown"' }]) {
      const response = await fixture.harness.fetchHttp("GET", fixture.url, { headers });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-range")).toBeNull();
      expect(Buffer.from(await response.arrayBuffer())).toEqual(fixture.bytes);
    }
  });

  it("does not advertise HTML or spoofed media as a playable attachment and preserves an ordinary download recovery", async () => {
    const fixture = await setup();
    const bytes = Buffer.from("<html><script>alert('not media')</script></html>");
    const video = await saveAttachmentFromBytes(fixture.store, bytes, { taskId: fixture.task.id, fileName: "broken.mp4", mime: "video/mp4" });
    const url = `/attachments/download?attachmentId=${video.id}`;
    const invalid = await fixture.harness.fetchHttp("GET", url);
    expect(invalid.status).toBe(415);
    expect(invalid.headers.get("content-type")).toBe("application/json");
    const recovery = await fixture.harness.fetchHttp("GET", `${url}&download=1`);
    expect(recovery.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(Buffer.from(await recovery.arrayBuffer())).toEqual(bytes);
    const html = await saveAttachmentFromBytes(fixture.store, bytes, { taskId: fixture.task.id, fileName: "active.html", mime: "text/html" });
    const unsafe = await fixture.harness.fetchHttp("GET", `/attachments/download?attachmentId=${html.id}`);
    expect(unsafe.headers.get("content-type")).toBe("application/octet-stream");
    expect(unsafe.headers.get("content-disposition")).toMatch(/^attachment;/);
  });

  it("reports a deleted artifact as unavailable rather than serving cached success metadata", async () => {
    const fixture = await setup();
    await rm(join(fixture.root, fixture.attachment.blobPath));
    for (const method of ["GET", "HEAD"]) {
      const response = await fixture.harness.fetchHttp(method, fixture.url);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).not.toBe("video/mp4");
      if (method === "HEAD") expect(await response.text()).toBe("");
    }
  });
});
