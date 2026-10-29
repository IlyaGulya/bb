import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  CAPTURE_CHUNK_BYTES, captureAckSchema, captureManifestSchema, captureOutboxStatusSchema,
  CAPTURE_MAX_ARTIFACT_BYTES,
  captureSessionSchema, type CaptureManifest, type CaptureSession, type CaptureOutboxStatus,
  captureReportedModels, captureDigestSchema,
} from "@bb/domain";
import type { CaptureExchangeCommand, CaptureExchangeResult } from "@bb/host-daemon-contract";
import {
  CaptureStorageError, captureObjectDigest, capturePreparePayload, capturePrivateDirectory,
  captureReadPrivate, captureSha256, captureSyncDirectory, captureWritePrivate,
  captureReadEncrypted, captureWriteEncrypted, captureCipherContext, captureEncryptedSize,
} from "@bb/process-utils";

const historicalRejectionSchema = z.object({
  captureId: z.string().uuid(), artifactId: captureDigestSchema,
  storedSha256: captureDigestSchema, reason: z.literal("privacy_rejected"),
}).strict();
const stateSchema = z.object({
  writerVersion: z.literal(2).optional(),
  leaseUntil: z.number().int().nonnegative(),
  nextScanAt: z.number().int().nonnegative(),
  cursors: z.record(z.string(), z.object({ identity: z.string(), offset: z.number().int().nonnegative() }).strict()),
  status: captureOutboxStatusSchema,
}).strict();
const ackListSchema = z.array(captureAckSchema).max(256);
type OutboxState = z.infer<typeof stateSchema>;
type PendingChunk = { manifest: CaptureManifest; chunk: NonNullable<CaptureExchangeResult["chunk"]> };
const lanes = ["runtime→bridge", "bridge→runtime", "provider→bridge", "bridge→provider"] as const;
const instances = new Map<string, HostCaptureOutbox>();
const stoppedDirectories = new Set<string>();
const MAX_HOST_BYTES = 512 * 1024 * 1024;
const MAX_HOST_SESSIONS = 32;

function instance(dataDir: string): HostCaptureOutbox {
  const key = resolve(dataDir);
  let value = instances.get(key);
  if (!value) { value = new HostCaptureOutbox(key); instances.set(key, value); }
  return value;
}
async function names(directory: string, pattern: RegExp, maximum: number): Promise<string[]> {
  const result: string[] = [];
  const directoryHandle = await opendir(directory);
  for await (const entry of directoryHandle) {
    if (!entry.isDirectory() || !pattern.test(entry.name)) continue;
    if (result.length >= maximum) throw new CaptureStorageError("source_limit");
    result.push(entry.name);
  }
  return result.sort();
}
const uuidPattern = /^[a-f0-9-]{36}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
function emptyStatus(): CaptureOutboxStatus {
  return { pendingBytes: 0, pendingChunks: 0, artifacts: 0, lastAckAt: null, gap: "none", droppedBytes: 0 };
}
function sourceGap(error: unknown): CaptureOutboxStatus["gap"] {
  if (error instanceof CaptureStorageError) return error.code;
  return "source_unavailable";
}
function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
async function optionalStat(path: string) {
  return lstat(path).catch(error => { if (missing(error)) return null; throw error; });
}

