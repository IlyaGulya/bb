import { randomUUID } from "node:crypto";
import { link, lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capturePrivateDirectory, captureReadPrivate, captureWritePrivate } from "../src/private-capture-files.js";

describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")("private publication crash layouts", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "bb-capture-publication-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("recovers identical publication interrupted after the target hardlink exists", async () => {
    const directory = await capturePrivateDirectory(root, "core", "scope", "capture", "artifact");
    const payload = Buffer.from("SYNTHETIC_CRASH_BOUNDARY_PAYLOAD");
    const pending = join(directory, `${randomUUID()}.pending`);
    const target = join(directory, "0.chunk");
    await writeFile(pending, payload, { flag: "wx", mode: 0o600 });
    await link(pending, target);
    expect((await lstat(target)).nlink).toBe(2);

    await captureWritePrivate(directory, "0.chunk", payload);

    expect(await captureReadPrivate(directory, "0.chunk", payload.length)).toEqual(payload);
    expect((await lstat(target)).nlink).toBe(1);
    expect((await readdir(directory)).filter(name => name.endsWith(".pending"))).toEqual([]);
  });

  it("does not repair a foreign hardlink by relaxing the owner-private file boundary", async () => {
    const directory = await capturePrivateDirectory(root, "host", "capture");
    const payload = Buffer.from("SYNTHETIC_FOREIGN_LINK_PAYLOAD");
    const foreign = join(root, "foreign-private-file");
    await writeFile(foreign, payload, { flag: "wx", mode: 0o600 });
    await link(foreign, join(directory, "0.chunk"));

    await expect(captureReadPrivate(directory, "0.chunk", payload.length)).rejects.toMatchObject({ code: "integrity" });
    await expect(captureWritePrivate(directory, "0.chunk", payload)).rejects.toMatchObject({ code: "integrity" });
    expect(await readFile(foreign)).toEqual(payload);
    expect((await lstat(foreign)).nlink).toBe(2);
  });

  it("never replaces an already published different payload during replay", async () => {
    const directory = await capturePrivateDirectory(root, "core", "scope", "capture", "artifact");
    const original = Buffer.from("SYNTHETIC_ORIGINAL");
    await captureWritePrivate(directory, "0.chunk", original);
    await expect(captureWritePrivate(directory, "0.chunk", Buffer.from("SYNTHETIC_CONFLICT"))).rejects.toMatchObject({ code: "integrity" });
    expect(await captureReadPrivate(directory, "0.chunk", original.length)).toEqual(original);
  });
});
