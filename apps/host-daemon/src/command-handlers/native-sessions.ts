import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, realpath, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { nativeOmpImageReferences, parseNativeHistoryRecord } from "@bb/domain";
import { NATIVE_SESSION_CHUNK_BYTES, type NativeChunk, type NativeDiscover, type NativeDiscovery, type NativeRead, type NativeSessionRoot, type NativeSessionSource } from "@bb/host-daemon-contract";

const HEADER_BYTES = 1024 * 1024;
const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const MAX_DISCOVERY_ENTRIES = 20_000;
const verifiedImages = new Map<string, Promise<void>>();
const MAX_VERIFIED_IMAGES = 128;
const forbidden = /(?:^|[/\\])(?:\.?auth(?:\.db(?:-wal|-shm)?|\.json)?|\.?credentials?[^/\\]*|keychain[^/\\]*|\.env(?:\.[^/\\]*)?|\.?mcp(?:\.json)?|\.npmrc|\.netrc|\.pypirc|\.yarnrc(?:\.yml)?|settings\.json|config\.toml|\.ssh|\.aws|\.gnupg|\.docker|\.kube|\.git-credentials|id_rsa|id_ed25519|tokens?[^/\\]*|secrets?)(?:$|[/\\])/i;
function contained(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}
interface ConfinedNativeFile { path: string; stat: Stats; imageHash: string | null }
async function safePath(root: string, path: string, imageHash: string | null = null): Promise<ConfinedNativeFile> {
  if (!isAbsolute(root) || !isAbsolute(path) || !contained(resolve(root), resolve(path)) || forbidden.test(path)) throw new Error("Select a session or referenced artifact inside its explicit source root, not an authentication/configuration file.");
  const canonicalRoot = await realpath(root);
  const canonical = await realpath(path);
  if (canonicalRoot !== resolve(root) || canonical !== resolve(path) || !contained(canonicalRoot, canonical)) throw new Error("Native source paths may not traverse symbolic links.");
  const stat = await lstat(canonical);
  if (!stat.isFile() || (stat.nlink !== 1 && imageHash === null)) throw new Error("Native sources must be regular, unshared files unless they are verified canonical OMP images.");
  return { path: canonical, stat, imageHash };
}
async function openConfined(source: ConfinedNativeFile): Promise<FileHandle> {
  if (process.platform === "win32" || typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_DIRECTORY !== "number") throw new Error("This host cannot provide confined native file reads.");
  const root = parse(source.path).root;
  const parts = relative(root, source.path).split(sep);
  const name = parts.pop();
  if (!name) throw new Error("Native source must identify a file.");
  const descriptors = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let directory = await open(root, directoryFlags);
  try {
    for (const part of parts) {
      const previous = directory;
      directory = await open(`${descriptors}/${previous.fd}/${part}`, directoryFlags);
      await previous.close();
    }
    const file = await open(`${descriptors}/${directory.fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await file.stat();
      if (!opened.isFile() || (opened.nlink !== 1 && source.imageHash === null) || revision(opened) !== revision(source.stat)) throw new Error("Native source identity changed between validation and confined open.");
      return file;
    } catch (error) { await file.close(); throw error; }
  } finally { await directory.close(); }
}
function revision(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}
async function isNativeImage(file: FileHandle, head: Buffer, tail: Buffer, size: number, signal?: AbortSignal): Promise<boolean> {
  const read = async (offset: number, length: number): Promise<Buffer | null> => {
    signal?.throwIfAborted();
    if (offset < 0 || offset + length > size) return null;
    if (offset + length <= head.length) return head.subarray(offset, offset + length);
    if (offset >= size - tail.length) return tail.subarray(offset - size + tail.length, offset - size + tail.length + length);
    const bytes = Buffer.alloc(length);
    let received = 0;
    while (received < length) {
      signal?.throwIfAborted();
      const result = await file.read(bytes, received, length - received, offset + received);
      if (!result.bytesRead) return null;
      received += result.bytesRead;
    }
    return bytes;
  };
  if (size >= 57 && head.toString("hex", 0, 8) === "89504e470d0a1a0a" && head.readUInt32BE(8) === 13 && head.toString("ascii", 12, 16) === "IHDR" && head.readUInt32BE(16) > 0 && head.readUInt32BE(20) > 0) {
    let offset = 8;
    let image = false;
    while (offset + 12 <= size) {
      const chunk = await read(offset, 8);
      if (!chunk) return false;
      const length = chunk.readUInt32BE(0);
      const type = chunk.toString("ascii", 4, 8);
      if (offset + length + 12 > size || (type === "IHDR" && offset !== 8)) return false;
      if (type === "IDAT" && length > 0) image = true;
      if (type === "IEND") return image && length === 0 && offset + 12 === size && tail.subarray(-12).toString("hex") === "0000000049454e44ae426082";
      offset += length + 12;
    }
    return false;
  }
  if (size >= 12 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff && tail.at(-2) === 0xff && tail.at(-1) === 0xd9) {
    let offset = 2;
    let frame = false;
    while (offset + 4 <= size) {
      const marker = await read(offset, 2);
      if (!marker || marker[0] !== 0xff) return false;
      const type = marker.readUInt8(1);
      if (type === 0xff) { offset++; continue; }
      if (type === 0x01) { offset += 2; continue; }
      const encodedLength = await read(offset + 2, 2);
      if (!encodedLength) return false;
      const length = encodedLength.readUInt16BE(0);
      if (length < 2 || offset + length + 2 > size) return false;
      if (type >= 0xc0 && type <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(type)) {
        const dimensions = length >= 8 ? await read(offset + 2, 8) : null;
        if (!dimensions || dimensions.readUInt16BE(3) === 0 || dimensions.readUInt16BE(5) === 0 || dimensions.readUInt8(7) === 0 || length !== 8 + 3 * dimensions.readUInt8(7)) return false;
        frame = true;
      }
      if (type === 0xda) {
        const components = length >= 6 ? await read(offset + 4, 1) : null;
        return frame && components !== null && components.readUInt8(0) > 0 && length === 6 + 2 * components.readUInt8(0) && offset + length + 2 < size - 2;
      }
      offset += length + 2;
    }
    return false;
  }
  if (size >= 14 && ["GIF87a", "GIF89a"].includes(head.toString("ascii", 0, 6)) && head.readUInt16LE(6) > 0 && head.readUInt16LE(8) > 0) {
    const flags = head.readUInt8(10);
    let offset = 13 + ((flags & 0x80) ? 3 * 2 ** ((flags & 7) + 1) : 0);
    let image = false;
    while (offset < size) {
      const encoded = await read(offset++, 1);
      if (!encoded) return false;
      const type = encoded.readUInt8(0);
      if (type === 0x3b) return image && offset === size;
      if (type === 0x21) { if (!(await read(offset++, 1))) return false; }
      else if (type === 0x2c) {
        const frame = await read(offset, 9);
        if (!frame || frame.readUInt16LE(4) === 0 || frame.readUInt16LE(6) === 0) return false;
        const local = frame.readUInt8(8);
        offset += 9 + ((local & 0x80) ? 3 * 2 ** ((local & 7) + 1) : 0);
        const code = await read(offset++, 1);
        if (!code || code.readUInt8(0) < 2 || code.readUInt8(0) > 8) return false;
      } else return false;
      let data = false;
      for (;;) {
        const block = await read(offset++, 1);
        if (!block) return false;
        const length = block.readUInt8(0);
        if (!length) break;
        offset += length;
        if (offset > size) return false;
        data = true;
      }
      if (type === 0x2c) { if (!data) return false; image = true; }
    }
    return false;
  }
  if (size >= 30 && head.toString("ascii", 0, 4) === "RIFF" && head.readUInt32LE(4) + 8 === size && head.toString("ascii", 8, 12) === "WEBP") {
    const frames = async (start: number, end: number, nested: boolean): Promise<boolean> => {
      let offset = start;
      let image = false;
      while (offset + 8 <= end) {
        const chunk = await read(offset, 8);
        if (!chunk) return false;
        const type = chunk.toString("ascii", 0, 4);
        const length = chunk.readUInt32LE(4);
        const next = offset + 8 + length + (length & 1);
        if (next > end) return false;
        if (type === "VP8 ") {
          const frame = length >= 10 ? await read(offset + 8, 10) : null;
          if (!frame || (frame.readUInt8(0) & 1) || frame.toString("hex", 3, 6) !== "9d012a" || (frame.readUInt16LE(6) & 0x3fff) === 0 || (frame.readUInt16LE(8) & 0x3fff) === 0) return false;
          image = true;
        } else if (type === "VP8L") {
          const frame = length >= 5 ? await read(offset + 8, 5) : null;
          if (!frame || frame[0] !== 0x2f || (frame.readUInt8(4) >> 5) !== 0) return false;
          image = true;
        } else if (type === "ANMF") {
          if (nested || length < 16 || !(await frames(offset + 24, offset + 8 + length, true))) return false;
          image = true;
        }
        offset = next;
      }
      return image && offset === end;
    };
    return frames(12, size, false);
  }
  const start = head.toString("utf8").replace(/^\uFEFF/, "").trimStart();
  const end = tail.toString("utf8").trimEnd();
  return /^(?:<\?xml[^?]*\?>\s*)?<svg(?:\s|>|\/>)/.test(start) && (end.endsWith("</svg>") || (size <= head.length && /<svg[^>]*\/>$/.test(start)));
}
async function verifyImageBytes(file: FileHandle, stat: Stats, hash: string, signal?: AbortSignal): Promise<void> {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(stat.size, NATIVE_SESSION_CHUNK_BYTES));
  const head = Buffer.alloc(Math.min(stat.size, 1024));
  const tail = Buffer.alloc(Math.min(stat.size, 1024));
  const tailStart = stat.size - tail.length;
  let offset = 0;
  while (offset < stat.size) {
    signal?.throwIfAborted();
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
    if (!bytesRead) throw new Error("Canonical OMP image changed during verification.");
    digest.update(buffer.subarray(0, bytesRead));
    if (offset < head.length) buffer.copy(head, offset, 0, Math.min(bytesRead, head.length - offset));
    if (offset + bytesRead > tailStart) buffer.copy(tail, Math.max(0, offset - tailStart), Math.max(0, tailStart - offset), bytesRead);
    offset += bytesRead;
  }
  signal?.throwIfAborted();
  if (digest.digest("hex") !== hash) throw new Error("Canonical OMP image content does not match its declared SHA-256.");
  if (!(await isNativeImage(file, head, tail, stat.size, signal))) throw new Error("Canonical OMP blob bytes do not identify a supported image format.");
  if (revision(await file.stat()) !== revision(stat)) throw new Error("Canonical OMP image changed during verification.");
}
async function verifyNativeImage(file: FileHandle, stat: Stats, hash: string, signal?: AbortSignal): Promise<void> {
  const key = `${hash}:${revision(stat)}`;
  let verification = verifiedImages.get(key);
  if (verification === undefined) {
    verification = verifyImageBytes(file, stat, hash, signal);
    verifiedImages.set(key, verification);
    if (verifiedImages.size > MAX_VERIFIED_IMAGES) {
      const oldest = verifiedImages.keys().next().value;
      if (oldest !== undefined) verifiedImages.delete(oldest);
    }
  }
  try { await verification; }
  catch (error) { if (verifiedImages.get(key) === verification) verifiedImages.delete(key); throw error; }
  signal?.throwIfAborted();
}
async function readRange(source: ConfinedNativeFile, offset: number, length: number, expected: string | null, signal?: AbortSignal): Promise<{ bytes: Buffer; size: number; revision: string; modifiedAt: number }> {
  const file = await openConfined(source);
  try {
    const before = await file.stat();
    if (!before.isFile() || (before.nlink !== 1 && source.imageHash === null)) throw new Error("Native source is not a private regular file or a verified canonical OMP image.");
    const stamp = revision(before);
    if (expected !== null && expected !== stamp) throw new Error("Native source changed. Discover it again; committed prefixes will be verified before resuming.");
    if (source.imageHash !== null) await verifyNativeImage(file, before, source.imageHash, signal);
    const bytes = Buffer.alloc(Math.min(length, Math.max(0, before.size - offset)));
    let received = 0;
    while (received < bytes.length) {
      const result = await file.read(bytes, received, bytes.length - received, offset + received);
      if (!result.bytesRead) break;
      received += result.bytesRead;
    }
    if (received !== bytes.length || revision(await file.stat()) !== stamp) throw new Error("Native source changed during read.");
    return { bytes, size: before.size, revision: stamp, modifiedAt: before.mtimeMs };
  } finally { await file.close(); }
}
async function assertRecordBoundary(source: ConfinedNativeFile, offset: number, bytes: Buffer, signal?: AbortSignal): Promise<void> {
  const stamp = revision(source.stat);
  if (offset > 0 && (await readRange(source, offset - 1, 1, stamp, signal)).bytes[0] !== 10) throw new Error("Canonical OMP image authority must start at a native JSONL record boundary.");
  const newline = bytes.indexOf(10);
  if (newline !== -1 && newline !== bytes.length - 1) throw new Error("Canonical OMP image authority must occupy one native JSONL record.");
  const end = offset + bytes.length;
  if (newline === -1 && end < source.stat.size) {
    const next = (await readRange(source, end, 2, stamp, signal)).bytes;
    if (next[0] !== 10 && !(next[0] === 13 && next[1] === 10)) throw new Error("Canonical OMP image authority must end at a native JSONL record boundary.");
  }
}
async function describe(root: NativeSessionRoot, path: string): Promise<NativeSessionSource | null> {
  const source = await safePath(root.path, path);
  const head = await readRange(source, 0, HEADER_BYTES, null);
  const lines = head.bytes.toString("utf8").split("\n");
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let title: string | null = null;
  let identifiedEngine = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line?.trim()) continue;
    if (index === lines.length - 1 && head.size > head.bytes.length) break;
    const record = parseNativeHistoryRecord(JSON.parse(line), index);
    identifiedEngine ||= root.engine === "omp" ? record.type === "session" : root.engine === "codex" ? record.type === "session_meta" : typeof record.state.sessionId === "string" && record.type !== "session";
    sessionId ??= record.sessionId;
    cwd ??= record.cwd;
    title ??= record.title ?? record.parts.find((part) => part.kind === "user")?.text.slice(0, 160) ?? null;
  }
  if (!sessionId) return null;
  if (!identifiedEngine) throw new Error("The selected file does not identify the selected native engine; choose the matching source root.");
  return { ...root, rootPath: root.path, path, sessionId, cwd, title: (title ?? basename(path)).slice(0, 1024), sizeBytes: head.size, revision: head.revision, modifiedAt: head.modifiedAt };
}
export async function discoverNativeSessions(input: NativeDiscover, signal?: AbortSignal): Promise<NativeDiscovery> {
  const sessions: NativeSessionSource[] = [];
  const warnings: string[] = [];
  const candidates: { root: NativeSessionRoot; path: string }[] = [];
  let visited = 0;
  let incomplete = false;
  for (const root of input.roots) {
    if (!isAbsolute(root.path) || forbidden.test(root.path)) throw new Error("Session roots must be explicit absolute directories, separate from credentials.");
    const queue = [{ path: resolve(root.path), depth: 0 }];
    for (let index = 0; index < queue.length; index++) {
      signal?.throwIfAborted();
      const entry = queue[index]!;
      if (++visited > MAX_DISCOVERY_ENTRIES) { incomplete = true; break; }
      try {
        if (await realpath(entry.path) !== entry.path) throw new Error("Symbolic-link roots are not accepted.");
        const directory = await opendir(entry.path);
        for await (const child of directory) {
          signal?.throwIfAborted();
          if (++visited > MAX_DISCOVERY_ENTRIES) { incomplete = true; break; }
          const path = resolve(entry.path, child.name);
          if (forbidden.test(path) || child.isSymbolicLink()) continue;
          if (child.isDirectory() && entry.depth < 8 && !["node_modules", ".git", "subagents"].includes(child.name)) queue.push({ path, depth: entry.depth + 1 });
          else if (child.isFile() && child.name.endsWith(".jsonl")) candidates.push({ root, path });
        }
      } catch (error) { warnings.push(`${root.profile}: ${error instanceof Error ? error.message : "Source directory unavailable"}`); }
      if (incomplete) break;
    }
    if (incomplete) break;
  }
  candidates.sort((a, b) => a.path.localeCompare(b.path) || a.root.engine.localeCompare(b.root.engine));
  let uniqueCount = 0;
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]!;
    const previous = candidates[uniqueCount - 1];
    if (previous?.path === candidate.path && previous.root.engine === candidate.root.engine) continue;
    candidates[uniqueCount++] = candidate;
  }
  candidates.length = uniqueCount;
  const end = Math.min(candidates.length, input.cursor + input.limit);
  for (let index = input.cursor; index < end; index++) {
    signal?.throwIfAborted();
    const candidate = candidates[index]!;
    try {
      const source = await describe(candidate.root, candidate.path);
      if (source) sessions.push(source);
      else warnings.push(`${basename(candidate.path)} has no supported native identity in its header; not imported.`);
    } catch (error) { warnings.push(`${basename(candidate.path)}: ${error instanceof Error ? error.message : "Unreadable session"}`); }
  }
  return { sessions, warnings, incomplete, nextCursor: end < candidates.length ? end : null };
}
export async function readNativeSessionIdentity(source: NativeSessionSource): Promise<NativeSessionSource> {
  if (!source.path.endsWith(".jsonl")) throw new Error("Only native JSONL session files can be selected.");
  const described = await describe({ engine: source.engine, path: source.rootPath, profile: source.profile, artifactRoots: source.artifactRoots }, source.path);
  if (!described || described.sessionId !== source.sessionId || described.cwd !== source.cwd) throw new Error("Native session identity or authoritative recorded workspace changed.");
  return described;
}
export async function readNativeSession(input: NativeRead, signal?: AbortSignal): Promise<NativeChunk> {
  signal?.throwIfAborted();
  const source = await safePath(input.source.rootPath, input.source.path);
  if (!source.path.endsWith(".jsonl")) throw new Error("Only native JSONL session files can be selected.");
  if (source.stat.size !== input.source.sizeBytes) throw new Error("Selected native size does not match the authoritative source boundary.");
  if (input.offset === 0 && input.artifact === null) {
    const described = await readNativeSessionIdentity(input.source);
    if (described.revision !== input.source.revision || described.sizeBytes !== input.source.sizeBytes) throw new Error("Selected native source boundary does not match the source file.");
  }
  let selected = source;
  let expected: string | null = input.source.revision;
  if (input.artifact) {
    const proof = input.artifact;
    if (proof.recordLength > MAX_RECORD_BYTES) throw new Error("Artifact reference record exceeds the bounded native record limit.");
    const record = await readRange(source, proof.recordOffset, proof.recordLength, input.source.revision);
    if (createHash("sha256").update(record.bytes).digest("hex") !== proof.recordSha256) throw new Error("Artifact reference does not match its native source record.");
    const parsed = parseNativeHistoryRecord(JSON.parse(record.bytes.toString("utf8")), 0);
    if (!parsed.artifacts.includes(proof.reference)) throw new Error("Artifact was not referenced by the selected structured native record.");
    if (proof.reference.endsWith(".jsonl") || forbidden.test(proof.reference)) throw new Error("Authentication/configuration files and neighboring sessions are not native artifacts.");
    const imageHash = input.source.engine === "omp" && nativeOmpImageReferences(parsed.state).includes(proof.reference) ? proof.reference : null;
    if (imageHash !== null) {
      if (record.bytes.length !== proof.recordLength) throw new Error("Canonical OMP image authority exceeds the native record boundary.");
      await assertRecordBoundary(source, proof.recordOffset, record.bytes, signal);
      await readNativeSessionIdentity(input.source);
    }
    let artifact: ConfinedNativeFile | null = null;
    for (const root of input.source.artifactRoots) {
      const candidate = isAbsolute(proof.reference) ? proof.reference : resolve(root, proof.reference);
      if (!contained(resolve(root), candidate)) continue;
      try { artifact = await safePath(root, candidate, imageHash); break; } catch { continue; }
    }
    if (artifact === null) throw new Error("Referenced artifact is missing or outside the explicitly selected artifact roots.");
    selected = artifact;
    expected = proof.revision;
  }
  const result = await readRange(selected, input.offset, input.length, expected, signal);
  signal?.throwIfAborted();
  return { content: result.bytes.toString("base64"), offset: input.offset, sizeBytes: result.size, revision: result.revision, sha256: createHash("sha256").update(result.bytes).digest("hex") };
}