class HostCaptureOutbox {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly failures = new Map<string, CaptureOutboxStatus["gap"]>();
  constructor(private readonly dataDir: string) {}
  exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(run, run);
    this.tail = next.catch(() => {});
    return next;
  }
  async exchange(command: CaptureExchangeCommand): Promise<CaptureExchangeResult> {
    const session = command.session;
    const root = await capturePrivateDirectory(this.dataDir, "host");
    const sessions = await names(root, uuidPattern, MAX_HOST_SESSIONS);
    if (!sessions.includes(session.id) && sessions.length >= MAX_HOST_SESSIONS) throw new CaptureStorageError("source_limit");
    const directory = await capturePrivateDirectory(this.dataDir, "host", session.id);
    const previous = await this.readSession(directory);
    if (previous && captureObjectDigest({ ...previous, enabled: true }) !== captureObjectDigest({ ...session, enabled: true })) throw new CaptureStorageError("integrity");
    await captureWritePrivate(directory, "session.json", Buffer.from(JSON.stringify(session)), true);
    const state = await this.readState(directory);
    state.leaseUntil = Math.min(command.leaseUntil, session.expiresAt, Date.now() + session.policy.offlineLeaseSeconds * 1000);
    await this.saveState(directory, state);
    if (this.failures.has(session.id)) state.status.gap = this.failures.get(session.id)!;
    const artifacts = await this.artifactNames(session.id);
    if (command.ack) {
      if (command.ack.captureId !== session.id || !artifacts.includes(command.ack.artifactId)) throw new CaptureStorageError("integrity");
      const artifactDir = await capturePrivateDirectory(this.dataDir, "host", session.id, "outbox", command.ack.artifactId);
      const manifest = await this.readManifest(artifactDir);
      const chunk = manifest.chunks[command.ack.sequence];
      const identity = { captureId: session.id, artifactId: manifest.artifactId, sequence: command.ack.sequence, sha256: command.ack.sha256 };
      if (!chunk || chunk.sha256 !== command.ack.sha256 || captureObjectDigest(identity) !== command.ack.receiptId) throw new CaptureStorageError("integrity");
      const acks = await this.readAcks(artifactDir);
      const old = acks.find(ack => ack.sequence === command.ack!.sequence);
      if (old && old.receiptId !== command.ack.receiptId) throw new CaptureStorageError("integrity");
      if (!old) {
        acks.push(command.ack);
        acks.sort((a, b) => a.sequence - b.sequence);
        const bytes = Buffer.from(JSON.stringify(acks));
        if (await this.hostRetainedBytes() + bytes.length > MAX_HOST_BYTES) throw new CaptureStorageError("source_limit");
        await captureWritePrivate(artifactDir, "acks.json", bytes, true);
      }
      state.status.lastAckAt = Math.max(state.status.lastAckAt ?? 0, command.ack.committedAt);
      await this.reconcileArtifact(artifactDir, session.id, manifest.artifactId);
    }
    if (command.poll) await this.scan(session, state);
    const enabled = session.enabled && Date.now() < session.expiresAt && Date.now() < state.leaseUntil;
    if (!enabled && state.status.gap === "none") state.status.gap = Date.now() >= session.expiresAt ? "expired" : session.enabled ? "lease_expired" : "stopped";
    const next = await this.inspectArtifacts(session, state, enabled && command.poll);
    await this.saveState(directory, state);
    return { enabled, status: state.status, manifest: next?.manifest ?? null, chunk: next?.chunk ?? null };
  }
  async sweep(): Promise<void> {
    if (!await optionalStat(join(this.dataDir, "private-capture", "host"))) return;
    const root = await capturePrivateDirectory(this.dataDir, "host");
    for (const id of await names(root, uuidPattern, MAX_HOST_SESSIONS)) {
      try {
        const directory = await capturePrivateDirectory(this.dataDir, "host", id);
        const session = await this.readSession(directory);
        if (!session || session.id !== id) { this.failures.set(id, "integrity"); continue; }
        if (Date.now() >= session.expiresAt + 86400000) {
          await rm(directory, { recursive: true });
          await captureSyncDirectory(root);
          this.failures.delete(id);
          continue;
        }
        if (Date.now() >= session.expiresAt) {
          await this.expireSession(directory, session);
        } else {
          const state = await this.readState(directory);
          await this.inspectArtifacts(session, state, false);
          if (session.enabled && Date.now() < state.leaseUntil && Date.now() >= state.nextScanAt) await this.scan(session, state);
          await this.saveState(directory, state);
        }
        this.failures.delete(id);
      } catch (error) { this.failures.set(id, sourceGap(error)); }
    }
  }
  private async expireSession(directory: string, session: CaptureSession): Promise<void> {
    let discarded = 0;
    let accountingGap = false;
    const outbox = join(directory, "outbox");
    try {
      if (await optionalStat(outbox)) {
        for (const artifactId of await this.artifactNames(session.id)) {
          const artifactDir = await capturePrivateDirectory(this.dataDir, "host", session.id, "outbox", artifactId);
          const manifest = await this.readManifest(artifactDir);
          const acknowledged = this.validateAcks(manifest, await this.readAcks(artifactDir));
          discarded += manifest.chunks.filter(chunk => !acknowledged.has(chunk.sequence)).reduce((sum, chunk) => sum + chunk.bytes, 0);
        }
      }
    } catch { accountingGap = true; }
    finally {
      await rm(outbox, { recursive: true, force: true });
      await captureSyncDirectory(directory);
    }
    const state = await this.readState(directory);
    state.status.droppedBytes += discarded;
    state.status.artifacts = 0;
    state.status.pendingBytes = 0;
    state.status.pendingChunks = 0;
    state.status.gap = accountingGap ? "integrity" : "expired";
    state.cursors = {};
    await this.saveState(directory, state);
  }
  private async inspectArtifacts(session: CaptureSession, state: OutboxState, takeNext: boolean): Promise<PendingChunk | null> {
    let next: PendingChunk | null = null;
    state.status.pendingBytes = 0;
    state.status.pendingChunks = 0;
    const artifacts = await this.artifactNames(session.id);
    state.status.artifacts = artifacts.length;
    for (const artifactId of artifacts) {
      try {
        const directory = await capturePrivateDirectory(this.dataDir, "host", session.id, "outbox", artifactId);
        const artifact = await this.reconcileArtifact(directory, session.id, artifactId);
        for (const receipt of artifact.receipts) state.status.lastAckAt = Math.max(state.status.lastAckAt ?? 0, receipt.committedAt);
        if (artifact.rejected) { state.status.gap = "privacy_rejected"; continue; }
        if (artifact.manifest.version !== 2) { state.status.gap = "partial_source"; continue; }
        if (!artifact.complete) state.status.gap = "partial_source";
        for (const chunk of artifact.manifest.chunks) {
          if (artifact.acknowledged.has(chunk.sequence)) continue;
          state.status.pendingBytes += chunk.bytes;
          state.status.pendingChunks += 1;
          if (next || !takeNext || !artifact.complete) continue;
          const bytes = await captureReadEncrypted(directory, `${chunk.sequence}.chunk`, CAPTURE_CHUNK_BYTES, captureCipherContext(this.dataDir, "host", session, `${artifactId}/${chunk.sequence}.chunk`));
          if (bytes.length !== chunk.bytes || captureSha256(bytes) !== chunk.sha256) throw new CaptureStorageError("integrity");
          next = { manifest: artifact.manifest, chunk: { captureId: session.id, artifactId, sequence: chunk.sequence, sha256: chunk.sha256, base64: bytes.toString("base64") } };
        }
      } catch (error) { state.status.gap = sourceGap(error); }
    }
    return next;
  }
  private validateAcks(manifest: CaptureManifest, receipts: z.infer<typeof ackListSchema>): Set<number> {
    const acknowledged = new Set<number>();
    for (const receipt of receipts) {
      const chunk = manifest.chunks[receipt.sequence];
      const identity = { captureId: manifest.captureId, artifactId: manifest.artifactId, sequence: receipt.sequence, sha256: receipt.sha256 };
      if (receipt.captureId !== manifest.captureId || receipt.artifactId !== manifest.artifactId || !chunk || chunk.sha256 !== receipt.sha256 || receipt.receiptId !== captureObjectDigest(identity) || acknowledged.has(receipt.sequence)) throw new CaptureStorageError("integrity");
      acknowledged.add(receipt.sequence);
    }
    return acknowledged;
  }
  private async reconcileArtifact(directory: string, captureId: string, artifactId: string) {
    const session = await this.readSession(await capturePrivateDirectory(this.dataDir, "host", captureId));
    if (!session) throw new CaptureStorageError("integrity");
    const manifest = await this.readManifest(directory);
    if (manifest.captureId !== captureId || manifest.artifactId !== artifactId) throw new CaptureStorageError("integrity");
    if (await optionalStat(join(directory, "rejected.json"))) {
      const rejection = historicalRejectionSchema.parse(JSON.parse((await captureReadPrivate(directory, "rejected.json", 1024)).toString("utf8")));
      if (rejection.captureId !== captureId || rejection.artifactId !== artifactId || rejection.storedSha256 !== manifest.storedSha256) throw new CaptureStorageError("integrity");
      return { manifest, receipts: [], acknowledged: new Set<number>(), complete: false, rejected: true };
    }
    const receipts = await this.readAcks(directory);
    const acknowledged = this.validateAcks(manifest, receipts);
    let removed = false;
    for (const sequence of acknowledged) {
      const path = join(directory, `${sequence}.chunk`);
      if (await optionalStat(path)) { await rm(path, { force: true }); removed = true; }
    }
    if (removed) await captureSyncDirectory(directory);
    const published = await optionalStat(join(directory, "ready"));
    if (published && (await captureReadPrivate(directory, "ready", 64)).toString("utf8") !== artifactId) throw new CaptureStorageError("integrity");
    let complete = true;
    const hash = !published && receipts.length === 0 ? createHash("sha256") : null;
    for (const chunk of manifest.chunks) {
      if (acknowledged.has(chunk.sequence)) continue;
      const stat = await optionalStat(join(directory, `${chunk.sequence}.chunk`));
      if (!stat) { complete = false; continue; }
      if (!stat.isFile() || stat.size !== captureEncryptedSize(chunk.bytes) || (stat.mode & 0o077) !== 0 || (process.getuid !== undefined && stat.uid !== process.getuid())) throw new CaptureStorageError("integrity");
      if (!published || stat.nlink !== 1) {
        const bytes = await captureReadEncrypted(directory, `${chunk.sequence}.chunk`, CAPTURE_CHUNK_BYTES, captureCipherContext(this.dataDir, "host", session, `${artifactId}/${chunk.sequence}.chunk`));
        if (captureSha256(bytes) !== chunk.sha256) throw new CaptureStorageError("integrity");
        hash?.update(bytes);
      }
    }
    if (complete && hash && hash.digest("hex") !== manifest.storedSha256) throw new CaptureStorageError("integrity");
    if (complete && !published) await captureWritePrivate(directory, "ready", Buffer.from(artifactId));
    return { manifest, receipts, acknowledged, complete, rejected: false };
  }
  private async retainedBytes(directory: string): Promise<number> {
    let bytes = 0;
    let entries = 0;
    for await (const entry of await opendir(directory)) {
      if (++entries > 1024) throw new CaptureStorageError("source_limit");
      const stat = await lstat(join(directory, entry.name));
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid !== undefined && stat.uid !== process.getuid())) throw new CaptureStorageError("integrity");
      bytes += stat.size;
    }
    return bytes;
  }
  private ackBudget(manifest: CaptureManifest): number {
    return Buffer.byteLength(JSON.stringify(manifest.chunks.map(chunk => ({
      captureId: manifest.captureId, artifactId: manifest.artifactId, sequence: chunk.sequence,
      sha256: chunk.sha256, receiptId: "f".repeat(64), committedAt: Number.MAX_SAFE_INTEGER, status: "duplicate",
    }))));
  }
  private async ackReservation(directory: string): Promise<number> {
    if (!await optionalStat(join(directory, "manifest.json"))) return 0;
    const manifest = await this.readManifest(directory);
    if (manifest.version !== 2 || (await this.readAcks(directory)).length === manifest.chunks.length) return 0;
    const actual = (await optionalStat(join(directory, "acks.json")))?.size ?? 0;
    return Math.max(0, 2 * this.ackBudget(manifest) - actual);
  }
  private async hostRetainedBytes(): Promise<number> {
    const root = await capturePrivateDirectory(this.dataDir, "host");
    let bytes = 0;
    for (const id of await names(root, uuidPattern, MAX_HOST_SESSIONS)) {
      for (const artifact of await this.artifactNames(id)) bytes += await this.retainedBytes(await capturePrivateDirectory(this.dataDir, "host", id, "outbox", artifact));
    }
    return bytes;
  }
  private async scan(session: CaptureSession, state: z.infer<typeof stateSchema>): Promise<void> {
    if (!session.enabled || Date.now() >= session.expiresAt || Date.now() >= state.leaseUntil) return;
    if (state.writerVersion !== 2) { state.cursors = {}; state.writerVersion = 2; }
    state.nextScanAt = Date.now() + session.policy.syncIntervalSeconds * 1000;
    await this.scanExports(session, state);
    if (!session.policy.bridgeRecorder) return;
    const root = process.env.BB_PROVIDER_BRIDGE_RECORD_DIR;
    if (!root || !session.subject.threadId || !/^[a-zA-Z0-9_.-]+$/u.test(session.subject.runtimeId) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(session.subject.threadId)) {
      state.status.gap = "source_unavailable";
      return;
    }
    let sourceDirectory: string;
    try {
      const canonicalRoot = await realpath(resolve(root));
      sourceDirectory = join(canonicalRoot, session.subject.runtimeId, session.subject.threadId);
      if (await realpath(sourceDirectory) !== sourceDirectory) throw new CaptureStorageError("integrity");
      const directoryStat = await lstat(sourceDirectory);
      if (!directoryStat.isDirectory() || (directoryStat.mode & 0o077) !== 0 || (process.getuid !== undefined && directoryStat.uid !== process.getuid())) throw new CaptureStorageError("integrity");
    } catch { state.status.gap = "source_unavailable"; return; }
    for (const lane of lanes) {
      let handle;
      try {
        handle = await open(join(sourceDirectory, `${lane}.ndjson`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const before = await handle.stat();
        if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 || (process.getuid !== undefined && before.uid !== process.getuid())) throw new CaptureStorageError("integrity");
        const identity = `${before.dev}:${before.ino}`;
        let cursor = state.cursors[lane];
        if (!cursor || cursor.identity !== identity || before.size < cursor.offset) {
          if (cursor) state.status.gap = "source_changed";
          cursor = { identity, offset: 0 };
          state.cursors[lane] = cursor;
        }
        if (before.size === cursor.offset) continue;
        const buffer = Buffer.alloc(Math.min(before.size - cursor.offset, 1024 * 1024));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, cursor.offset);
        const newline = buffer.subarray(0, bytesRead).lastIndexOf(10);
        if (newline < 0) { state.status.gap = "partial_source"; continue; }
        const after = await handle.stat();
        if (after.ino !== before.ino || after.dev !== before.dev || after.size < before.size) throw new CaptureStorageError("source_changed");
        const source = buffer.subarray(0, newline + 1);
        const verification = Buffer.alloc(source.length);
        const verified = await handle.read(verification, 0, verification.length, cursor.offset);
        if (verified.bytesRead !== source.length || captureSha256(verification) !== captureSha256(source)) throw new CaptureStorageError("source_changed");
        const prepared = capturePreparePayload(source, CAPTURE_CHUNK_BYTES);
        const fields = {
          version: 2 as const, captureId: session.id, source: "bridge-recorder" as const,
          sourceId: `${lane}:${identity}`, sourceOffset: cursor.offset,
          hostId: session.subject.hostId, runId: null, nativeSessionId: null, ...captureReportedModels(prepared.bytes),
          destinations: [], transport: "stdio" as const, requestId: null, observedAt: null,
          ...prepared.fields, representation: "raw" as const, streamState: "unknown" as const,
          fidelity: "source-bytes" as const,
          redactionPolicy: "source-preserved-v2" as const, payloadSecrets: "not-guaranteed" as const,
        };
        const manifest = captureManifestSchema.parse({ ...fields, artifactId: captureObjectDigest(fields) });
        await this.spool(session, manifest, prepared.bytes);
        cursor.offset += source.length;
        if (state.status.gap === "none") state.status.gap = "partial_source";
        await this.saveState(await capturePrivateDirectory(this.dataDir, "host", session.id), state);
      } catch (error) {
        state.status.gap = sourceGap(error);
      } finally { await handle?.close(); }
    }
  }
  private async scanExports(session: CaptureSession, state: z.infer<typeof stateSchema>): Promise<void> {
    for (const source of session.policy.nativeExports) {
      let handle;
      try {
        if (session.subject.threadId !== null && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(session.subject.threadId)) throw new CaptureStorageError("integrity");
        const dataRoot = await realpath(this.dataDir);
        const root = session.subject.threadId === null
          ? join(dataRoot, "private-capture-input", session.id)
          : join(dataRoot, "thread-storage", session.subject.threadId);
        const path = join(root, ...source.relativePath.split("/"));
        if (await realpath(root) !== root || await realpath(path) !== path) throw new CaptureStorageError("integrity");
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const before = await handle.stat();
        if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 || (process.getuid !== undefined && before.uid !== process.getuid())) throw new CaptureStorageError("integrity");
        if (before.size < 1) { state.status.gap = "partial_source"; continue; }
        if (before.size > CAPTURE_MAX_ARTIFACT_BYTES) throw new CaptureStorageError("source_limit");
        const identity = `${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}`;
        const key = `export:${source.sourceId}`;
        if (state.cursors[key]?.identity === identity) continue;
        const original = Buffer.allocUnsafe(before.size);
        for (let offset = 0; offset < original.length;) {
          const { bytesRead } = await handle.read(original, offset, original.length - offset, offset);
          if (bytesRead === 0) throw new CaptureStorageError("source_changed");
          offset += bytesRead;
        }
        const after = await handle.stat();
        if (original.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new CaptureStorageError("source_changed");
        const prepared = capturePreparePayload(original, CAPTURE_CHUNK_BYTES);
        const fields = {
          version: 2 as const, captureId: session.id, source: "owner-import" as const,
          sourceId: `export:${source.sourceId}:${before.dev}:${before.ino}`, sourceOffset: 0,
          hostId: session.subject.hostId, runId: null, nativeSessionId: null,
          ...(source.representation === "binary" ? { models: [], indexLimited: false } : captureReportedModels(prepared.bytes)),
          destinations: [], transport: "file" as const, requestId: null, observedAt: null,
          ...prepared.fields, representation: source.representation, streamState: "unknown" as const,
          fidelity: "source-bytes" as const,
          redactionPolicy: "source-preserved-v2" as const,
          payloadSecrets: "not-guaranteed" as const,
        };
        await this.spool(session, captureManifestSchema.parse({ ...fields, artifactId: captureObjectDigest(fields) }), prepared.bytes);
        state.cursors[key] = { identity, offset: original.length };
        await this.saveState(await capturePrivateDirectory(this.dataDir, "host", session.id), state);
      } catch (error) {
        state.status.gap = sourceGap(error);
      } finally { await handle?.close(); }
    }
  }
  private async spool(session: CaptureSession, manifest: CaptureManifest, bytes: Buffer): Promise<void> {
    const existing = await this.artifactNames(session.id);
    const resumed = existing.includes(manifest.artifactId);
    const root = await capturePrivateDirectory(this.dataDir, "host");
    const directory = resumed
      ? await capturePrivateDirectory(this.dataDir, "host", session.id, "outbox", manifest.artifactId)
      : join(root, session.id, "outbox", manifest.artifactId);
    if (!resumed && await optionalStat(directory)) throw new CaptureStorageError("integrity");
    if (resumed && await optionalStat(join(directory, "rejected.json"))) throw new CaptureStorageError("integrity");
    const acknowledged = resumed ? this.validateAcks(manifest, await this.readAcks(directory)) : new Set<number>();
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    let hostBytes = 0;
    let sessionBytes = 0;
    for (const id of await names(root, uuidPattern, MAX_HOST_SESSIONS)) {
      for (const artifact of await this.artifactNames(id)) {
        const artifactDir = await capturePrivateDirectory(this.dataDir, "host", id, "outbox", artifact);
        const retained = await this.retainedBytes(artifactDir);
        hostBytes += retained + await this.ackReservation(artifactDir);
        if (id === session.id) {
          if (await optionalStat(join(artifactDir, "manifest.json"))) sessionBytes += (await this.readManifest(artifactDir)).storedBytes;
          else if (artifact === manifest.artifactId) sessionBytes += manifest.storedBytes;
          else if (retained > 0) sessionBytes += CAPTURE_MAX_ARTIFACT_BYTES;
        }
      }
    }
    let additionalBytes = resumed ? 0 : manifest.chunks.reduce((sum, chunk) => sum + captureEncryptedSize(chunk.bytes), 0) + manifestBytes.length + 64 + 2 * this.ackBudget(manifest);
    if (resumed) {
      for (const chunk of manifest.chunks) if (!acknowledged.has(chunk.sequence) && !await optionalStat(join(directory, `${chunk.sequence}.chunk`))) additionalBytes += captureEncryptedSize(chunk.bytes);
      if (!await optionalStat(join(directory, "manifest.json"))) additionalBytes += manifestBytes.length + 2 * this.ackBudget(manifest);
      if (!await optionalStat(join(directory, "acks.json"))) additionalBytes += 2;
      if (!await optionalStat(join(directory, "ready"))) additionalBytes += 64;
    }
    if ((!resumed && (existing.length >= session.policy.maxArtifacts || sessionBytes + bytes.length > session.policy.maxBytes)) || hostBytes + additionalBytes > MAX_HOST_BYTES) throw new CaptureStorageError("source_limit");
    await capturePrivateDirectory(this.dataDir, "host", session.id, "outbox", manifest.artifactId);
    await captureWritePrivate(directory, "manifest.json", manifestBytes);
    for (const chunk of manifest.chunks) {
      if (!acknowledged.has(chunk.sequence)) await captureWriteEncrypted(directory, `${chunk.sequence}.chunk`, bytes.subarray(chunk.sequence * CAPTURE_CHUNK_BYTES, chunk.sequence * CAPTURE_CHUNK_BYTES + chunk.bytes), captureCipherContext(this.dataDir, "host", session, `${manifest.artifactId}/${chunk.sequence}.chunk`));
    }
    if (!await optionalStat(join(directory, "acks.json"))) await captureWritePrivate(directory, "acks.json", Buffer.from("[]"));
    await captureWritePrivate(directory, "ready", Buffer.from(manifest.artifactId));
  }
  private async artifactNames(id: string): Promise<string[]> {
    const directory = await capturePrivateDirectory(this.dataDir, "host", id, "outbox");
    return names(directory, digestPattern, 512);
  }
  private async readSession(directory: string): Promise<CaptureSession | null> {
    if (!await optionalStat(join(directory, "session.json"))) return null;
    return captureSessionSchema.parse(JSON.parse((await captureReadPrivate(directory, "session.json", 65536)).toString("utf8")));
  }
  private async readState(directory: string): Promise<z.infer<typeof stateSchema>> {
    if (!await optionalStat(join(directory, "state.json"))) return { leaseUntil: 0, nextScanAt: 0, cursors: {}, status: emptyStatus() };
    return stateSchema.parse(JSON.parse((await captureReadPrivate(directory, "state.json", 65536)).toString("utf8")));
  }
  private saveState(directory: string, state: z.infer<typeof stateSchema>): Promise<void> {
    return captureWritePrivate(directory, "state.json", Buffer.from(JSON.stringify(state)), true);
  }
  private async readManifest(directory: string): Promise<CaptureManifest> {
    const manifest = captureManifestSchema.parse(JSON.parse((await captureReadPrivate(directory, "manifest.json", 65536)).toString("utf8")));
    const { artifactId, ...fields } = manifest;
    if (captureObjectDigest(fields) !== artifactId) throw new CaptureStorageError("integrity");
    return manifest;
  }
  private async readAcks(directory: string) {
    if (!await optionalStat(join(directory, "acks.json"))) return [];
    return ackListSchema.parse(JSON.parse((await captureReadPrivate(directory, "acks.json", 131072)).toString("utf8")));
  }
}

export async function exchangeHostCapture(dataDir: string, command: CaptureExchangeCommand): Promise<CaptureExchangeResult> {
  if (stoppedDirectories.has(resolve(dataDir))) throw new Error("capture_storage_unavailable");
  try { return await instance(dataDir).exclusive(() => instance(dataDir).exchange(command)); }
  catch (error) { throw new Error(error instanceof CaptureStorageError ? error.code : "capture_storage_unavailable"); }
}
export function startHostCaptureOutbox(dataDir: string): { stop(): Promise<void> } {
  const key = resolve(dataDir);
  stoppedDirectories.delete(key);
  let stopped = false;
  let pending: Promise<void> = Promise.resolve();
  let running = false;
  const tick = () => {
    if (stopped || running) return;
    running = true;
    pending = instance(dataDir).exclusive(() => instance(dataDir).sweep()).catch(() => {}).finally(() => { running = false; });
  };
  const timer = setInterval(tick, 30_000);
  timer.unref();
  tick();
  return { async stop() { stopped = true; stoppedDirectories.add(key); clearInterval(timer); await pending; await instance(dataDir).exclusive(async () => {}); instances.delete(key); } };
}
