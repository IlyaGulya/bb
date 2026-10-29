import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { and, asc, count, eq, gt, lte, or, sql } from "drizzle-orm";
import {
  events, getEnvironment, getExecutionContext, getHost, getProject, getThread,
  getThreadExecutionBinding, privateCaptureArtifacts as artifacts, privateCaptureChunks as chunks,
  privateCaptureSessions as sessions, privateCaptureLinks as links, type DbConnection,
  hydrateRetainedEventOutputRowsWithinDataByteLimit, canHydrateRetainedEventOutputRowsWithinDataByteLimit,
} from "@bb/db";
import {
  CAPTURE_CHUNK_BYTES, CAPTURE_MAX_ARTIFACT_BYTES, captureAckSchema, captureManifestSchema,
  captureContainsPrivateKey, captureHasUnredactedAuth, captureReportedModels,
  CapturePayloadError,
  captureGapSchema,
  captureSessionSchema, redactCapturePayload, type CaptureAck, type CaptureChunk,
  type CaptureGap, type CaptureManifest, type CaptureScope, type CaptureSession,
} from "@bb/domain";
import type { CaptureArtifactQuery, CaptureArtifactView, CaptureCreate, CaptureLinkRequest, CaptureListQuery, CaptureView, CapturePreview, CapturePreviewQuery } from "@bb/server-contract";
import type { CaptureRejection } from "@bb/host-daemon-contract";
import {
  CaptureStorageError, captureDecodeBase64, captureObjectDigest, capturePreparePayload,
  capturePrivateDirectory, captureReadPrivate, captureSha256, captureWritePrivate,
} from "@bb/process-utils";
import type { AppDeps, WorkSessionDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { callHostOnlineRpc } from "./hosts/online-rpc.js";
import { captureGatewayLogSource, listGatewayLogs } from "./gateway-logs.js";
import { gatewayLogDirectory } from "./gateway-log-directory.js";

type CaptureDeps = Pick<AppDeps, "db" | "config">;
type SessionRow = typeof sessions.$inferSelect;
const MAX_CORE_BYTES = 2 * 1024 * 1024 * 1024;
const syncs = new WeakMap<DbConnection, Map<string, Promise<CaptureView>>>();
const sweepRuns = new WeakMap<DbConnection, Promise<void>>();
const stopping = new WeakSet<DbConnection>();
const sweepFailures = new WeakSet<DbConnection>();
const purging = new WeakMap<DbConnection, Set<string>>();
const writeRuns = new WeakMap<DbConnection, Map<string, Promise<CaptureAck>>>();

function fail(code: string, status: ConstructorParameters<typeof ApiError>[0] = 409): never {
  throw new ApiError(status, `capture_${code}`, `Private capture ${code}.`);
}
export function authorizeCaptureScope(db: DbConnection, scope: CaptureScope): void {
  const project = getProject(db, scope.projectId);
  const context = getExecutionContext(db, scope.executionContextId);
  if (!project || project.deletedAt !== null || !context?.enabled || !context.projectIds.includes(scope.projectId)) fail("scope_denied", 403);
}
function authorizeSubject(db: DbConnection, session: CaptureSession, delivery: boolean): void {
  authorizeCaptureScope(db, session.subject);
  if (session.subject.threadId === null) return;
  const thread = getThread(db, session.subject.threadId);
  const binding = getThreadExecutionBinding(db, session.subject.threadId);
  if (!thread || thread.deletedAt !== null || thread.projectId !== session.subject.projectId ||
      binding?.executionContext?.id !== session.subject.executionContextId ||
      (binding.modelConnection?.id ?? null) !== session.subject.modelConnectionId || thread.providerId !== session.subject.runtimeId) fail("scope_denied", 403);
  if (delivery) {
    const environment = thread.environmentId === null ? null : getEnvironment(db, thread.environmentId);
    if (environment?.hostId !== session.subject.hostId) fail("scope_denied", 403);
  }
}
function requireCapture(deps: CaptureDeps, id: string, scope: CaptureScope, delivery = false): SessionRow {
  authorizeCaptureScope(deps.db, scope);
  const row = deps.db.select().from(sessions).where(and(eq(sessions.id, id), eq(sessions.projectId, scope.projectId), eq(sessions.executionContextId, scope.executionContextId))).get();
  if (!row) fail("not_found", 404);
  authorizeSubject(deps.db, row.session, delivery);
  if (Date.now() >= row.expiresAt) fail("expired", 410);
  return row;
}
function committedBoundary(db: DbConnection): void {
  if (stopping.has(db)) fail("stopped", 503);
  if (db.$client.inTransaction) fail("uncommitted_transaction", 503);
}
function gap(deps: CaptureDeps, id: string, code: CaptureGap): void {
  deps.db.update(sessions).set({ gap: code, gapCount: sql`${sessions.gapCount} + 1` }).where(eq(sessions.id, id)).run();
}
function storageCode(error: unknown): CaptureGap {
  if (error instanceof CaptureStorageError) return error.code;
  if (error instanceof CapturePayloadError) return error.code === "invalid_utf8" ? "partial_source" : error.code;
  if (error instanceof ApiError) {
    const parsed = captureGapSchema.safeParse(error.body.code.replace(/^capture_/u, ""));
    if (parsed.success) return parsed.data;
    if (error.status === 403) return "scope_denied";
    if (error.body.code === "host_unavailable") return "host_unavailable";
    if (error.body.code === "gateway_logs_not_ready") return "partial_source";
    if (error.body.code === "gateway_logs_scan_limit") return "source_limit";
    if (error.body.code.startsWith("gateway_logs_")) return "source_unavailable";
  }
  return "storage_unavailable";
}
function directory(deps: CaptureDeps, session: CaptureSession, artifactId: string): Promise<string> {
  return capturePrivateDirectory(deps.config.dataDir, "core", captureObjectDigest({ projectId: session.subject.projectId, executionContextId: session.subject.executionContextId }), session.id, artifactId);
}
export function createPrivateCapture(deps: CaptureDeps, input: CaptureCreate): CaptureView {
  committedBoundary(deps.db);
  const now = Date.now();
  const { id, policy, ...subject } = input;
  authorizeCaptureScope(deps.db, subject);
  if (!getHost(deps.db, subject.hostId)) fail("host_not_found", 404);
  if ((subject.runId !== null || subject.nativeSessionId !== null) && (policy.cpaLogs || policy.bridgeRecorder)) fail("run_wire_correlation_unavailable");
  if (subject.threadId !== null) {
    const thread = getThread(deps.db, subject.threadId);
    if (!thread || (subject.model !== null && subject.model !== thread.modelOverride)) fail("subject_mismatch");
    subject.model = thread.modelOverride;
    if (subject.runId !== null || subject.nativeSessionId !== null) {
      const evidence = deps.db.select({ id: events.id }).from(events).where(and(eq(events.threadId, subject.threadId), subject.runId === null ? undefined : eq(events.turnId, subject.runId), subject.nativeSessionId === null ? undefined : eq(events.providerThreadId, subject.nativeSessionId))).limit(1).get();
      if (!evidence) fail("subject_mismatch");
    }
  } else if (subject.runId !== null || subject.modelConnectionId !== null) fail("standalone_unverified_binding");
  const session = captureSessionSchema.parse({ id, subject, policy, enabled: true, createdAt: now, expiresAt: now + policy.retentionHours * 3600000 });
  authorizeSubject(deps.db, session, true);
  deps.db.transaction(() => {
    const existing = deps.db.select().from(sessions).where(eq(sessions.id, session.id)).get();
    if (existing) {
      if (captureObjectDigest({ subject: existing.session.subject, policy: existing.session.policy }) !== captureObjectDigest({ subject, policy })) fail("identity_conflict");
      return;
    }
    const total = deps.db.select({ count: count() }).from(sessions).get()!.count;
    if (total >= 64) fail("quota", 429);
    deps.db.insert(sessions).values({ id: session.id, projectId: subject.projectId, executionContextId: subject.executionContextId, threadId: subject.threadId, hostId: subject.hostId, session, enabled: true, expiresAt: session.expiresAt, nextSyncAt: now }).run();
  }, { behavior: "immediate" });
  return { ...getPrivateCapture(deps, session.id, subject), outcome: "accepted" };
}
export function getPrivateCapture(deps: CaptureDeps, id: string, scope: CaptureScope): CaptureView {
  const row = requireCapture(deps, id, scope);
  const expected = deps.db.select({ bytes: sql<number>`coalesce(sum(json_extract(${artifacts.manifest}, '$.storedBytes')), 0)`, chunks: sql<number>`coalesce(sum(json_array_length(${artifacts.manifest}, '$.chunks')), 0)` }).from(artifacts).where(and(eq(artifacts.captureId, id), sql`${artifacts.rejectedAt} is null`)).get()!;
  const sources = deps.db.selectDistinct({ source: sql<CaptureManifest["source"]>`json_extract(${artifacts.manifest}, '$.source')` }).from(artifacts).where(and(eq(artifacts.captureId, id), sql`${artifacts.completedAt} is not null`)).all();
  const totals = deps.db.select({ bytes: sql<number>`coalesce(sum(${chunks.bytes}), 0)`, count: count() }).from(chunks).where(eq(chunks.captureId, id)).get()!;
  const expectedBytes = expected.bytes;
  const expectedChunks = expected.chunks;
  const has = (source: CaptureManifest["source"]) => sources.some(item => item.source === source);
  const effectiveGap = sweepFailures.has(deps.db) ? "storage_unavailable" : row.gap;
  return {
    session: row.session, lastSyncAt: row.lastSyncAt, lastAckAt: row.lastAckAt,
    gap: effectiveGap, gapCount: row.gapCount + (sweepFailures.has(deps.db) ? 1 : 0),
    storedBytes: totals.bytes, committedChunks: totals.count,
    pendingBytes: Math.max(0, expectedBytes - totals.bytes), pendingChunks: Math.max(0, expectedChunks - totals.count),
    host: row.hostStatus,
    hostEnabled: row.hostEnabled,
    links: deps.db.select({ threadId: links.threadId, runId: links.runId, createdAt: links.createdAt }).from(links).where(eq(links.captureId, id)).orderBy(asc(links.linkId)).all().map(link => ({ ...link, provenance: "owner-association" as const })),
    outcome: !row.enabled ? "accepted" : effectiveGap !== "none" ? "failed" : row.lastSyncAt === null || totals.count === 0 || expectedChunks > totals.count || row.hostStatus?.pendingChunks ? "accepted" : "succeeded",
    coverage: [
      { source: "cpa-request-log", state: has("cpa-request-log") ? "captured" : "uninstrumented", evidence: "Retained source-file evidence only; stream loss, bypass, pinning and unsupported transports are not certified." },
      { source: "bridge-recorder", state: has("bridge-recorder") ? "captured" : "uninstrumented", evidence: "Only enrolled host/thread recorder lanes; existing recorder must already be explicitly enabled. Process-wide unknown-scope lanes are excluded. Oversized and unterminated lines are gaps." },
      { source: "native-events", state: has("native-events") ? "metadata-only" : "uninstrumented", evidence: "Persisted actual Core normalized native events, including available tools/approvals/results; not provider HTTP or independent stdio MCP wire." },
      { source: "native-transcript", state: "uninstrumented", evidence: "No provider auth home or native transcript discovery. Owner imports retain supplied-evidence provenance, not automatic native capture." },
      { source: "stdio-mcp", state: "uninstrumented", evidence: "A schema or replayed tool result is not an independent MCP invocation capture." },
      { source: "bypass-network", state: "uninstrumented", evidence: "No proxy, MITM, CA or all-traffic collector. HTTP/3, gRPC, WebSocket, encryption/pinning and unavailable provider reasoning require explicit qualification." },
      { source: "standalone", state: row.session.subject.threadId === null && has("owner-import") ? "captured" : "uninstrumented", evidence: "Explicit capture identity and owner-supplied evidence only; automatic terminal/cmux/tmux process instrumentation is not claimed." },
    ],
  };
}
export function listPrivateCaptures(deps: CaptureDeps, query: CaptureListQuery): CaptureView[] {
  authorizeCaptureScope(deps.db, query);
  if (query.threadId !== undefined) authorizeLinkTarget(deps.db, { ...query, threadId: query.threadId, runId: null });
  const rows = deps.db.select({ id: sessions.id }).from(sessions).where(and(
    eq(sessions.projectId, query.projectId), eq(sessions.executionContextId, query.executionContextId),
    gt(sessions.expiresAt, Date.now()), query.threadId === undefined ? undefined : or(eq(sessions.threadId, query.threadId), sql`exists (select 1 from ${links} where ${links.captureId} = ${sessions.id} and ${links.threadId} = ${query.threadId})`),
    query.hostId === undefined ? undefined : eq(sessions.hostId, query.hostId),
    query.model === undefined ? undefined : sql`json_extract(${sessions.session}, '$.subject.model') = ${query.model}`,
    query.runtimeId === undefined ? undefined : sql`json_extract(${sessions.session}, '$.subject.runtimeId') = ${query.runtimeId}`,
    query.nativeSessionId === undefined ? undefined : sql`json_extract(${sessions.session}, '$.subject.nativeSessionId') = ${query.nativeSessionId}`,
    query.after === undefined ? undefined : gt(sessions.id, query.after),
  )).orderBy(asc(sessions.id)).limit(query.limit).all();
  return rows.map(row => getPrivateCapture(deps, row.id, query));
}
function authorizeLinkTarget(db: DbConnection, input: CaptureLinkRequest): void {
  authorizeCaptureScope(db, input);
  const thread = getThread(db, input.threadId);
  const binding = getThreadExecutionBinding(db, input.threadId);
  if (!thread || thread.deletedAt !== null || thread.projectId !== input.projectId || binding?.executionContext?.id !== input.executionContextId) fail("scope_denied", 403);
  if (input.runId !== null && !db.select({ id: events.id }).from(events).where(and(eq(events.threadId, input.threadId), eq(events.turnId, input.runId))).limit(1).get()) fail("subject_mismatch");
}
export function linkPrivateCapture(deps: CaptureDeps, id: string, input: CaptureLinkRequest): CaptureView {
  committedBoundary(deps.db);
  deps.db.transaction(() => {
    requireCapture(deps, id, input);
    authorizeLinkTarget(deps.db, input);
    const linkId = captureObjectDigest({ threadId: input.threadId, runId: input.runId });
    const existing = deps.db.select({ id: links.linkId }).from(links).where(and(eq(links.captureId, id), eq(links.linkId, linkId))).get();
    if (!existing && deps.db.select({ count: count() }).from(links).where(eq(links.captureId, id)).get()!.count >= 32) fail("quota", 429);
    deps.db.insert(links).values({ captureId: id, linkId, threadId: input.threadId, runId: input.runId, createdAt: Date.now() }).onConflictDoNothing().run();
  }, { behavior: "immediate" });
  return { ...getPrivateCapture(deps, id, input), outcome: "succeeded" };
}
export function stopPrivateCapture(deps: CaptureDeps, id: string, scope: CaptureScope): CaptureView {
  committedBoundary(deps.db);
  const row = requireCapture(deps, id, scope);
  deps.db.update(sessions).set({ enabled: false, session: { ...row.session, enabled: false }, gap: "stopped", nextSyncAt: Date.now() }).where(eq(sessions.id, id)).run();
  return getPrivateCapture(deps, id, scope);
}
export function stageCaptureManifest(deps: CaptureDeps, scope: CaptureScope, manifest: CaptureManifest, adapter = false): CaptureArtifactView {
  committedBoundary(deps.db);
  const { artifactId, ...fields } = manifest;
  if (captureObjectDigest(fields) !== artifactId) fail("integrity");
  if (!adapter && manifest.source !== "owner-import") fail("source_authority", 403);
  const row = requireCapture(deps, manifest.captureId, scope, true);
  try {
  deps.db.transaction(() => {
    const current = requireCapture(deps, manifest.captureId, scope, true);
    const existing = deps.db.select().from(artifacts).where(and(eq(artifacts.captureId, manifest.captureId), eq(artifacts.artifactId, artifactId))).get();
    if (existing) {
      if (captureObjectDigest(existing.manifest) !== captureObjectDigest(manifest)) fail("identity_conflict");
      return;
    }
    if (!current.enabled) fail("stopped");
    const reserved = deps.db.select({ bytes: sql<number>`coalesce(sum(json_extract(${artifacts.manifest}, '$.storedBytes')), 0)`, count: count() }).from(artifacts).where(eq(artifacts.captureId, manifest.captureId)).get()!;
    const global = deps.db.select({ bytes: sql<number>`coalesce(sum(json_extract(${artifacts.manifest}, '$.storedBytes')), 0)` }).from(artifacts).get()!;
    if (reserved.count >= row.session.policy.maxArtifacts || reserved.bytes + manifest.storedBytes > row.session.policy.maxBytes || global.bytes + manifest.storedBytes > MAX_CORE_BYTES) fail("quota", 429);
    deps.db.insert(artifacts).values({ captureId: manifest.captureId, artifactId, manifest, createdAt: Date.now() }).run();
  }, { behavior: "immediate" });
  } catch (error) {
    gap(deps, manifest.captureId, storageCode(error));
    throw error;
  }
  return captureArtifact(deps, manifest.captureId, artifactId, scope);
}
export function captureArtifact(deps: CaptureDeps, id: string, artifactId: string, scope: CaptureScope): CaptureArtifactView {
  requireCapture(deps, id, scope);
  const row = deps.db.select().from(artifacts).where(and(eq(artifacts.captureId, id), eq(artifacts.artifactId, artifactId))).get();
  if (!row) fail("artifact_not_found", 404);
  return { manifest: row.manifest, completedAt: row.completedAt, rejectedAt: row.rejectedAt, outcome: row.rejectedAt !== null ? "failed" : row.completedAt === null ? "accepted" : "succeeded", committedSequences: deps.db.select({ sequence: chunks.sequence }).from(chunks).where(and(eq(chunks.captureId, id), eq(chunks.artifactId, artifactId))).orderBy(asc(chunks.sequence)).all().map(chunk => chunk.sequence) };
}
export function listCaptureArtifacts(deps: CaptureDeps, id: string, query: CaptureArtifactQuery): CaptureArtifactView[] {
  requireCapture(deps, id, query);
  const rows = deps.db.select({ id: artifacts.artifactId }).from(artifacts).where(and(
    eq(artifacts.captureId, id), query.after === undefined ? undefined : gt(artifacts.artifactId, query.after),
    query.source === undefined ? undefined : sql`json_extract(${artifacts.manifest}, '$.source') = ${query.source}`,
    query.destination === undefined ? undefined : sql`exists (select 1 from json_each(json_extract(${artifacts.manifest}, '$.destinations')) where value = ${query.destination})`,
    query.hostId === undefined ? undefined : sql`json_extract(${artifacts.manifest}, '$.hostId') = ${query.hostId}`,
    query.runId === undefined ? undefined : sql`json_extract(${artifacts.manifest}, '$.runId') = ${query.runId}`,
    query.nativeSessionId === undefined ? undefined : sql`json_extract(${artifacts.manifest}, '$.nativeSessionId') = ${query.nativeSessionId}`,
    query.model === undefined ? undefined : sql`exists (select 1 from json_each(json_extract(${artifacts.manifest}, '$.models')) where value = ${query.model})`,
  )).orderBy(asc(artifacts.artifactId)).limit(query.limit).all();
  return rows.map(row => captureArtifact(deps, id, row.id, query));
}
export async function acceptCaptureChunk(deps: CaptureDeps, scope: CaptureScope, chunk: CaptureChunk): Promise<CaptureAck> {
  if (purging.get(deps.db)?.has(chunk.captureId)) fail("expired", 410);
  let runs = writeRuns.get(deps.db);
  if (!runs) { runs = new Map(); writeRuns.set(deps.db, runs); }
  const previous = runs.get(chunk.captureId);
  const run = () => acceptCaptureChunkOwned(deps, scope, chunk);
  const work = previous === undefined ? run() : previous.then(run, run);
  runs.set(chunk.captureId, work);
  try { return await work; }
  finally { if (runs.get(chunk.captureId) === work) runs.delete(chunk.captureId); }
}
async function acceptCaptureChunkOwned(deps: CaptureDeps, scope: CaptureScope, chunk: CaptureChunk): Promise<CaptureAck> {
  committedBoundary(deps.db);
  const row = requireCapture(deps, chunk.captureId, scope, true);
  const artifact = captureArtifact(deps, chunk.captureId, chunk.artifactId, scope);
  if (artifact.rejectedAt !== null) fail("privacy_rejected", 403);
  const expected = artifact.manifest.chunks[chunk.sequence];
  const bytes = captureDecodeBase64(chunk.base64, CAPTURE_CHUNK_BYTES);
  if (!expected || expected.bytes !== bytes.length || expected.sha256 !== chunk.sha256 || captureSha256(bytes) !== chunk.sha256) fail("integrity");
  if (captureContainsPrivateKey(bytes) || captureHasUnredactedAuth(bytes, chunk.sequence === artifact.manifest.chunks.length - 1)) {
    deps.db.update(artifacts).set({ rejectedAt: Date.now() }).where(and(eq(artifacts.captureId, chunk.captureId), eq(artifacts.artifactId, chunk.artifactId))).run();
    gap(deps, chunk.captureId, "privacy_rejected");
    await purgeRejectedArtifact(deps, row.session, chunk.artifactId);
    fail("privacy_rejected", 403);
  }
  const identity = { captureId: chunk.captureId, artifactId: chunk.artifactId, sequence: chunk.sequence, sha256: chunk.sha256 };
  const receiptId = captureObjectDigest(identity);
  const committed = deps.db.select().from(chunks).where(and(eq(chunks.captureId, chunk.captureId), eq(chunks.artifactId, chunk.artifactId), eq(chunks.sequence, chunk.sequence))).get();
  if (committed) {
    if (committed.sha256 !== chunk.sha256 || committed.receiptId !== receiptId) fail("identity_conflict");
    const retained = await captureReadPrivate(await directory(deps, row.session, chunk.artifactId), `${chunk.sequence}.chunk`, CAPTURE_CHUNK_BYTES);
    if (retained.length !== expected.bytes || captureSha256(retained) !== chunk.sha256) fail("integrity");
    requireCapture(deps, chunk.captureId, scope, true);
    if (row.enabled) await completeCaptureArtifact(deps, row.session, chunk.artifactId, scope);
    return captureAckSchema.parse({ ...identity, receiptId, committedAt: committed.committedAt, status: "duplicate" });
  }
  if (!row.enabled) fail("stopped");
  try {
    await captureWritePrivate(await directory(deps, row.session, chunk.artifactId), `${chunk.sequence}.chunk`, bytes);
    let duplicate = false;
    const receipt = deps.db.transaction(() => {
      const current = requireCapture(deps, chunk.captureId, scope, true);
      const existing = deps.db.select().from(chunks).where(and(eq(chunks.captureId, chunk.captureId), eq(chunks.artifactId, chunk.artifactId), eq(chunks.sequence, chunk.sequence))).get();
      if (existing) {
        if (existing.sha256 !== chunk.sha256 || existing.receiptId !== receiptId) fail("identity_conflict");
        duplicate = true;
        return existing;
      }
      if (!current.enabled) fail("stopped");
      const committedAt = Date.now();
      const value = { ...identity, bytes: bytes.length, receiptId, committedAt };
      deps.db.insert(chunks).values(value).run();
      deps.db.update(sessions).set({ lastAckAt: committedAt }).where(eq(sessions.id, chunk.captureId)).run();
      return value;
    }, { behavior: "immediate" });
    await completeCaptureArtifact(deps, row.session, chunk.artifactId, scope);
    return captureAckSchema.parse({ ...identity, receiptId, committedAt: receipt.committedAt, status: duplicate ? "duplicate" : "accepted" });
  } catch (error) {
    gap(deps, chunk.captureId, storageCode(error));
    if (error instanceof ApiError) throw error;
    fail(storageCode(error), 503);
  }
}
async function completeCaptureArtifact(deps: CaptureDeps, session: CaptureSession, artifactId: string, scope: CaptureScope): Promise<void> {
  const artifact = captureArtifact(deps, session.id, artifactId, scope);
  if (artifact.completedAt !== null || artifact.committedSequences.length !== artifact.manifest.chunks.length) return;
  const hash = createHash("sha256");
  const root = await directory(deps, session, artifactId);
  const audit = artifact.manifest.source === "owner-import" ? Buffer.allocUnsafe(artifact.manifest.storedBytes) : null;
  let offset = 0;
  for (const chunk of artifact.manifest.chunks) {
    requireCapture(deps, session.id, scope, true);
    const bytes = await captureReadPrivate(root, `${chunk.sequence}.chunk`, CAPTURE_CHUNK_BYTES);
    if (captureSha256(bytes) !== chunk.sha256) fail("integrity");
    if (bytes.length !== chunk.bytes) fail("integrity");
    if (audit) audit.set(bytes, offset);
    offset += bytes.length;
    hash.update(bytes);
  }
  if (hash.digest("hex") !== artifact.manifest.storedSha256) fail("integrity");
  let rejected = false;
  if (audit) {
    try { rejected = captureContainsPrivateKey(audit) || captureHasUnredactedAuth(audit, true) || (artifact.manifest.representation !== "binary" && captureSha256(redactCapturePayload(audit).bytes) !== artifact.manifest.storedSha256); }
    catch { rejected = true; }
  }
  if (rejected) {
    deps.db.update(artifacts).set({ rejectedAt: Date.now() }).where(and(eq(artifacts.captureId, session.id), eq(artifacts.artifactId, artifactId))).run();
    gap(deps, session.id, "privacy_rejected");
    await purgeRejectedArtifact(deps, session, artifactId);
    fail("privacy_rejected", 403);
  }
  deps.db.transaction(() => {
    requireCapture(deps, session.id, scope, true);
    deps.db.update(artifacts).set({ completedAt: Date.now() }).where(and(eq(artifacts.captureId, session.id), eq(artifacts.artifactId, artifactId))).run();
  }, { behavior: "immediate" });
}
async function purgeRejectedArtifact(deps: CaptureDeps, session: CaptureSession, artifactId: string): Promise<void> {
  await rm(await directory(deps, session, artifactId), { recursive: true, force: true });
  deps.db.transaction(() => {
    deps.db.delete(chunks).where(and(eq(chunks.captureId, session.id), eq(chunks.artifactId, artifactId))).run();
    deps.db.update(artifacts).set({ purgedAt: Date.now() }).where(and(eq(artifacts.captureId, session.id), eq(artifacts.artifactId, artifactId))).run();
  }, { behavior: "immediate" });
}
export async function previewCaptureArtifact(deps: CaptureDeps, id: string, artifactId: string, query: CapturePreviewQuery): Promise<CapturePreview> {
  const session = requireCapture(deps, id, query).session;
  const artifact = captureArtifact(deps, id, artifactId, query);
  if (artifact.completedAt === null) fail("artifact_incomplete");
  const limit = Math.min(query.previewBytes, artifact.manifest.storedBytes);
  const preview = Buffer.alloc(limit);
  let offset = 0;
  for (const chunk of artifact.manifest.chunks) {
    if (offset >= limit) break;
    requireCapture(deps, id, query);
    const bytes = await captureReadPrivate(await directory(deps, session, artifactId), `${chunk.sequence}.chunk`, CAPTURE_CHUNK_BYTES);
    if (bytes.length !== chunk.bytes || captureSha256(bytes) !== chunk.sha256) fail("integrity");
    const length = Math.min(bytes.length, limit - offset);
    preview.set(bytes.subarray(0, length), offset);
    offset += length;
  }
  requireCapture(deps, id, query);
  const encoding = artifact.manifest.representation === "binary" ? "base64" as const : "utf8" as const;
  return { artifactId, raw: preview.toString(encoding === "base64" ? "base64" : "utf8"), encoding, truncated: limit < artifact.manifest.storedBytes, previewBytes: limit, sizeBytes: artifact.manifest.storedBytes, storedSha256: artifact.manifest.storedSha256 };
}
export function downloadCaptureArtifact(deps: CaptureDeps, id: string, artifactId: string, scope: CaptureScope): Response {
  const session = requireCapture(deps, id, scope).session;
  const artifact = captureArtifact(deps, id, artifactId, scope);
  if (artifact.completedAt === null) fail("artifact_incomplete");
  let sequence = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        requireCapture(deps, id, scope);
        const chunk = artifact.manifest.chunks[sequence++];
        if (!chunk) { controller.close(); return; }
        const bytes = await captureReadPrivate(await directory(deps, session, artifactId), `${chunk.sequence}.chunk`, CAPTURE_CHUNK_BYTES);
        requireCapture(deps, id, scope);
        if (bytes.length !== chunk.bytes || captureSha256(bytes) !== chunk.sha256) fail("integrity");
        controller.enqueue(bytes);
      } catch { controller.error(new Error("capture_download_unavailable")); }
    },
  });
  return new Response(stream, { headers: { "cache-control": "private, no-store", "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="private-capture.bin"', "content-length": String(artifact.manifest.storedBytes), "x-content-type-options": "nosniff", "x-bb-capture-sha256": artifact.manifest.storedSha256 } });
}
async function archiveBytes(deps: CaptureDeps, session: CaptureSession, source: Buffer, fields: Pick<CaptureManifest, "source" | "sourceId" | "sourceOffset" | "representation" | "streamState" | "transport" | "destinations" | "requestId" | "observedAt" | "hostId" | "runId" | "nativeSessionId" | "indexLimited">): Promise<string> {
  if (source.length > CAPTURE_MAX_ARTIFACT_BYTES) fail("source_limit", 413);
  const prepared = capturePreparePayload(source, redactCapturePayload(source), CAPTURE_CHUNK_BYTES);
  const reported = captureReportedModels(prepared.bytes);
  const content = { version: 1 as const, captureId: session.id, ...fields, ...prepared.fields,
    models: reported.models, indexLimited: fields.indexLimited || reported.indexLimited,
    fidelity: fields.representation === "normalized" ? "normalized-source" as const : prepared.fields.redacted ? "redacted-source" as const : "source-bytes" as const,
    redactionPolicy: "headers-json-credentials-v1" as const, payloadSecrets: "not-guaranteed" as const };
  const manifest = captureManifestSchema.parse({ ...content, artifactId: captureObjectDigest(content) });
  stageCaptureManifest(deps, session.subject, manifest, true);
  for (const chunk of manifest.chunks) await acceptCaptureChunk(deps, session.subject, { captureId: session.id, artifactId: manifest.artifactId, sequence: chunk.sequence, sha256: chunk.sha256, base64: prepared.bytes.subarray(chunk.sequence * CAPTURE_CHUNK_BYTES, chunk.sequence * CAPTURE_CHUNK_BYTES + chunk.bytes).toString("base64") });
  return manifest.artifactId;
}
async function archiveCoreSources(deps: CaptureDeps, row: SessionRow): Promise<void> {
  const session = row.session;
  if (!row.enabled || session.subject.threadId === null) return;
  if (session.policy.nativeEvents) {
    const actual = deps.db.select({ id: events.id, sequence: events.sequence, dataBytes: sql<number>`octet_length(${events.data})` }).from(events).where(and(eq(events.threadId, session.subject.threadId), gt(events.sequence, row.eventCursor), session.subject.runId === null ? undefined : eq(events.turnId, session.subject.runId), session.subject.nativeSessionId === null ? undefined : eq(events.providerThreadId, session.subject.nativeSessionId))).orderBy(asc(events.sequence)).limit(32).all();
    for (const entry of actual) {
      requireCapture(deps, session.id, session.subject, true);
      if (entry.dataBytes > CAPTURE_MAX_ARTIFACT_BYTES - 65536) { gap(deps, session.id, "source_limit"); break; }
      const event = deps.db.select().from(events).where(eq(events.id, entry.id)).get();
      if (!event) { gap(deps, session.id, "source_changed"); break; }
      if (!canHydrateRetainedEventOutputRowsWithinDataByteLimit(deps.db, [event], CAPTURE_MAX_ARTIFACT_BYTES - 65536)) { gap(deps, session.id, "source_limit"); break; }
      const hydrated = hydrateRetainedEventOutputRowsWithinDataByteLimit(deps.db, [event], CAPTURE_MAX_ARTIFACT_BYTES - 65536)[0]!;
      const nativePayload: unknown = JSON.parse(hydrated.data);
      if (event.type === "provider/unhandled" || (typeof nativePayload === "object" && nativePayload !== null && "item" in nativePayload &&
          typeof nativePayload.item === "object" && nativePayload.item !== null && "truncation" in nativePayload.item)) gap(deps, session.id, "partial_source");
      const sourceHost = event.environmentId === null ? null : getEnvironment(deps.db, event.environmentId)?.hostId ?? null;
      await archiveBytes(deps, session, Buffer.from(JSON.stringify(hydrated)), { source: "native-events", sourceId: `event:${event.id}:${event.sequence}`, sourceOffset: 0, representation: "normalized", streamState: "unknown", transport: "native", destinations: [], requestId: null, observedAt: event.createdAt, hostId: sourceHost, runId: event.turnId, nativeSessionId: event.providerThreadId, indexLimited: false });
      deps.db.update(sessions).set({ eventCursor: event.sequence }).where(eq(sessions.id, session.id)).run();
    }
  }
  if (session.policy.cpaLogs) {
    const binding = getThreadExecutionBinding(deps.db, session.subject.threadId);
    if (!binding?.modelConnection?.gateway) { gap(deps, session.id, "source_unavailable"); return; }
    const root = gatewayLogDirectory(binding.modelConnection.gateway.baseUrl, process.env.BB_CPA_LOG_DIRS);
    const list = await listGatewayLogs(root, session.subject.threadId);
    if (list.scanTruncated || list.unavailableFiles) gap(deps, session.id, "partial_source");
    const observations = { ...row.cpaStamps };
    const completed = new Set(deps.db.select({ id: artifacts.artifactId }).from(artifacts).where(and(eq(artifacts.captureId, session.id), sql`${artifacts.completedAt} is not null`)).all().map(item => item.id));
    const known = new Set(Object.entries(observations).filter(([, value]) => completed.has(value.artifactId)).map(([id, value]) => `${id}:${value.stamp}`));
    let captured = 0;
    for (const entry of list.entries) {
      const source = await captureGatewayLogSource(root, session.subject.threadId, entry.id, known, CAPTURE_MAX_ARTIFACT_BYTES);
      if (!source) continue;
      const text = source.bytes.toString("utf8");
      const destinations: string[] = [];
      let indexLimited = false;
      for (const match of text.matchAll(/^URL: (https?:\/\/[^\r\n]+)\r?$/gmu)) {
        try {
          const url = new URL(match[1]!); url.username = ""; url.password = ""; url.search = ""; url.hash = "";
          const value = url.toString();
          if (value.length > 2048 || (!destinations.includes(value) && destinations.length >= 32)) indexLimited = true;
          else if (!destinations.includes(value)) destinations.push(value);
        } catch { indexLimited = true; }
      }
      const artifactId = await archiveBytes(deps, session, source.bytes, { source: "cpa-request-log", sourceId: source.sourceId, sourceOffset: 0, representation: "raw", streamState: "unknown", transport: "unknown", destinations, requestId: null, observedAt: null, hostId: null, runId: null, nativeSessionId: null, indexLimited });
      observations[source.sourceId] = { stamp: source.stamp, artifactId };
      deps.db.update(sessions).set({ cpaStamps: observations }).where(eq(sessions.id, session.id)).run();
      captured += 1;
      if (captured >= 8) break;
    }
  }
}
export function syncPrivateCapture(deps: WorkSessionDeps, id: string, scope: CaptureScope): Promise<CaptureView> {
  if (stopping.has(deps.db)) fail("stopped", 503);
  requireCapture(deps, id, scope, true);
  let map = syncs.get(deps.db);
  if (!map) { map = new Map(); syncs.set(deps.db, map); }
  const pending = map.get(id);
  if (pending) return pending.then(() => getPrivateCapture(deps, id, scope));
  const work = syncOne(deps, id, scope).finally(() => map!.delete(id));
  map.set(id, work);
  return work;
}
async function syncOne(deps: WorkSessionDeps, id: string, scope: CaptureScope): Promise<CaptureView> {
  let row = requireCapture(deps, id, scope, true);
  try {
    await archiveCoreSources(deps, row);
    row = requireCapture(deps, id, scope, true);
    let ack: CaptureAck | null = null;
    let rejection: CaptureRejection | undefined;
    if (row.session.policy.bridgeRecorder || row.session.policy.nativeExports.length > 0) {
      for (let index = 0; index <= 8; index += 1) {
        row = requireCapture(deps, id, scope, true);
        const result = await callHostOnlineRpc(deps, { hostId: row.hostId, timeoutMs: 15000, command: { type: "capture.exchange", session: row.session, leaseUntil: Math.min(row.expiresAt, Date.now() + row.session.policy.offlineLeaseSeconds * 1000), ack, rejection, poll: row.enabled && index < 8 } });
        requireCapture(deps, id, scope, true);
        ack = null;
        rejection = undefined;
        deps.db.update(sessions).set({ hostStatus: result.status, hostEnabled: result.enabled }).where(eq(sessions.id, id)).run();
        if (result.status.gap !== "none") gap(deps, id, result.status.gap);
        if (!result.manifest || !result.chunk) break;
        if (result.manifest.captureId !== id || result.chunk.captureId !== id || result.chunk.artifactId !== result.manifest.artifactId ||
            (result.manifest.source !== "bridge-recorder" && result.manifest.source !== "owner-import")) fail("integrity");
        stageCaptureManifest(deps, scope, result.manifest, true);
        try { ack = await acceptCaptureChunk(deps, scope, result.chunk); }
        catch (error) {
          requireCapture(deps, id, scope, true);
          const artifact = captureArtifact(deps, id, result.manifest.artifactId, scope);
          if (artifact.rejectedAt === null) throw error;
          rejection = { captureId: id, artifactId: artifact.manifest.artifactId, storedSha256: artifact.manifest.storedSha256, reason: "privacy_rejected" };
          gap(deps, id, "privacy_rejected");
        }
      }
    }
    deps.db.update(sessions).set({ lastSyncAt: Date.now(), nextSyncAt: Date.now() + row.session.policy.syncIntervalSeconds * 1000 }).where(eq(sessions.id, id)).run();
  } catch (error) {
    const code = error instanceof ApiError && error.body.code === "host_unavailable" ? "host_unavailable" : storageCode(error);
    gap(deps, id, code);
    deps.db.update(sessions).set({ nextSyncAt: Date.now() + row.session.policy.syncIntervalSeconds * 1000 }).where(eq(sessions.id, id)).run();
  }
  return getPrivateCapture(deps, id, scope);
}
export async function pruneExpiredPrivateCaptures(deps: CaptureDeps, now = Date.now()): Promise<void> {
  committedBoundary(deps.db);
  let deleting = purging.get(deps.db);
  if (!deleting) { deleting = new Set(); purging.set(deps.db, deleting); }
  for (const row of deps.db.select().from(sessions).where(lte(sessions.expiresAt, now)).limit(8).all()) {
    if (syncs.get(deps.db)?.has(row.id) || writeRuns.get(deps.db)?.has(row.id) || deleting.has(row.id)) continue;
    deleting.add(row.id);
    try {
      const root = await capturePrivateDirectory(deps.config.dataDir, "core", captureObjectDigest({ projectId: row.projectId, executionContextId: row.executionContextId }), row.id);
      await rm(root, { recursive: true });
      deps.db.transaction(() => {
        deps.db.delete(chunks).where(eq(chunks.captureId, row.id)).run();
        deps.db.delete(artifacts).where(eq(artifacts.captureId, row.id)).run();
        deps.db.delete(links).where(eq(links.captureId, row.id)).run();
        deps.db.delete(sessions).where(eq(sessions.id, row.id)).run();
      }, { behavior: "immediate" });
    } catch { gap(deps, row.id, "storage_unavailable"); }
    finally { deleting.delete(row.id); }
  }
}
export async function sweepPrivateCaptures(deps: WorkSessionDeps, now = Date.now()): Promise<void> {
  await pruneExpiredPrivateCaptures(deps, now);
  for (const row of deps.db.select({ captureId: artifacts.captureId, artifactId: artifacts.artifactId, session: sessions.session }).from(artifacts).innerJoin(sessions, eq(sessions.id, artifacts.captureId)).where(and(sql`${artifacts.rejectedAt} is not null`, sql`${artifacts.purgedAt} is null`)).limit(8).all()) {
    if (writeRuns.get(deps.db)?.has(row.captureId)) continue;
    try { await purgeRejectedArtifact(deps, row.session, row.artifactId); }
    catch { gap(deps, row.captureId, "storage_unavailable"); }
  }
  const due = deps.db.select().from(sessions).where(and(gt(sessions.expiresAt, now), lte(sessions.nextSyncAt, now))).orderBy(asc(sessions.nextSyncAt)).limit(8).all();
  for (const row of due) {
    try { await syncPrivateCapture(deps, row.id, row.session.subject); }
    catch { gap(deps, row.id, "scope_denied"); deps.db.update(sessions).set({ nextSyncAt: now + 30000 }).where(eq(sessions.id, row.id)).run(); }
  }
}

export function schedulePrivateCaptureSweep(deps: WorkSessionDeps, now: number): void {
  if (stopping.has(deps.db) || sweepRuns.has(deps.db)) return;
  const work = sweepPrivateCaptures(deps, now).then(() => {
    if (sweepFailures.delete(deps.db)) deps.db.update(sessions).set({ gap: "storage_unavailable", gapCount: sql`${sessions.gapCount} + 1` }).where(eq(sessions.enabled, true)).run();
  }).catch(() => { sweepFailures.add(deps.db); }).finally(() => sweepRuns.delete(deps.db));
  sweepRuns.set(deps.db, work);
}

export async function drainPrivateCaptureData(db: DbConnection): Promise<void> {
  stopping.add(db);
  const pending: Promise<unknown>[] = [...(syncs.get(db)?.values() ?? []), ...(writeRuns.get(db)?.values() ?? [])];
  const sweep = sweepRuns.get(db);
  if (sweep) pending.push(sweep);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.allSettled(pending), new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); })]);
  } finally { if (timer) clearTimeout(timer); }
}
