import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, realpath, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { parseNativeHistoryRecord } from "@bb/domain";
import type { NativeChunk, NativeDiscover, NativeDiscovery, NativeRead, NativeSessionRoot, NativeSessionSource } from "@bb/host-daemon-contract";

const HEADER_BYTES = 1024 * 1024;
const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const MAX_DISCOVERY_ENTRIES = 20_000;
const forbidden = /(?:^|[/\\])(?:\.?auth(?:\.db(?:-wal|-shm)?|\.json)?|\.?credentials?[^/\\]*|keychain[^/\\]*|\.env(?:\.[^/\\]*)?|\.?mcp(?:\.json)?|\.npmrc|\.netrc|\.pypirc|\.yarnrc(?:\.yml)?|settings\.json|config\.toml|\.ssh|\.aws|\.gnupg|\.docker|\.kube|\.git-credentials|id_rsa|id_ed25519|tokens?[^/\\]*|secrets?)(?:$|[/\\])/i;
function contained(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}
interface ConfinedNativeFile { path: string; stat: Stats }
async function safePath(root: string, path: string): Promise<ConfinedNativeFile> {
  if (!isAbsolute(root) || !isAbsolute(path) || !contained(resolve(root), resolve(path)) || forbidden.test(path)) throw new Error("Select a session or referenced artifact inside its explicit source root, not an authentication/configuration file.");
  const canonicalRoot = await realpath(root);
  const canonical = await realpath(path);
  if (canonicalRoot !== resolve(root) || canonical !== resolve(path) || !contained(canonicalRoot, canonical)) throw new Error("Native source paths may not traverse symbolic links.");
  const stat = await lstat(canonical);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("Native sources must be regular, unshared files.");
  return { path: canonical, stat };
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
      if (!opened.isFile() || opened.nlink !== 1 || revision(opened) !== revision(source.stat)) throw new Error("Native source identity changed between validation and confined open.");
      return file;
    } catch (error) { await file.close(); throw error; }
  } finally { await directory.close(); }
}
function revision(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}
async function readRange(source: ConfinedNativeFile, offset: number, length: number, expected: string | null): Promise<{ bytes: Buffer; size: number; revision: string; modifiedAt: number }> {
  const file = await openConfined(source);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1) throw new Error("Native source is not a private regular file.");
    const stamp = revision(before);
    if (expected !== null && expected !== stamp) throw new Error("Native source changed. Discover it again; committed prefixes will be verified before resuming.");
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
    let artifact: ConfinedNativeFile | null = null;
    for (const root of input.source.artifactRoots) {
      const candidate = isAbsolute(proof.reference) ? proof.reference : resolve(root, proof.reference);
      if (!contained(resolve(root), candidate)) continue;
      try { artifact = await safePath(root, candidate); break; } catch { continue; }
    }
    if (artifact === null) throw new Error("Referenced artifact is missing or outside the explicitly selected artifact roots.");
    selected = artifact;
    expected = proof.revision;
  }
  const result = await readRange(selected, input.offset, input.length, expected);
  signal?.throwIfAborted();
  return { content: result.bytes.toString("base64"), offset: input.offset, sizeBytes: result.size, revision: result.revision, sha256: createHash("sha256").update(result.bytes).digest("hex") };
}
