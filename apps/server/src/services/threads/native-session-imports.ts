import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, type FileHandle } from "node:fs/promises";
import { join, posix } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  createThread, events as storedEvents, getLatestThreadSequence, getThread, insertEvents, noopNotifier, patchThreadPluginMetadata, threadPluginMetadata,
  upsertThreadSearchSegments, type DbConnection, type DbNotifier,
} from "@bb/db";
import { parseNativeHistoryRecord, threadEventItemSchema, type NativeHistoryRecord } from "@bb/domain";
import { NATIVE_SESSION_CHUNK_BYTES, type NativeChunk, type NativeRead } from "@bb/host-daemon-contract";
import {
  nativeImportManifestSchema, nativeImportRecordSchema, type NativeImportBytes,
  type NativeImportManifest, type NativeImportPage, type NativeImportPageResponse,
  type NativeImportRecord, type NativeImportSelection,
} from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import { nativeHistoryEvents } from "./native-history-projection.js";

import { NATIVE_HISTORY_OWNER } from "@bb/domain";
const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export interface NativeImportDependencies {
  db: DbConnection;
  hub: DbNotifier;
  dataDir: string;
  read(hostId: string, input: NativeRead, signal: AbortSignal): Promise<NativeChunk>;
}
export function nativeImportIdentity(selection: NativeImportSelection): string {
  return hash(JSON.stringify([selection.hostId, selection.source.engine, posix.normalize(selection.source.path), selection.source.sessionId, selection.projectId]));
}
export function nativeWriterNamespace(manifest: NativeImportManifest): string {
  return hash(JSON.stringify([manifest.hostId, manifest.source.engine, posix.normalize(manifest.source.path), manifest.source.sessionId]));
}
async function writeAll(file: FileHandle, bytes: Buffer, offset: number): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const result = await file.write(bytes, written, bytes.length - written, offset + written);
    if (!result.bytesWritten) throw new Error("Native archive write made no progress.");
    written += result.bytesWritten;
  }
}
async function atomicJson(path: string, value: NativeImportManifest | NativeImportRecord): Promise<void> {
  const temporary = `${path}.pending`;
  const handle = await open(temporary, "w", 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
  const directory = await open(join(path, ".."), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "Native import failed"; }
export class NativeSessionImports {
  private readonly running = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private readonly transitions = new Map<string, Promise<void>>();
  async exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    this.directory(id);
    const previous = this.transitions.get(id) ?? Promise.resolve();
    let release = () => {};
    const next = new Promise<void>((resolve) => { release = resolve; });
    this.transitions.set(id, next);
    await previous;
    try { return await work(); }
    finally { release(); if (this.transitions.get(id) === next) this.transitions.delete(id); }
  }
  private readonly root: string;
  constructor(private readonly deps: NativeImportDependencies) { this.root = join(deps.dataDir, "native-session-imports"); }
  directory(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new ApiError(400, "invalid_request", "Invalid native import identity");
    return join(this.root, id);
  }
  private async save(manifest: NativeImportManifest): Promise<void> {
    manifest.updatedAt = Date.now();
    await atomicJson(join(this.directory(manifest.id), "manifest.json"), manifest);
    if (manifest.threadId) {
      patchThreadPluginMetadata(this.deps.db, { threadId: manifest.threadId, pluginId: NATIVE_HISTORY_OWNER, remove: [], set: {
        importId: manifest.id, mode: manifest.mode, importStatus: manifest.status,
        nativeSessionId: manifest.source.sessionId, sourceHostId: manifest.hostId,
        source: manifest.source, attemptedSource: manifest.attemptedSource,
        nativeNamespace: nativeWriterNamespace(manifest), reason: manifest.reason,
      } });
    }
  }
  async get(id: string): Promise<NativeImportManifest> {
    let bytes: string;
    try { bytes = await readFile(join(this.directory(id), "manifest.json"), "utf8"); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") throw new ApiError(404, "invalid_request", "Native import not found");
      throw error;
    }
    const manifest = nativeImportManifestSchema.parse(JSON.parse(bytes));
    if (manifest.status === "importing" && !this.running.has(id)) manifest.status = "paused";
    return manifest;
  }
  async start(selection: NativeImportSelection): Promise<NativeImportManifest> {
    return this.exclusive(nativeImportIdentity(selection), () => this.startSelected(selection));
  }
  private async startSelected(selection: NativeImportSelection): Promise<NativeImportManifest> {
    const id = nativeImportIdentity(selection);
    await mkdir(join(this.directory(id), "records"), { recursive: true, mode: 0o700 });
    let manifest: NativeImportManifest;
    try { manifest = await this.get(id); }
    catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
      manifest = { version: 1, id, ...selection, attemptedSource: null, threadId: null, status: "paused", mode: "archive", continuationThreadId: null,
        reason: "Archive only. Native continuation requires a separate provider-controlled exclusive admission; no agent was started.",
        error: null, bytes: 0, records: 0, nextSequence: 1, sha256: null, boundaryBytes: 0, boundarySha256: null,
        createdAt: Date.now(), updatedAt: Date.now(), artifacts: [] };
      await this.save(manifest);
    }
    if (this.running.has(id)) return manifest;
    if (manifest.mode !== "archive" && manifest.source.revision !== selection.source.revision) throw new ApiError(409, "invalid_request", "An admitted or handed-off source cannot be rewritten. Its retained archive remains unchanged.");
    if (selection.source.sizeBytes < manifest.bytes) throw new ApiError(409, "invalid_request", "Native source is shorter than the committed archive; original data will not be overwritten.");
    if (manifest.status === "ready" && manifest.source.revision === selection.source.revision && manifest.source.path === selection.source.path && JSON.stringify(manifest.source.artifactRoots) === JSON.stringify(selection.source.artifactRoots) && manifest.artifacts.every((entry) => entry.status === "ready")) return manifest;
    manifest.attemptedSource = selection.source;
    manifest.status = "paused";
    manifest.error = null;
    await this.save(manifest);
    return this.resumeSelected(id);
  }
  async resume(id: string): Promise<NativeImportManifest> { return this.exclusive(id, () => this.resumeSelected(id)); }
  private async resumeSelected(id: string): Promise<NativeImportManifest> {
    const manifest = await this.get(id);
    if (this.running.has(id) || manifest.status === "ready") return manifest;
    if (manifest.mode !== "archive") throw new ApiError(409, "invalid_request", "Only an archive import can be resumed.");
    const controller = new AbortController();
    manifest.status = "importing";
    manifest.error = null;
    const entry = { controller, promise: Promise.resolve() };
    this.running.set(id, entry);
    entry.promise = this.save(manifest).then(() => this.run(manifest, controller.signal)).catch(async (error: unknown) => {
      manifest.status = controller.signal.aborted ? "cancelled" : "failed";
      manifest.error = controller.signal.aborted ? null : errorMessage(error);
      await this.save(manifest);
    }).finally(() => { this.running.delete(id); });
    return manifest;
  }
  async cancel(id: string): Promise<NativeImportManifest> { return this.exclusive(id, () => this.cancelSelected(id)); }
  private async cancelSelected(id: string): Promise<NativeImportManifest> {
    const entry = this.running.get(id);
    if (entry) { entry.controller.abort(); await entry.promise; }
    const manifest = await this.get(id);
    if (manifest.status !== "ready") { manifest.status = "cancelled"; await this.save(manifest); }
    return manifest;
  }
  async settle(id: string): Promise<NativeImportManifest> {
    await this.running.get(id)?.promise;
    return this.get(id);
  }
  async dispose(): Promise<void> {
    const entries = [...this.running.values()];
    for (const entry of entries) entry.controller.abort();
    await Promise.all(entries.map((entry) => entry.promise));
  }
  private async read(manifest: NativeImportManifest, offset: number, length: number, signal: AbortSignal, artifact: NativeRead["artifact"] = null): Promise<NativeChunk> {
    signal.throwIfAborted();
    const source = manifest.attemptedSource ?? manifest.source;
    const result = await this.deps.read(manifest.hostId, { source, offset, length, artifact }, signal);
    if (artifact === null && (result.sizeBytes !== source.sizeBytes || result.revision !== source.revision)) throw new Error("Native source returned a different authoritative boundary.");
    const bytes = Buffer.from(result.content, "base64");
    if (result.offset !== offset || bytes.length > length || hash(bytes) !== result.sha256 || (!bytes.length && offset < result.sizeBytes)) throw new Error("Native transfer checksum, offset or progress validation failed.");
    return result;
  }
  private async run(manifest: NativeImportManifest, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await this.read(manifest, 0, 1, signal);
    const directory = this.directory(manifest.id);
    const path = join(directory, "native.jsonl");
    const digest = createHash("sha256");
    if (manifest.bytes > 0) {
      const file = await open(path, "r");
      try {
        for (let offset = 0; offset < manifest.bytes;) {
          const length = Math.min(NATIVE_SESSION_CHUNK_BYTES, manifest.bytes - offset);
          const remote = Buffer.from((await this.read(manifest, offset, length, signal)).content, "base64");
          const local = Buffer.alloc(length);
          const result = await file.read(local, 0, length, offset);
          if (result.bytesRead !== length || !local.equals(remote)) throw new Error("Native source prefix differs from the committed archive. Existing history was preserved; refusing resume.");
          digest.update(local);
          offset += length;
        }
      } finally { await file.close(); }
      if (digest.copy().digest("hex") !== manifest.boundarySha256) throw new Error("Committed native archive checksum mismatch.");
    }
    if (manifest.attemptedSource !== null) {
      manifest.source = manifest.attemptedSource;
      manifest.attemptedSource = null;
      await this.save(manifest);
    }
    for (const artifact of manifest.artifacts.filter((entry) => entry.status === "unavailable")) {
      const record = nativeImportRecordSchema.parse(JSON.parse(await readFile(join(directory, "records", `${artifact.recordOrdinal}.json`), "utf8")));
      if (!record.artifactReferences.includes(artifact.reference)) throw new Error("Retained artifact provenance does not match its source record.");
      await this.copyArtifact(manifest, record, artifact.reference, signal);
    }
    if (manifest.threadId === null) {
      const recovered = this.deps.db.select({ threadId: threadPluginMetadata.threadId }).from(threadPluginMetadata).where(and(
        eq(threadPluginMetadata.pluginId, NATIVE_HISTORY_OWNER), sql`json_extract(${threadPluginMetadata.metadataJson}, '$.importId') = ${manifest.id}`,
      )).limit(2).all();
      if (recovered.length > 1) throw new Error("Multiple Core threads claim this import; refusing an ambiguous recovery.");
      manifest.threadId = recovered[0]?.threadId ?? createThread(this.deps.db, this.deps.hub, {
        projectId: manifest.projectId, providerId: manifest.source.engine === "omp" ? "acp-omp" : manifest.source.engine === "claude" ? "claude-code" : "codex",
        title: manifest.source.title, status: "idle", originPluginId: NATIVE_HISTORY_OWNER,
        pluginMetadata: { pluginId: NATIVE_HISTORY_OWNER, metadata: { importId: manifest.id, mode: "archive", importStatus: "importing" } },
      }).id;
      await this.save(manifest);
    }
    if (!getThread(this.deps.db, manifest.threadId)) throw new Error("Imported Core thread no longer exists.");
    const output = await open(path, manifest.bytes === 0 ? "w" : "r+", 0o600);
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let readOffset = manifest.bytes;
    const commit = async (line: Buffer) => {
      signal.throwIfAborted();
      if (!line.length) return;
      let record: NativeHistoryRecord | null = null;
      if (line.toString("utf8").trim()) record = parseNativeHistoryRecord(JSON.parse(line.toString("utf8")), manifest.records + 1);
      if (record?.sessionId && record.sessionId !== manifest.source.sessionId) throw new Error("Native source session identity changed inside the selected stream.");
      const ordinal = manifest.records + 1;
      const projected = record ? nativeHistoryEvents({ importId: manifest.id, threadId: manifest.threadId!, sessionId: manifest.source.sessionId,
        ordinal, sequence: 0, record, recordSha256: hash(line), fallbackTimestamp: manifest.source.modifiedAt,
        toolContext: (itemId) => {
          const previous = this.deps.db.select({ data: storedEvents.data }).from(storedEvents).where(and(eq(storedEvents.threadId, manifest.threadId!), eq(storedEvents.itemId, itemId), eq(storedEvents.type, "item/started"))).orderBy(storedEvents.sequence).limit(1).get();
          if (!previous) return null;
          const item = z.object({ item: threadEventItemSchema }).parse(JSON.parse(previous.data)).item;
          return item.type === "toolCall" ? item : null;
        },
      }) : [];
      const { start, eventCount } = this.deps.db.transaction(() => {
        const first = projected[0];
        const recovered = first ? this.deps.db.select({ sequence: storedEvents.sequence, sha256: sql<string>`json_extract(${storedEvents.data}, '$.nativeImportRecord.sha256')`, count: sql<number>`json_extract(${storedEvents.data}, '$.nativeImportRecord.eventCount')` }).from(storedEvents).where(and(eq(storedEvents.threadId, manifest.threadId!), eq(storedEvents.itemId, first.itemId!), sql`json_extract(${storedEvents.data}, '$.nativeImportRecord.importId') = ${manifest.id}`, sql`json_extract(${storedEvents.data}, '$.nativeImportRecord.ordinal') = ${ordinal}`)).limit(1).get() : undefined;
        if (recovered && (recovered.sha256 !== hash(line) || recovered.count !== projected.length)) throw new Error("A staged native record changed after Core projection. Existing history was retained; refusing to replace its committed events.");
        const start = recovered?.sequence ?? Math.max(manifest.nextSequence, getLatestThreadSequence(this.deps.db, { threadId: manifest.threadId! }) + 1);
        const prepared = projected.map((event, index) => ({ ...event, sequence: start + index }));
        let inserted = 0;
        for (let index = 0; index < prepared.length; index += 100) inserted += insertEvents(this.deps.db, noopNotifier, prepared.slice(index, index + 100)).insertedCount;
        if (inserted !== (recovered ? 0 : prepared.length)) throw new Error("Native history collided with unrelated Core sequences; no record was silently skipped.");
        if (record) upsertThreadSearchSegments(this.deps.db, { segments: record.parts.flatMap((part, index) => part.kind === "user" || part.kind === "assistant" ? [{ threadId: manifest.threadId!, sourceKind: part.kind === "user" ? "user_message" as const : "assistant_message" as const, sourceKey: `native:${ordinal}:${index}`, sourceSeq: start + index, text: part.text }] : []) });
        return { start, eventCount: prepared.length };
      }, { behavior: "immediate" });
      if (eventCount) this.deps.hub.notifyThread(manifest.threadId!, ["events-appended"], { timelineSequence: getLatestThreadSequence(this.deps.db, { threadId: manifest.threadId! }) });
      const metadata: NativeImportRecord = { ordinal, offset: manifest.bytes, length: line.length, sha256: hash(line),
        nativeId: record?.id ?? null, parentId: record?.parentId ?? null, type: record?.type ?? "native-blank",
        timestamp: record?.timestamp ?? null, sourceSeqStart: start, sourceSeqEnd: start + eventCount,
        preview: record?.parts.map((part) => part.text || part.name || part.kind).join("\n").slice(0, 1024) ?? "", artifactReferences: record?.artifacts ?? [] };
      await atomicJson(join(directory, "records", `${ordinal}.json`), metadata);
      if (record) for (const reference of record.artifacts) await this.copyArtifact(manifest, metadata, reference, signal);
      digest.update(line);
      await output.sync();
      manifest.bytes += line.length;
      manifest.boundaryBytes = manifest.bytes;
      manifest.boundarySha256 = digest.copy().digest("hex");
      manifest.records = ordinal;
      manifest.nextSequence = start + eventCount;
      await this.save(manifest);
    };
    try {
      await output.truncate(manifest.bytes);
      while (readOffset < manifest.source.sizeBytes) {
        signal.throwIfAborted();
        const chunk = await this.read(manifest, readOffset, Math.min(NATIVE_SESSION_CHUNK_BYTES, manifest.source.sizeBytes - readOffset), signal);
        const bytes = Buffer.from(chunk.content, "base64");
        if (chunk.sizeBytes !== manifest.source.sizeBytes) throw new Error("Native source boundary changed during import.");
        await writeAll(output, bytes, readOffset);
        readOffset += bytes.length;
        let start = 0;
        for (let index = 0; index < bytes.length; index++) if (bytes[index] === 10) {
          const segment = bytes.subarray(start, index + 1);
          pending.push(segment); pendingBytes += segment.length;
          if (pendingBytes > MAX_RECORD_BYTES) throw new Error("Native record exceeds the 64 MiB parsing boundary. The committed archive is retained; no partial record was projected.");
          await commit(Buffer.concat(pending, pendingBytes));
          pending = []; pendingBytes = 0; start = index + 1;
        }
        if (start < bytes.length) { const remainder = bytes.subarray(start); pending.push(remainder); pendingBytes += remainder.length; }
        if (pendingBytes > MAX_RECORD_BYTES) throw new Error("Native record exceeds the 64 MiB parsing boundary. No record was silently truncated.");
      }
      if (pendingBytes) await commit(Buffer.concat(pending, pendingBytes));
      manifest.sha256 = digest.digest("hex");
      manifest.status = "ready";
      await this.save(manifest);
    } finally { await output.close(); }
  }
  private async copyArtifact(manifest: NativeImportManifest, record: NativeImportRecord, reference: string, signal: AbortSignal): Promise<void> {
    const existing = manifest.artifacts.find((entry) => entry.reference === reference);
    if (existing?.status === "ready") return;
    const file = `artifact-${hash(reference)}`;
    const path = join(this.directory(manifest.id), file);
    const output = await open(path, "w", 0o600);
    const digest = createHash("sha256");
    let offset = 0;
    let size = 0;
    let revision: string | null = null;
    try {
      do {
        const chunk = await this.read(manifest, offset, NATIVE_SESSION_CHUNK_BYTES, signal, {
          reference, recordOffset: record.offset, recordLength: record.length, recordSha256: record.sha256, revision,
        });
        if (revision !== null && (chunk.revision !== revision || chunk.sizeBytes !== size)) throw new Error("Referenced native artifact changed during import.");
        revision = chunk.revision; size = chunk.sizeBytes;
        const bytes = Buffer.from(chunk.content, "base64");
        await writeAll(output, bytes, offset);
        digest.update(bytes); offset += bytes.length;
      } while (offset < size);
      await output.sync();
      const result: NativeImportManifest["artifacts"][number] = { reference, recordOrdinal: record.ordinal, file, bytes: size, sha256: digest.digest("hex"), status: "ready", reason: null };
      if (existing) Object.assign(existing, result); else manifest.artifacts.push(result);
    } catch (error) {
      signal.throwIfAborted();
      const result: NativeImportManifest["artifacts"][number] = { reference, recordOrdinal: record.ordinal, file, bytes: offset, sha256: null, status: "unavailable", reason: errorMessage(error) };
      if (existing) Object.assign(existing, result); else manifest.artifacts.push(result);
    } finally { await output.close(); }
  }
  async records(input: NativeImportPage): Promise<NativeImportPageResponse> {
    const manifest = await this.get(input.importId);
    const records: NativeImportRecord[] = [];
    let ordinal = input.after + 1;
    const end = Math.min(manifest.records, input.after + 1000);
    const query = input.query.toLocaleLowerCase();
    for (; ordinal <= end && records.length < input.limit; ordinal++) {
      const record = nativeImportRecordSchema.parse(JSON.parse(await readFile(join(this.directory(input.importId), "records", `${ordinal}.json`), "utf8")));
      if (query) {
        const bytes = await this.recordBytes(input.importId, record);
        if (!bytes.toString("utf8").trim()) continue;
        const parsed = parseNativeHistoryRecord(JSON.parse(bytes.toString("utf8")), ordinal);
        if (![bytes.toString("utf8"), ...parsed.parts.map((part) => part.text)].some((text) => text.toLocaleLowerCase().includes(query))) continue;
      }
      records.push(record);
    }
    return { records, nextAfter: ordinal <= manifest.records ? ordinal - 1 : null };
  }
  private async recordBytes(id: string, record: NativeImportRecord): Promise<Buffer> {
    const file = await open(join(this.directory(id), "native.jsonl"), "r");
    try {
      const bytes = Buffer.alloc(record.length);
      const result = await file.read(bytes, 0, bytes.length, record.offset);
      if (result.bytesRead !== bytes.length || hash(bytes) !== record.sha256) throw new Error("Native archive record checksum mismatch.");
      return bytes;
    } finally { await file.close(); }
  }
  async bytes(input: NativeImportBytes): Promise<{ content: string; sizeBytes: number; offset: number; sha256: string }> {
    const manifest = await this.get(input.importId);
    const artifact = manifest.artifacts.find((entry) => entry.file === input.file && entry.status === "ready");
    if (input.file !== "native" && !artifact) throw new ApiError(404, "invalid_request", "Retained native artifact is unavailable");
    const sizeBytes = artifact?.bytes ?? manifest.bytes;
    const file = await open(join(this.directory(input.importId), input.file === "native" ? "native.jsonl" : input.file), "r");
    try {
      const bytes = Buffer.alloc(Math.min(input.length, Math.max(0, sizeBytes - input.offset)));
      const result = await file.read(bytes, 0, bytes.length, input.offset);
      if (result.bytesRead !== bytes.length) throw new Error("Native archive file is incomplete.");
      return { content: bytes.toString("base64"), sizeBytes, offset: input.offset, sha256: hash(bytes) };
    } finally { await file.close(); }
  }
  async download(id: string, name: string): Promise<Response> {
    const manifest = await this.get(id);
    const artifact = manifest.artifacts.find((entry) => entry.file === name && entry.status === "ready");
    if (name !== "native" && !artifact) throw new ApiError(404, "invalid_request", "Native archive artifact not found");
    const size = artifact?.bytes ?? manifest.bytes;
    const file = await open(join(this.directory(id), name === "native" ? "native.jsonl" : name), "r");
    let offset = 0;
    let closed = false;
    const close = async () => { if (!closed) { closed = true; await file.close(); } };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (offset >= size) { await close(); controller.close(); return; }
          const bytes = new Uint8Array(Math.min(NATIVE_SESSION_CHUNK_BYTES, size - offset));
          const result = await file.read(bytes, 0, bytes.length, offset);
          if (result.bytesRead !== bytes.length) throw new Error("Native archive download is incomplete");
          offset += bytes.length; controller.enqueue(bytes);
        } catch (error) { await close(); controller.error(error); }
      },
      cancel: close,
    });
    return new Response(body, { headers: { "cache-control": "private, no-store", "content-type": name === "native" ? "application/x-ndjson" : "application/octet-stream", "content-length": String(size), "content-disposition": `attachment; filename="${name === "native" ? "native-session.jsonl" : name}"`, "x-content-type-options": "nosniff" } });
  }
  async updateMode(manifest: NativeImportManifest): Promise<NativeImportManifest> { await this.save(manifest); return manifest; }
}
