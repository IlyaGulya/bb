import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdtemp, open, opendir, realpath, rm, unlink, type FileHandle } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { nativeOmpImageReferences, nativeOmpSpillReferences, parseNativeHistoryRecord } from "@bb/domain";
import { NATIVE_SESSION_CHUNK_BYTES, type NativeChunk, type NativeDiscover, type NativeDiscovery, type NativeLocationInput, type NativeLocations, type NativeRead, type NativeSessionRoot, type NativeSessionSource, type NativeSnapshot } from "@bb/host-daemon-contract";

const HEADER_BYTES = 1024 * 1024;
const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const MAX_DISCOVERY_ENTRIES = 20_000;
const verifiedImages = new Map<string, Promise<void>>();
const MAX_VERIFIED_IMAGES = 128;
const spillDirectories = new Map<string, Map<string, string | null>>();
const MAX_SPILL_DIRECTORIES = 16;
const descriptorRoot = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
const forbidden = /(?:^|[/\\])(?:\.?auth(?:\.db(?:-wal|-shm)?|\.json)?|\.?credentials?[^/\\]*|keychain[^/\\]*|\.env(?:\.[^/\\]*)?|\.?mcp(?:\.json)?|\.npmrc|\.netrc|\.pypirc|\.yarnrc(?:\.yml)?|settings\.json|config\.toml|\.ssh|\.aws|\.gnupg|\.docker|\.kube|\.git-credentials|id_rsa|id_ed25519|tokens?[^/\\]*|secrets?)(?:$|[/\\])/i;
function contained(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}
interface ConfinedNativeFile { path: string; stat: Stats; imageHash: string | null; snapshotFile?: FileHandle }
async function safePath(root: string, path: string, imageHash: string | null = null): Promise<ConfinedNativeFile> {
  if (!isAbsolute(root) || !isAbsolute(path) || !contained(resolve(root), resolve(path)) || forbidden.test(path)) throw new Error("Select a session or referenced artifact inside its explicit source root, not an authentication/configuration file.");
  const canonicalRoot = await realpath(root);
  const canonical = await realpath(path);
  if (canonicalRoot !== resolve(root) || canonical !== resolve(path) || !contained(canonicalRoot, canonical)) throw new Error("Native source paths may not traverse symbolic links.");
  const stat = await lstat(canonical);
  if (!stat.isFile() || (stat.nlink !== 1 && imageHash === null)) throw new Error("Native sources must be regular, unshared files unless they are verified canonical OMP images.");
  return { path: canonical, stat, imageHash };
}
async function openConfinedDirectory(path: string): Promise<FileHandle> {
  if (process.platform === "win32" || typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_DIRECTORY !== "number") throw new Error("This host cannot provide confined native file reads.");
  const root = parse(path).root;
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let directory = await open(root, flags);
  try {
    for (const part of relative(root, path).split(sep)) {
      if (!part) continue;
      const previous = directory;
      directory = await open(`${descriptorRoot}/${previous.fd}/${part}`, flags);
      await previous.close();
    }
    return directory;
  } catch (error) { await directory.close(); throw error; }
}
async function openConfined(source: ConfinedNativeFile, parent?: FileHandle): Promise<FileHandle> {
  const parsed = parse(source.path);
  if (!parsed.base) throw new Error("Native source must identify a file.");
  const directory = parent ?? await openConfinedDirectory(parsed.dir);
  try {
    const file = await open(`${descriptorRoot}/${directory.fd}/${parsed.base}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await file.stat();
      if (!opened.isFile() || (opened.nlink !== 1 && source.imageHash === null) || revision(opened) !== revision(source.stat)) throw new Error("Native source identity changed between validation and confined open.");
      return file;
    } catch (error) { await file.close(); throw error; }
  } finally { if (parent === undefined) await directory.close(); }
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
async function readRange(source: ConfinedNativeFile, offset: number, length: number, expected: string | null, signal?: AbortSignal, parent?: FileHandle): Promise<{ bytes: Buffer; size: number; revision: string; modifiedAt: number }> {
  const file = source.snapshotFile ?? await openConfined(source, parent);
  try {
    const before = await file.stat();
    if (!before.isFile() || (before.nlink !== 1 && source.imageHash === null && source.snapshotFile === undefined)) throw new Error("Native source is not a private regular file or a verified canonical OMP image.");
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
  } finally { if (source.snapshotFile === undefined) await file.close(); }
}
async function assertRecordBoundary(source: ConfinedNativeFile, offset: number, bytes: Buffer, signal?: AbortSignal): Promise<void> {
  const stamp = revision(source.stat);
  if (offset > 0 && (await readRange(source, offset - 1, 1, stamp, signal)).bytes[0] !== 10) throw new Error("Artifact authority must start at a native JSONL record boundary.");
  const newline = bytes.indexOf(10);
  if (newline !== -1 && newline !== bytes.length - 1) throw new Error("Artifact authority must occupy one native JSONL record.");
  const end = offset + bytes.length;
  if (newline === -1 && end < source.stat.size) {
    const next = (await readRange(source, end, 2, stamp, signal)).bytes;
    if (next[0] !== 10 && !(next[0] === 13 && next[1] === 10)) throw new Error("Artifact authority must end at a native JSONL record boundary.");
  }
}
async function describe(root: NativeSessionRoot, path: string): Promise<NativeSessionSource | null> {
  return describeFile(root, path, await safePath(root.path, path));
}
async function describeFile(root: NativeSessionRoot, path: string, source: ConfinedNativeFile): Promise<NativeSessionSource | null> {
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
    let value: unknown;
    try { value = JSON.parse(line); }
    catch (error) { if (index === lines.length - 1) break; throw error; }
    const record = parseNativeHistoryRecord(value, index);
    identifiedEngine ||= root.engine === "omp" ? record.type === "session" : root.engine === "codex" ? record.type === "session_meta" : typeof record.state.sessionId === "string" && record.type !== "session";
    sessionId ??= record.sessionId;
    cwd ??= record.cwd;
    title ??= record.title ?? record.parts.find((part) => part.kind === "user")?.text.slice(0, 160) ?? null;
  }
  if (!sessionId) return null;
  if (!identifiedEngine) throw new Error("The selected file does not identify the selected native engine; choose the matching source root.");
  return { ...root, rootPath: root.path, path, sessionId, cwd, title: (title ?? basename(path)).slice(0, 1024), sizeBytes: head.size, revision: head.revision, modifiedAt: head.modifiedAt };
}

function configuredNativeDirectory(value: string | undefined, fallback: string): string {
  const configured = value?.trim();
  if (!configured) return fallback;
  return configured === "~" ? homedir() : configured.startsWith("~/") ? resolve(homedir(), configured.slice(2)) : resolve(homedir(), configured);
}
export async function nativeSessionLocations(input: NativeLocationInput = {}, signal?: AbortSignal): Promise<NativeLocations> {
  const home = homedir();
  const ompDefault = join(home, ".omp", "agent");
  const ompProfile = process.env.OMP_PROFILE?.trim() ?? process.env.PI_PROFILE?.trim();
  const omp = ompProfile && ompProfile !== "default" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(ompProfile)
    ? join(home, ".omp", "profiles", ompProfile, "agent")
    : configuredNativeDirectory(process.env.PI_CODING_AGENT_DIR, ompDefault);
  const claude = configuredNativeDirectory(process.env.CLAUDE_CONFIG_DIR, join(home, ".claude"));
  const codex = configuredNativeDirectory(process.env.CODEX_HOME, join(home, ".codex"));
  const candidates: NativeSessionRoot[] = [];
  const warnings: string[] = [];
  const add = (engine: NativeSessionRoot["engine"], path: string, profile: string, artifactRoots: string[]) => {
    if (!candidates.some((root) => root.engine === engine && root.path === path)) candidates.push({ engine, path, profile, artifactRoots });
  };
  for (const root of input.roots ?? []) add(root.engine, root.path, root.profile, [...root.artifactRoots]);
  add("omp", join(omp, "sessions"), ompProfile || "OMP", [join(omp, "sessions"), join(omp, "blobs")]);
  add("omp", join(ompDefault, "sessions"), "OMP default", [join(ompDefault, "sessions"), join(ompDefault, "blobs")]);
  for (const [directory, profile] of [[claude, "Claude Code"], [join(home, ".claude"), "Claude Code default"]] as const) {
    add("claude", join(directory, "projects"), profile, [join(directory, "projects")]);
  }
  for (const [directory, profile] of [[codex, "Codex"], [join(home, ".codex"), "Codex default"]] as const) {
    for (const child of ["sessions", "archived_sessions"]) add("codex", join(directory, child), profile, [join(directory, child)]);
  }
  const profileRoot = join(home, ".omp", "profiles");
  try {
    if (await realpath(profileRoot) !== profileRoot) throw new Error("Symbolic-link profile directories are not accepted.");
    const directory = await opendir(profileRoot);
    const names: string[] = [];
    let visited = 0;
    for await (const entry of directory) {
      signal?.throwIfAborted();
      if (++visited > 128) { warnings.push("OMP profile discovery reached its bounded directory limit."); break; }
      if (entry.isDirectory() && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(entry.name)) names.push(entry.name);
    }
    for (const name of names.sort().slice(0, 8)) {
      const agent = join(profileRoot, name, "agent");
      add("omp", join(agent, "sessions"), `OMP ${name}`, [join(agent, "sessions"), join(agent, "blobs")]);
    }
    if (names.length > 8) warnings.push("Only the first eight named OMP profiles are included; select other profiles under Advanced.");
  } catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) warnings.push(`OMP profiles: ${error instanceof Error ? error.message : "Unavailable"}`);
  }
  const roots: NativeSessionRoot[] = [];
  for (const candidate of candidates) {
    signal?.throwIfAborted();
    if (roots.length === 16) { warnings.push("Native location discovery reached its sixteen-root limit; configured roots take priority."); break; }
    try {
      if (forbidden.test(candidate.path) || await realpath(candidate.path) !== candidate.path) throw new Error("Native history location must not traverse symbolic links or authentication directories.");
      const directory = await openConfinedDirectory(candidate.path);
      await directory.close();
      const artifactRoots: string[] = [];
      for (const root of candidate.artifactRoots) {
        try {
          if (forbidden.test(root) || await realpath(root) !== root) throw new Error("Unsafe artifact directory.");
          const artifactDirectory = await openConfinedDirectory(root);
          await artifactDirectory.close();
          artifactRoots.push(root);
        } catch { warnings.push(`${candidate.profile}: artifact directory unavailable: ${root}`); }
      }
      roots.push({ ...candidate, artifactRoots });
    } catch (error) { warnings.push(`${candidate.profile}: ${candidate.path}: ${error instanceof Error ? error.message : "Native history location unavailable"}`); }
  }
  return { roots, warnings };
}

const SNAPSHOT_IDLE_MS = 30 * 60 * 1000;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_MANAGED_SNAPSHOT_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_MANAGED_SNAPSHOTS = 64;
interface NativeSnapshotEntry {
  source: NativeSessionSource;
  file: ConfinedNativeFile;
  digest: string;
  originalRevision: string;
  originalSize: number;
  timer: NodeJS.Timeout;
}
const snapshots = new Map<string, NativeSnapshotEntry>();
let snapshotBytes = 0;
let pendingSnapshots = 0;
function retainSnapshot(id: string, entry: NativeSnapshotEntry): void {
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    snapshots.delete(id);
    snapshotBytes -= entry.source.sizeBytes;
    void entry.file.snapshotFile?.close().catch(() => undefined);
  }, SNAPSHOT_IDLE_MS);
  entry.timer.unref();
}
function sameSourceAuthority(left: NativeSessionSource, right: NativeSessionSource): boolean {
  return left.engine === right.engine && left.sessionId === right.sessionId && left.cwd === right.cwd &&
    left.path === right.path && left.rootPath === right.rootPath && left.profile === right.profile &&
    JSON.stringify(left.artifactRoots) === JSON.stringify(right.artifactRoots);
}
function selectedSnapshot(source: NativeSessionSource): NativeSnapshotEntry {
  const id = source.snapshotId;
  const entry = id === undefined ? undefined : snapshots.get(id);
  if (id === undefined || !entry || !sameSourceAuthority(entry.source, source) || entry.source.sizeBytes !== source.sizeBytes || entry.source.revision !== source.revision) throw new Error("Native snapshot is expired, unknown, or does not match its original source authority. Capture it again.");
  retainSnapshot(id, entry);
  return entry;
}
async function originalNativeSource(source: NativeSessionSource, configuredRoots: NativeSessionRoot[], signal?: AbortSignal): Promise<NativeSessionSource> {
  const managedCheckpoint = /(?:^|[/\\])(?:native-imports?|checkpoints?|frozen)(?:[-_/\\]|$)/i.test(source.path) ||
    /(?:checkpoint|frozen)/i.test(source.profile);
  if (!managedCheckpoint) {
    try {
      await safePath(source.rootPath, source.path);
      return source;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  const locations = await nativeSessionLocations({ roots: configuredRoots }, signal);
  const roots = locations.roots.filter((root) => root.engine === source.engine);
  if (!managedCheckpoint && !roots.some((root) => root.path === source.rootPath)) {
    roots.push({ engine: source.engine, path: source.rootPath, profile: source.profile, artifactRoots: [...source.artifactRoots] });
  }
  if (!roots.length) throw new Error("Original native session locations are unavailable. Select its ordinary native source explicitly.");
  const discovered = await discoverNativeSessions({ roots, cursor: 0, limit: MAX_DISCOVERY_ENTRIES }, signal);
  if (discovered.incomplete) throw new Error("Original native source lookup exceeded its bounded discovery limit; select a narrower original source explicitly.");
  const matches = discovered.sessions.filter((candidate) => candidate.sessionId === source.sessionId && candidate.cwd === source.cwd &&
    !/(?:^|[/\\])(?:native-imports?|checkpoints?|frozen)(?:[-_/\\]|$)/i.test(candidate.path) && !/(?:checkpoint|frozen)/i.test(candidate.profile));
  if (matches.length > 1) throw new Error("More than one original native session matches this identity and workspace. Select the original source explicitly.");
  const match = matches[0];
  if (!match) throw new Error("The original native session is unavailable in known native locations. Frozen checkpoints are not refresh sources.");
  return match;
}
async function hashNativePrefix(file: FileHandle, size: number, signal?: AbortSignal): Promise<string> {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(NATIVE_SESSION_CHUNK_BYTES, size));
  for (let offset = 0; offset < size;) {
    signal?.throwIfAborted();
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (!bytesRead) throw new Error("Native session was truncated while capturing its immutable prefix.");
    digest.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return digest.digest("hex");
}
export async function snapshotNativeSession(input: NativeSnapshot, signal?: AbortSignal): Promise<NativeSessionSource> {
  signal?.throwIfAborted();
  if (!input.resolveOriginal && input.source.snapshotId !== undefined && snapshots.has(input.source.snapshotId)) {
    const entry = selectedSnapshot(input.source);
    return { ...entry.source, artifactRoots: [...entry.source.artifactRoots] };
  }
  const selected = input.resolveOriginal ? await originalNativeSource(input.source, input.roots ?? [], signal) : input.source;
  if (!selected.path.endsWith(".jsonl")) throw new Error("Only native JSONL session files can be selected.");
  const original = await safePath(selected.rootPath, selected.path);
  if (original.stat.size > MAX_SNAPSHOT_BYTES) throw new Error("Native session exceeds the 2 GiB managed snapshot limit.");
  if (snapshots.size + pendingSnapshots >= MAX_MANAGED_SNAPSHOTS || snapshotBytes + original.stat.size > MAX_MANAGED_SNAPSHOT_BYTES) throw new Error("Managed native snapshot capacity is busy. Retry after inactive snapshots expire.");
  pendingSnapshots++;
  snapshotBytes += original.stat.size;
  let file: FileHandle | undefined;
  let reserved = original.stat.size;
  let directory: string | undefined;
  try {
    const native = await openConfined(original);
    try {
      directory = await mkdtemp(join(tmpdir(), "bb-native-snapshot-"));
      const path = join(directory, "snapshot.jsonl");
      file = await open(path, "wx+", 0o600);
      await unlink(path);
      await rm(directory, { recursive: true });
      directory = undefined;
      const buffer = Buffer.allocUnsafe(NATIVE_SESSION_CHUNK_BYTES);
      const recordPieces: Buffer[] = [];
      let recordBytes = 0;
      let boundary = 0;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const validateRecord = () => {
        const bytes = Buffer.concat(recordPieces, recordBytes);
        const text = decoder.decode(bytes);
        if (text.trim()) parseNativeHistoryRecord(JSON.parse(text), 0);
      };
      for (let offset = 0; offset < original.stat.size;) {
        signal?.throwIfAborted();
        const { bytesRead } = await native.read(buffer, 0, Math.min(buffer.length, original.stat.size - offset), offset);
        if (!bytesRead) throw new Error("Native session was truncated while capturing its immutable prefix.");
        let written = 0;
        while (written < bytesRead) {
          const result = await file.write(buffer, written, bytesRead - written, offset + written);
          if (!result.bytesWritten) throw new Error("Managed native snapshot could not retain the source bytes.");
          written += result.bytesWritten;
        }
        let start = 0;
        while (start < bytesRead) {
          const newline = buffer.indexOf(10, start);
          const end = newline >= 0 && newline < bytesRead ? newline + 1 : bytesRead;
          recordPieces.push(Buffer.from(buffer.subarray(start, end)));
          recordBytes += end - start;
          if (recordBytes > MAX_RECORD_BYTES) throw new Error("Native JSONL record exceeds the bounded snapshot record limit.");
          if (newline >= 0 && newline < bytesRead) {
            validateRecord();
            boundary = offset + end;
            recordPieces.length = 0;
            recordBytes = 0;
          }
          start = end;
        }
        offset += bytesRead;
      }
      if (recordBytes > 0) {
        let value: unknown;
        let complete = false;
        try {
          value = JSON.parse(decoder.decode(Buffer.concat(recordPieces, recordBytes)));
          complete = true;
        } catch {}
        if (complete) {
          parseNativeHistoryRecord(value, 0);
          boundary = original.stat.size;
        }
      }
      if (boundary === 0) throw new Error("Native session has no complete JSONL records at the selected boundary.");
      await file.truncate(boundary);
      const digest = await hashNativePrefix(file, boundary, signal);
      const beforeValidation = await native.stat();
      if (beforeValidation.nlink !== 1 || beforeValidation.size < original.stat.size) throw new Error("Native session identity changed during snapshot capture.");
      const actual = await hashNativePrefix(native, boundary, signal);
      const afterValidation = await native.stat();
      if (actual !== digest || afterValidation.nlink !== 1 || afterValidation.size < beforeValidation.size || (afterValidation.size === beforeValidation.size && revision(afterValidation) !== revision(beforeValidation))) throw new Error("Native session prefix, including its header, changed during snapshot capture. Retry after the native writer finishes.");
      const current = await safePath(selected.rootPath, selected.path);
      if (current.stat.dev !== original.stat.dev || current.stat.ino !== original.stat.ino) throw new Error("Native source was replaced during snapshot capture.");
      const snapshotFile: ConfinedNativeFile = { path: selected.path, stat: await file.stat(), imageHash: null, snapshotFile: file };
      const described = await describeFile({ engine: selected.engine, path: selected.rootPath, profile: selected.profile, artifactRoots: selected.artifactRoots }, selected.path, snapshotFile);
      if (!described || described.sessionId !== selected.sessionId || described.cwd !== selected.cwd) throw new Error("Native snapshot identity or authoritative recorded workspace changed.");
      for (const [id, entry] of snapshots) {
        if (entry.digest === digest && sameSourceAuthority(entry.source, described)) {
          entry.originalRevision = revision(original.stat);
          entry.originalSize = original.stat.size;
          retainSnapshot(id, entry);
          return { ...entry.source, artifactRoots: [...entry.source.artifactRoots] };
        }
      }
      const snapshotId = randomUUID();
      const source: NativeSessionSource = { ...described, artifactRoots: [...described.artifactRoots], modifiedAt: original.stat.mtimeMs, snapshotId };
      const entry: NativeSnapshotEntry = { source, file: snapshotFile, digest, originalRevision: revision(original.stat), originalSize: original.stat.size, timer: setTimeout(() => undefined, 0) };
      snapshots.set(snapshotId, entry);
      retainSnapshot(snapshotId, entry);
      snapshotBytes -= reserved - boundary;
      reserved = 0;
      file = undefined;
      return { ...source, artifactRoots: [...source.artifactRoots] };
    } finally { await native.close(); }
  } finally {
    pendingSnapshots--;
    snapshotBytes -= reserved;
    await file?.close();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
}
export async function discoverNativeSessions(input: NativeDiscover, signal?: AbortSignal): Promise<NativeDiscovery> {
  const sessions: NativeSessionSource[] = [];
  const warnings: string[] = [];
  const candidates: { root: NativeSessionRoot; path: string; modifiedAt: number }[] = [];
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
          if (child.isDirectory() && entry.depth < 8 && !["node_modules", ".git", "subagents"].includes(child.name)) {
            if (root.engine === "omp") {
              try { if ((await lstat(`${path}.jsonl`)).isFile()) continue; }
              catch (error) {
                if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
                  warnings.push(`${root.profile}: Cannot inspect potential companion directory ${child.name}.`);
                  continue;
                }
              }
            }
            queue.push({ path, depth: entry.depth + 1 });
          } else if (child.isFile() && child.name.endsWith(".jsonl")) {
            try {
              const stat = await lstat(path);
              if (stat.isFile() && stat.nlink === 1) candidates.push({ root, path, modifiedAt: stat.mtimeMs });
            } catch (error) { warnings.push(`${basename(path)}: ${error instanceof Error ? error.message : "Unreadable session metadata"}`); }
          }
        }
      } catch (error) { signal?.throwIfAborted(); warnings.push(`${root.profile}: ${error instanceof Error ? error.message : "Source directory unavailable"}`); }
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
  candidates.sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path) || a.root.engine.localeCompare(b.root.engine));
  const end = Math.min(candidates.length, input.cursor + input.limit);
  for (let index = input.cursor; index < end; index++) {
    signal?.throwIfAborted();
    const candidate = candidates[index]!;
    try {
      const source = await describe(candidate.root, candidate.path);
      if (source) sessions.push(source);
      else warnings.push(`${basename(candidate.path)} has no supported native identity in its header; not imported.`);
    } catch (error) { signal?.throwIfAborted(); warnings.push(`${basename(candidate.path)}: ${error instanceof Error ? error.message : "Unreadable session"}`); }
  }
  signal?.throwIfAborted();
  return { sessions, warnings, incomplete, nextCursor: end < candidates.length ? end : null };
}
export async function readNativeSessionIdentity(source: NativeSessionSource, requireArchiveBoundary = false): Promise<NativeSessionSource> {
  if (!source.path.endsWith(".jsonl")) throw new Error("Only native JSONL session files can be selected.");
  const described = await describe({ engine: source.engine, path: source.rootPath, profile: source.profile, artifactRoots: source.artifactRoots }, source.path);
  if (!described || described.sessionId !== source.sessionId || described.cwd !== source.cwd) throw new Error("Native session identity or authoritative recorded workspace changed.");
  if (requireArchiveBoundary && source.snapshotId !== undefined) {
    const snapshot = selectedSnapshot(source);
    if (described.revision !== snapshot.originalRevision || described.sizeBytes !== snapshot.originalSize || snapshot.source.sizeBytes !== snapshot.originalSize) throw new Error("The original native session no longer matches its complete captured archive boundary. Refresh before requesting native admission.");
  }
  return described;
}
async function readNativeSpill(source: ConfinedNativeFile, roots: string[], id: string, toolName: string, offset: number, length: number, expected: string | null, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof readRange>>> {
  const stem = source.path.slice(0, -".jsonl".length);
  const authorized = roots.filter((root) => isAbsolute(root) && (resolve(root) === stem || contained(resolve(root), stem)));
  if (!authorized.length || forbidden.test(stem)) throw new Error("Native spill directory is outside the explicitly selected artifact roots.");
  const directory = await openConfinedDirectory(stem);
  try {
    const stamp = revision(await directory.stat());
    const key = JSON.stringify([stem, stamp]);
    let names = spillDirectories.get(key);
    if (names === undefined) {
      names = new Map<string, string | null>();
      const entries = await opendir(`${descriptorRoot}/${directory.fd}`);
      let visited = 0;
      for await (const entry of entries) {
        signal?.throwIfAborted();
        if (++visited > MAX_DISCOVERY_ENTRIES) throw new Error("Native spill directory exceeds the bounded lookup limit.");
        const match = /^(0|[1-9][0-9]*)\.[A-Za-z0-9_-]{1,64}(?:-original)?\.log$/u.exec(entry.name);
        const artifactId = match?.[1];
        if (artifactId !== undefined && match?.[0] === entry.name) names.set(artifactId, names.has(artifactId) ? null : entry.name);
      }
      if (revision(await directory.stat()) !== stamp) throw new Error("Native spill directory changed during lookup.");
      spillDirectories.set(key, names);
      if (spillDirectories.size > MAX_SPILL_DIRECTORIES) {
        const oldest = spillDirectories.keys().next().value;
        if (oldest !== undefined) spillDirectories.delete(oldest);
      }
    }
    const name = names.get(id);
    if (name === null) throw new Error("Native spill ID is ambiguous in the selected session directory.");
    if (name === undefined || (name !== `${id}.${toolName}-original.log` && name !== `${id}.${toolName}.log`)) throw new Error("No unique retained spill matches the selected native tool result.");
    const path = resolve(stem, name);
    let artifact: ConfinedNativeFile | null = null;
    for (const root of authorized) {
      try { artifact = await safePath(root, path); break; } catch { continue; }
    }
    if (artifact === null) throw new Error("Native spill is not a confined, unshared retained log.");
    const result = await readRange(artifact, offset, length, expected, signal, directory);
    if (revision(await directory.stat()) !== stamp) throw new Error("Native spill directory changed during read.");
    return result;
  } finally { await directory.close(); }
}
export async function readNativeSession(input: NativeRead, signal?: AbortSignal): Promise<NativeChunk> {
  signal?.throwIfAborted();
  const snapshot = input.source.snapshotId === undefined ? null : selectedSnapshot(input.source);
  const source = snapshot?.file ?? await safePath(input.source.rootPath, input.source.path);
  if (!source.path.endsWith(".jsonl")) throw new Error("Only native JSONL session files can be selected.");
  if (source.stat.size !== input.source.sizeBytes) throw new Error("Selected native size does not match the authoritative source boundary.");
  if (snapshot === null && input.offset === 0 && input.artifact === null) {
    const described = await readNativeSessionIdentity(input.source);
    if (described.revision !== input.source.revision || described.sizeBytes !== input.source.sizeBytes) throw new Error("Selected native source boundary does not match the source file.");
  }
  let selected = source;
  let expected: string | null = input.source.revision;
  let spillResult: Awaited<ReturnType<typeof readRange>> | null = null;
  if (input.artifact) {
    const proof = input.artifact;
    if (proof.recordLength > MAX_RECORD_BYTES) throw new Error("Artifact reference record exceeds the bounded native record limit.");
    const record = await readRange(source, proof.recordOffset, proof.recordLength, input.source.revision);
    if (createHash("sha256").update(record.bytes).digest("hex") !== proof.recordSha256) throw new Error("Artifact reference does not match its native source record.");
    if (record.bytes.length !== proof.recordLength) throw new Error("Artifact authority exceeds the native record boundary.");
    await assertRecordBoundary(source, proof.recordOffset, record.bytes, signal);
    const parsed = parseNativeHistoryRecord(JSON.parse(record.bytes.toString("utf8")), 0);
    if (!parsed.artifacts.includes(proof.reference)) throw new Error("Artifact was not referenced by the selected structured native record.");
    if (proof.reference.endsWith(".jsonl") || forbidden.test(proof.reference)) throw new Error("Authentication/configuration files and neighboring sessions are not native artifacts.");
    const imageHash = input.source.engine === "omp" && nativeOmpImageReferences(parsed.state).includes(proof.reference) ? proof.reference : null;
    if (imageHash !== null && snapshot === null) await readNativeSessionIdentity(input.source);
    if (proof.reference.startsWith("artifact://")) {
      const spill = input.source.engine === "omp" ? nativeOmpSpillReferences(parsed.state).find((entry) => entry.reference === proof.reference) : undefined;
      if (spill === undefined) throw new Error("Numeric spill authority must belong to the selected native OMP tool result.");
      if (snapshot === null) await readNativeSessionIdentity(input.source);
      spillResult = await readNativeSpill(source, input.source.artifactRoots, spill.id, spill.toolName, input.offset, input.length, proof.revision, signal);
    } else {
      let artifact: ConfinedNativeFile | null = null;
      for (const root of input.source.artifactRoots) {
        const candidate = isAbsolute(proof.reference) ? proof.reference : resolve(root, proof.reference);
        if (!contained(resolve(root), candidate)) continue;
        try { artifact = await safePath(root, candidate, imageHash); break; } catch { continue; }
      }
      if (artifact === null) throw new Error("Referenced artifact is missing or outside the explicitly selected artifact roots.");
      selected = artifact;
    }
    expected = proof.revision;
  }
  const result = spillResult ?? await readRange(selected, input.offset, input.length, expected, signal);
  signal?.throwIfAborted();
  return { content: result.bytes.toString("base64"), offset: input.offset, sizeBytes: result.size, revision: result.revision, sha256: createHash("sha256").update(result.bytes).digest("hex") };
}
