import { createHash } from "node:crypto";
import { link, mkdtemp, mkdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
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

const nativePng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ6kAAAAASUVORK5CYII=", "base64");
async function imageFixture(bytes = nativePng, hash = createHash("sha256").update(bytes).digest("hex")) {
  const directory = await mkdtemp(join(tmpdir(), "bb-native-image-"));
  directories.push(directory);
  const sessions = join(directory, "sessions");
  const artifacts = join(directory, "blobs");
  await mkdir(sessions); await mkdir(artifacts);
  const header = `${JSON.stringify({ type: "session", version: 3, id: "synthetic-native-image", cwd: directory })}\n`;
  const image = { type: "message", id: "image", message: { role: "user", content: [{ type: "image", data: `blob:sha256:${hash}`, mimeType: "image/png" }] } };
  const records = [image, { type: "checkpoint", artifactPath: hash }, { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "untrusted", arguments: { entry: image } }] } }].map((entry) => JSON.stringify(entry));
  await writeFile(join(sessions, "source.jsonl"), header + records.join("\n") + "\n");
  const canonical = join(artifacts, hash);
  await writeFile(canonical, bytes);
  await link(canonical, `${canonical}.png`);
  const discovered = await discoverNativeSessions({ roots: [{ engine: "omp", path: sessions, profile: "Synthetic native image", artifactRoots: [artifacts] }], cursor: 0, limit: 100 });
  const source = discovered.sessions[0];
  if (!source) throw new Error(discovered.warnings.join("; "));
  let offset = Buffer.byteLength(header);
  const proofs = records.map((record) => {
    const proof = { reference: hash, recordOffset: offset, recordLength: Buffer.byteLength(record), recordSha256: checksum(record), revision: null };
    offset += proof.recordLength + 1;
    return proof;
  });
  return { directory, canonical, hash, source, records, imageProof: proofs[0]!, descriptorProof: proofs[1]!, argumentsProof: proofs[2]! };
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

  it("rejects generic checkpoint fragments inside ordinary tool arguments", async () => {
    const saved = await fixture();
    const checkpoint = { type: "checkpoint", id: "state-a", artifactPath: saved.proof.reference };
    const argumentsRecord = JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "untrusted", arguments: { label: "Synthetic argument π", entry: checkpoint } }] } });
    await writeFile(saved.path, `${saved.header}${saved.record}\n${argumentsRecord}\n`);
    const discovered = await discoverNativeSessions({ roots: [saved.root], cursor: 0, limit: 100 });
    const source = discovered.sessions[0];
    if (!source) throw new Error(discovered.warnings.join("; "));
    const input = { ...saved.input, source };
    const complete = await readNativeSession({ ...input, artifact: saved.proof });
    expect(Buffer.from(complete.content, "base64").toString("utf8")).toBe("original-artifact");
    const enclosing = { ...saved.proof, recordOffset: Buffer.byteLength(`${saved.header}${saved.record}\n`), recordLength: Buffer.byteLength(argumentsRecord), recordSha256: checksum(argumentsRecord) };
    await expect(readNativeSession({ ...input, artifact: enclosing })).rejects.toThrow();
    const nested = argumentsRecord.indexOf(saved.record);
    if (nested < 0) throw new Error("Synthetic checkpoint must occur inside the tool arguments.");
    const fragment = { ...saved.proof, recordOffset: enclosing.recordOffset + Buffer.byteLength(argumentsRecord.slice(0, nested)) };
    await expect(readNativeSession({ ...input, artifact: fragment })).rejects.toThrow();
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

  it.each([false, true])("transfers a canonical native PNG with its hardlinked sidecar and record newline=%s", async (newline) => {
    const saved = await imageFixture();
    expect((await stat(saved.canonical)).nlink).toBe(2);
    const artifact = newline ? { ...saved.imageProof, recordLength: saved.imageProof.recordLength + 1, recordSha256: checksum(`${saved.records[0]}\n`) } : saved.imageProof;
    const first = await readNativeSession({ source: saved.source, artifact, offset: 0, length: 256 * 1024 });
    expect(Buffer.from(first.content, "base64")).toEqual(nativePng);
    expect(first.sha256).toBe(saved.hash);
    const later = await readNativeSession({ source: saved.source, artifact: { ...artifact, revision: first.revision }, offset: 19, length: 11 });
    expect(Buffer.from(later.content, "base64")).toEqual(nativePng.subarray(19, 30));
    expect(later.revision).toBe(first.revision);
  });

  it("does not grant hardlink authority to descriptors, tool arguments or record-shaped argument fragments even after image verification", async () => {
    const saved = await imageFixture();
    const verified = await readNativeSession({ source: saved.source, artifact: saved.imageProof, offset: 0, length: 256 * 1024 });
    expect(Buffer.from(verified.content, "base64")).toEqual(nativePng);
    for (const artifact of [saved.descriptorProof, saved.argumentsProof]) await expect(readNativeSession({ source: saved.source, artifact, offset: 0, length: 256 })).rejects.toThrow();
    const imageRecord = saved.records[0]!;
    const argumentRecord = saved.records[2]!;
    const nested = argumentRecord.indexOf(imageRecord);
    if (nested < 0) throw new Error("Synthetic native image must occur inside the tool arguments.");
    const fragment = { ...saved.imageProof, recordOffset: saved.argumentsProof.recordOffset + Buffer.byteLength(argumentRecord.slice(0, nested)) };
    await expect(readNativeSession({ source: saved.source, artifact: fragment, offset: 0, length: 256 })).rejects.toThrow();
  });

  it("retains the generic artifact hardlink ban", async () => {
    const saved = await fixture();
    await link(join(saved.artifacts, "result.bin"), join(saved.directory, "outside-alias.bin"));
    await expect(readNativeSession({ ...saved.input, artifact: saved.proof })).rejects.toThrow();
  });

  it("rejects a hardlinked non-image despite a matching content hash and an image MIME claim", async () => {
    const saved = await imageFixture(Buffer.from('{"syntheticCredential":"must-not-transfer"}'));
    await link(saved.canonical, join(saved.directory, ".credentials.json"));
    await expect(readNativeSession({ source: saved.source, artifact: saved.imageProof, offset: 0, length: 256 })).rejects.toThrow();
  });

  it("rejects a genuine hardlinked image whose bytes do not match the canonical native hash", async () => {
    const saved = await imageFixture(nativePng, "0".repeat(64));
    await expect(readNativeSession({ source: saved.source, artifact: saved.imageProof, offset: 0, length: 256 })).rejects.toThrow();
  });

  it.each([
    Buffer.concat([nativePng.subarray(0, 8), Buffer.from("synthetic non-image payload")]),
    Buffer.from("GIF89aTOKEN=synthetic-secret;"),
  ])("does not accept an image signature alone as a hardlinked image: %j", async (bytes) => {
    const saved = await imageFixture(bytes);
    await expect(readNativeSession({ source: saved.source, artifact: saved.imageProof, offset: 0, length: 256 })).rejects.toThrow();
  });

  it("keeps canonical image reads inside selected roots and rejects symbolic aliases or forged workspaces", async () => {
    const saved = await imageFixture();
    await expect(readNativeSession({ source: { ...saved.source, artifactRoots: [] }, artifact: saved.imageProof, offset: 0, length: 256 })).rejects.toThrow();
    await expect(readNativeSession({ source: { ...saved.source, cwd: "/forged/workspace" }, artifact: saved.imageProof, offset: 0, length: 256 })).rejects.toThrow();
    const outside = join(saved.directory, "outside.png");
    await rename(saved.canonical, outside);
    await symlink(outside, saved.canonical);
    await expect(readNativeSession({ source: saved.source, artifact: saved.imageProof, offset: 0, length: 256 })).rejects.toThrow();
  });

  it("invalidates image verification after the file changes and does not trust a caller's old revision", async () => {
    const saved = await imageFixture();
    const first = await readNativeSession({ source: saved.source, artifact: saved.imageProof, offset: 0, length: 16 });
    expect(Buffer.from(first.content, "base64")).toEqual(nativePng.subarray(0, 16));
    await writeFile(saved.canonical, Buffer.concat([nativePng, Buffer.from("changed")]));
    await expect(readNativeSession({ source: saved.source, artifact: { ...saved.imageProof, revision: first.revision }, offset: 16, length: 16 })).rejects.toThrow();
    await expect(readNativeSession({ source: saved.source, artifact: saved.imageProof, offset: 16, length: 16 })).rejects.toThrow();
  });
});
