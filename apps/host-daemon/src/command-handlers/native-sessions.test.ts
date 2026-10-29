import { createHash } from "node:crypto";
import { link, mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NATIVE_SESSION_CHUNK_BYTES, type NativeRead, type NativeSessionRoot } from "@bb/host-daemon-contract";
import { discoverNativeSessions, readNativeSession } from "./native-sessions.js";
import type { NativeRecordObject } from "@bb/domain";

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

async function numericSpillFixture(options: { toolName?: string; id?: string; record?: NativeRecordObject } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "bb-native-spill-"));
  directories.push(directory);
  const sessions = join(directory, "sessions");
  const stem = join(sessions, "selected");
  const foreignStem = join(sessions, "foreign");
  const cwd = join(directory, "workspace");
  await mkdir(stem, { recursive: true }); await mkdir(foreignStem); await mkdir(cwd);
  const toolName = options.toolName ?? "bash";
  const id = options.id ?? "25";
  const reference = `artifact://${id}`;
  const header = `${JSON.stringify({ type: "session", version: 3, id: "synthetic-numeric-spill", cwd })}\n`;
  const record = JSON.stringify(options.record ?? { type: "message", message: { role: "toolResult", toolName, content: [{ type: "text", text: `Visible preview only\n[Raw output: ${reference}]` }], details: { timeoutSeconds: 60, wallTimeMs: 5 } } });
  const original = Buffer.from(`${header}${record}\n`);
  const path = join(sessions, "selected.jsonl");
  await writeFile(path, original);
  const fullBytes = Buffer.from(`START\0${"Full native tool output 🧭\n".repeat(20_000)}FULL-NATIVE-SPILL-TAIL`);
  const spillPath = join(stem, `${id}.${toolName}-original.log`);
  await writeFile(spillPath, fullBytes);
  const discovered = await discoverNativeSessions({ roots: [{ engine: "omp", path: sessions, profile: "Synthetic numeric spill", artifactRoots: [stem] }], cursor: 0, limit: 100 });
  const source = discovered.sessions.find((entry) => entry.path === path);
  if (!source) throw new Error(discovered.warnings.join("; "));
  const proof = { reference, recordOffset: Buffer.byteLength(header), recordLength: Buffer.byteLength(record), recordSha256: checksum(record), revision: null };
  const input: NativeRead = { source, artifact: proof, offset: 0, length: NATIVE_SESSION_CHUNK_BYTES };
  return { directory, stem, foreignStem, cwd, path, record, original, fullBytes, spillPath, source, proof, input };
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

  it.each([
    { toolName: "bash", id: "25" },
    { toolName: "read", id: "25" },
    { toolName: "eval", id: "25" },
    { toolName: "bash", id: "0" },
    { toolName: "a".repeat(64), id: "25" },
  ])("retains full native numeric spill bytes for $toolName artifact://$id without changing the native header or cwd", async (options) => {
    const saved = await numericSpillFixture(options);
    const pieces: Buffer[] = [];
    let revision: string | null = null;
    for (let offset = 0; offset < saved.fullBytes.length; offset += NATIVE_SESSION_CHUNK_BYTES) {
      const result = await readNativeSession({ ...saved.input, offset, artifact: { ...saved.proof, revision } });
      expect(result.sizeBytes).toBe(saved.fullBytes.length);
      revision ??= result.revision;
      expect(result.revision).toBe(revision);
      pieces.push(Buffer.from(result.content, "base64"));
    }
    expect(Buffer.concat(pieces)).toEqual(saved.fullBytes);
    expect(await readFile(saved.path)).toEqual(saved.original);
    expect(saved.source.cwd).toBe(saved.cwd);
  });

  it("does not grant numeric spill authority to a user message", async () => {
    const saved = await numericSpillFixture({ record: { type: "message", message: { role: "user", content: [{ type: "text", text: "[Raw output: artifact://25]" }] } } });
    await expect(readNativeSession(saved.input)).rejects.toThrow();
  });

  it("does not grant numeric spill authority to tool arguments or a nested tool-result fragment", async () => {
    const nested = { type: "message", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "[Raw output: artifact://25]" }], details: { timeoutSeconds: 60, wallTimeMs: 5 } } };
    const saved = await numericSpillFixture({ record: { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { entry: nested } }] } } });
    await expect(readNativeSession(saved.input)).rejects.toThrow();
    const fragment = JSON.stringify(nested);
    const start = saved.record.indexOf(fragment);
    if (start < 0) throw new Error("Synthetic tool-result fragment must occur inside the arguments.");
    await expect(readNativeSession({ ...saved.input, artifact: { ...saved.proof, recordOffset: saved.proof.recordOffset + Buffer.byteLength(saved.record.slice(0, start)), recordLength: Buffer.byteLength(fragment), recordSha256: checksum(fragment) } })).rejects.toThrow();
  });

  it.each(["neighbor session", "native cwd"])("does not resolve a numeric spill from a foreign %s root", async (location) => {
    const saved = await numericSpillFixture();
    const foreign = location === "neighbor session" ? saved.foreignStem : saved.cwd;
    await rename(saved.spillPath, join(foreign, basename(saved.spillPath)));
    await expect(readNativeSession({ ...saved.input, source: { ...saved.source, artifactRoots: [saved.stem, foreign] } })).rejects.toThrow();
  });

  it.each(["25.credentials.json", ".mcp.json"])("does not treat an adjacent %s auth/configuration file as a numeric spill", async (name) => {
    const saved = await numericSpillFixture();
    await rm(saved.spillPath);
    await writeFile(join(saved.stem, name), "SYNTHETIC CONFIGURATION THAT MUST NOT BE TRANSFERRED");
    await expect(readNativeSession(saved.input)).rejects.toThrow();
  });

  it("does not follow a numeric spill symlink to another session", async () => {
    const saved = await numericSpillFixture();
    const outside = join(saved.foreignStem, basename(saved.spillPath));
    await rename(saved.spillPath, outside);
    await symlink(outside, saved.spillPath);
    await expect(readNativeSession(saved.input)).rejects.toThrow();
  });

  it("does not follow a symbolic numeric spill session-stem directory", async () => {
    const saved = await numericSpillFixture();
    await rename(saved.stem, `${saved.stem}-moved`);
    await writeFile(join(saved.foreignStem, basename(saved.spillPath)), saved.fullBytes);
    await symlink(saved.foreignStem, saved.stem);
    await expect(readNativeSession(saved.input)).rejects.toThrow();
  });

  it("retains the non-image hardlink ban for numeric spill outputs", async () => {
    const saved = await numericSpillFixture();
    await link(saved.spillPath, join(saved.foreignStem, "outside-alias.log"));
    await expect(readNativeSession(saved.input)).rejects.toThrow();
  });

  it("refuses an ambiguous numeric spill ID instead of choosing between original logs", async () => {
    const saved = await numericSpillFixture();
    await writeFile(join(saved.stem, "25.read-original.log"), "DIFFERENT SAVED OUTPUT WITH THE SAME SESSION-LOCAL ID");
    await expect(readNativeSession(saved.input)).rejects.toThrow();
  });
});
