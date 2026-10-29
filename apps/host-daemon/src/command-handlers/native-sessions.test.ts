import { createHash } from "node:crypto";
import { link, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeRead, NativeSessionRoot } from "@bb/host-daemon-contract";
import { discoverNativeSessions, readNativeSession } from "./native-sessions.js";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const checksum = (value: string) => createHash("sha256").update(value).digest("hex");
async function fixture(reference = "result.bin") {
  const directory = await mkdtemp(join(tmpdir(), "bb-native-source-"));
  directories.push(directory);
  const sessions = join(directory, "sessions");
  const artifacts = join(directory, "artifacts");
  await mkdir(sessions); await mkdir(artifacts);
  const header = `${JSON.stringify({ type: "session", id: "synthetic-source-session", cwd: "/fixture/workspace" })}\n`;
  const record = JSON.stringify({ type: "checkpoint", id: "state-a", artifactPath: reference });
  const path = join(sessions, "source.jsonl");
  await writeFile(path, header + record);
  await writeFile(join(artifacts, "result.bin"), "original-artifact");
  const root: NativeSessionRoot = { engine: "omp", path: sessions, profile: "Synthetic profile", artifactRoots: [artifacts] };
  const discovered = await discoverNativeSessions({ roots: [root], cursor: 0, limit: 100 });
  const source = discovered.sessions[0];
  if (!source) throw new Error(discovered.warnings.join("; "));
  const input: NativeRead = { source, offset: 0, length: 256 * 1024, artifact: null };
  const proof = { reference, recordOffset: Buffer.byteLength(header), recordLength: Buffer.byteLength(record), recordSha256: checksum(record), revision: null };
  return { directory, sessions, artifacts, path, header, record, root, input, proof };
}

describe("explicit native source boundaries", () => {
  it("refuses source replacement after discovery rather than reading a new boundary", async () => {
    const saved = await fixture();
    await writeFile(saved.path, `${saved.header}${saved.record}\n${JSON.stringify({ type: "new-state" })}`);
    await expect(readNativeSession(saved.input)).rejects.toThrow();
  });

  it("does not follow session symlinks, hard links, or a path outside the chosen root", async () => {
    const saved = await fixture();
    const symbolic = join(saved.sessions, "symbolic.jsonl");
    await symlink(saved.path, symbolic);
    await expect(readNativeSession({ ...saved.input, source: { ...saved.input.source, path: symbolic } })).rejects.toThrow();
    await expect(readNativeSession({ ...saved.input, source: { ...saved.input.source, rootPath: saved.artifacts } })).rejects.toThrow();
    await link(saved.path, join(saved.sessions, "hard.jsonl"));
    await expect(readNativeSession(saved.input)).rejects.toThrow();
  });

  it("requires a checksum-proven native reference before reading an artifact", async () => {
    const saved = await fixture();
    const original = await readNativeSession({ ...saved.input, artifact: saved.proof });
    expect(Buffer.from(original.content, "base64").toString("utf8")).toBe("original-artifact");
    await expect(readNativeSession({ ...saved.input, artifact: { ...saved.proof, reference: "unreferenced.bin" } })).rejects.toThrow();
    await expect(readNativeSession({ ...saved.input, artifact: { ...saved.proof, recordSha256: "0".repeat(64) } })).rejects.toThrow();
  });

  it.each([".credentials.json", "neighbor.jsonl"])("never admits a referenced %s file as an artifact", async (reference) => {
    const saved = await fixture(reference);
    await writeFile(join(saved.artifacts, reference), "synthetic-sensitive-or-neighbor-data");
    await expect(readNativeSession({ ...saved.input, artifact: saved.proof })).rejects.toThrow();
  });

  it("refuses artifact symlinks even when their targets exist inside an allowed directory", async () => {
    const saved = await fixture("linked.bin");
    await symlink(join(saved.artifacts, "result.bin"), join(saved.artifacts, "linked.bin"));
    await expect(readNativeSession({ ...saved.input, artifact: saved.proof })).rejects.toThrow();
  });

  it("does not discover neighboring sessions through a selected directory symlink", async () => {
    const saved = await fixture();
    const linkedRoot = join(saved.directory, "linked-sessions");
    await symlink(saved.sessions, linkedRoot);
    const result = await discoverNativeSessions({ roots: [{ ...saved.root, path: linkedRoot }], cursor: 0, limit: 100 });
    expect(result.sessions).toEqual([]);
  });
});
