import { lstat, opendir, rm } from "node:fs/promises";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync, inflateSync, constants } from "node:zlib";
import { z } from "zod";
import {
  CAPTURE_CHUNK_BYTES, CAPTURE_MAX_ARTIFACT_BYTES, CAPTURE_MITMPROXY_VERSION,
  captureContainsPrivateKey, captureManifestSchema, captureProcessEvidenceSchema,
  captureProcessStatusSchema, redactCapturePayload, captureReportedModels,
  CapturePayloadError, type CaptureManifest, type CaptureSession, type CaptureProcessStatus, type CaptureGap,
} from "@bb/domain";
import {
  captureObjectDigest, capturePreparePayload, capturePrivateDirectory, captureReadPrivate,
  captureSha256, captureSyncDirectory, captureWritePrivate, CaptureStorageError,
  spawnManagedProcess,
  captureCipherContext, captureReadEncrypted, captureKeyReference,
} from "@bb/process-utils";
import { PRIVATE_CAPTURE_PROGRAM } from "./private-capture-program.js";

const stateSchema = z.object({
  phase: captureProcessStatusSchema.shape.phase,
  rootPid: z.number().int().positive().optional(),
  processSessionId: z.string().uuid().optional(),
  exitCode: z.number().int().optional(),
}).strict();
const recordSchema = captureProcessEvidenceSchema.omit({ role: true }).extend({
  captureId: z.string().uuid(),
  subjectDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  source: z.enum(["mitmproxy", "native-hook", "process-stdio", "mcp-stdio"]),
  requestId: z.string().min(1).max(256).nullable(),
  transport: z.enum(["http", "sse", "websocket", "stdio"]),
  observedAt: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.json()),
  streamState: z.enum(["complete", "interrupted"]),
  bytes: z.number().int().nonnegative().max(CAPTURE_MAX_ARTIFACT_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
const programDigest = captureSha256(PRIVATE_CAPTURE_PROGRAM).slice(0, 16);
function subjectDigest(session: CaptureSession): string {
  return captureObjectDigest({ id: session.id, subject: session.subject, policy: session.policy, createdAt: session.createdAt, expiresAt: session.expiresAt });
}
async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, error => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  });
}
export async function prepareCaptureProcess(dataDir: string, session: CaptureSession, leaseUntil: number): Promise<CaptureProcessStatus | undefined> {
  const policy = session.policy.process;
  if (!policy) return undefined;
  const runtime = await capturePrivateDirectory(dataDir, "runtime", session.id);
  const sources = await capturePrivateDirectory(dataDir, "host", session.id, "sources");
  const program = `process-${programDigest}.py`;
  const configName = `process-${programDigest}.json`;
  const config = join(runtime, configName);
  const control = join(runtime, "control.json");
  await captureWritePrivate(runtime, program, Buffer.from(PRIVATE_CAPTURE_PROGRAM));
  await captureWritePrivate(runtime, configName, Buffer.from(JSON.stringify({
    config, control, sources, runtime, policy, captureId: session.id, hostRoot: await capturePrivateDirectory(dataDir, "host"),
    subjectDigest: subjectDigest(session), expiresAt: session.expiresAt,
    cipherScope: captureCipherContext(dataDir, "host", session, "source").scopeDigest,
    keyRef: captureKeyReference("host"), ephemeralRoot: process.env.BB_PRIVATE_CAPTURE_EPHEMERAL_DIR ?? (process.platform === "darwin" ? runtime : "/dev/shm"),
    maxBytes: session.policy.maxBytes, maxArtifacts: session.policy.maxArtifacts,
  })));
  await captureWritePrivate(runtime, "control.json", Buffer.from(JSON.stringify({ enabled: session.enabled && Date.now() < session.expiresAt, leaseUntil: Math.min(leaseUntil, session.expiresAt) })), true);
  const state: z.infer<typeof stateSchema> = await exists(join(runtime, "state.json"))
    ? stateSchema.parse(JSON.parse((await captureReadPrivate(runtime, "state.json", 65536)).toString("utf8")))
    : { phase: "prepared" as const };
  const failure = await exists(join(sources, "gap.json"))
    ? stateSchema.parse(JSON.parse((await captureReadPrivate(sources, "gap.json", 65536)).toString("utf8")))
    : null;
  let pendingSourceBytes = 0;
  let openRecords = 0;
  for await (const entry of await opendir(sources)) {
    if (entry.name.endsWith(".open.json")) openRecords += 1;
    if (entry.name.endsWith(".body")) {
      const stat = await lstat(join(sources, entry.name)).catch(error => {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
        throw error;
      });
      if (stat) pendingSourceBytes += stat.size;
    }
  }
  return {
    phase: failure?.phase ?? state.phase, requiredMitmproxy: CAPTURE_MITMPROXY_VERSION,
    launchPrefix: [policy.python, join(runtime, program), "run", config, "--"],
    mcpPrefix: [policy.python, join(runtime, program), "mcp", config, "--"],
    hookCommand: [policy.python, join(runtime, program), "hook", config],
    rootPid: state.rootPid ?? null, processSessionId: state.processSessionId ?? null,
    pendingSourceBytes, openRecords,
    exitCode: state.exitCode ?? null, droppedSourceBytes: null,
    prerequisite: "Python >=3.12 with cryptography and mitmproxy==12.3.1, or an explicitly selected 12.3.1 mitmdump; separate host/Core encryption key references; Linux CA runtime requires RAM-backed storage with swap excluded; authenticated encrypted delivery. Prepared is not observed capture. local-pid also requires the OS helper.",
  };
}
function decodedBody(bytes: Buffer, encoding: string, interrupted: boolean): Buffer {
  const options = { maxOutputLength: CAPTURE_MAX_ARTIFACT_BYTES };
  if (encoding === undefined || encoding === "identity" || encoding === "") return bytes;
  const streamOptions = interrupted ? { ...options, finishFlush: constants.Z_SYNC_FLUSH } : options;
  if (encoding === "gzip") return gunzipSync(bytes, streamOptions);
  if (encoding === "deflate") return inflateSync(bytes, streamOptions);
  if (encoding === "br") return brotliDecompressSync(bytes, options);
  throw new CaptureStorageError("source_unavailable");
}
async function decodeZstd(dataDir: string, session: CaptureSession, root: string, record: z.infer<typeof recordSchema>): Promise<Buffer> {
  const policy = session.policy.process;
  if (!policy) throw new CaptureStorageError("integrity");
  const runtime = await capturePrivateDirectory(dataDir, "runtime", session.id);
  const managed = spawnManagedProcess({ command: policy.python, args: [join(runtime, `process-${programDigest}.py`), "decode", join(runtime, `process-${programDigest}.json`), record.recordId, record.streamState], env: { PATH: process.env.PATH }, cwd: runtime });
  managed.child.stdout.resume();
  managed.child.stderr.resume();
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { managed.stop().then(() => reject(new CaptureStorageError("source_unavailable")), reject); }, 30000);
    managed.child.once("error", error => { clearTimeout(timer); reject(error); });
    managed.child.once("close", code => { clearTimeout(timer); resolve(code); });
  });
  if (code !== 0) throw new CaptureStorageError(code === 65 ? "source_limit" : "source_unavailable");
  return captureReadEncrypted(root, `${record.recordId}.decoded`, CAPTURE_MAX_ARTIFACT_BYTES, captureCipherContext(dataDir, "host", session, `source/${record.recordId}.decoded`));
}
export async function ingestCaptureProcess(
  dataDir: string,
  session: CaptureSession,
  spool: (manifest: CaptureManifest, bytes: Buffer) => Promise<void>,
): Promise<CaptureGap> {
  if (!session.policy.process) return "none";
  const root = await capturePrivateDirectory(dataDir, "host", session.id, "sources");
  let gap: CaptureGap = "none";
  let count = 0;
  for await (const entry of await opendir(root)) {
    const open = /^[a-f0-9-]{36}\.open\.json$/u.test(entry.name);
    if (!open && !/^[a-f0-9-]{36}\.json$/u.test(entry.name)) continue;
    if (++count > session.policy.maxArtifacts) throw new CaptureStorageError("source_limit");
    try {
    const descriptor = await captureReadEncrypted(root, entry.name, 65536, captureCipherContext(dataDir, "host", session, `source/${entry.name}`));
    let record: z.infer<typeof recordSchema>;
    if (open) {
      const initial = recordSchema.omit({ streamState: true, bytes: true, sha256: true }).parse(JSON.parse(descriptor.toString("utf8")));
      if (initial.captureId !== session.id || initial.subjectDigest !== subjectDigest(session) || `${initial.recordId}.open.json` !== entry.name) throw new CaptureStorageError("integrity");
      if (await exists(join(root, `${initial.recordId}.json`))) continue;
      try { process.kill(initial.producerPid, 0); continue; }
      catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH")) throw new CaptureStorageError("source_unavailable");
      }
      const retained = await captureReadEncrypted(root, `${initial.recordId}.body`, CAPTURE_MAX_ARTIFACT_BYTES, captureCipherContext(dataDir, "host", session, `source/${initial.recordId}.body`), true, session.policy.maxBytes);
      record = recordSchema.parse({ ...initial, streamState: "interrupted", bytes: retained.length, sha256: captureSha256(retained) });
      gap = "partial_source";
    } else record = recordSchema.parse(JSON.parse(descriptor.toString("utf8")));
    if (record.captureId !== session.id || record.subjectDigest !== subjectDigest(session) || `${record.recordId}${open ? ".open" : ""}.json` !== entry.name) throw new CaptureStorageError("integrity");
    const bodyName = `${record.recordId}.body`;
    const doneName = `${record.recordId}.done`;
    try {
    if (await exists(join(root, doneName))) {
      await rm(join(root, bodyName), { force: true });
      await rm(join(root, `${record.recordId}.decoded`), { force: true });
      await rm(join(root, entry.name), { force: true });
      continue;
    }
    const original = await captureReadEncrypted(root, bodyName, CAPTURE_MAX_ARTIFACT_BYTES, captureCipherContext(dataDir, "host", session, `source/${bodyName}`), record.streamState === "interrupted", session.policy.maxBytes);
    if (original.length !== record.bytes || captureSha256(original) !== record.sha256) throw new CaptureStorageError("integrity");
    const encoding = typeof record.metadata.contentEncoding === "string" ? record.metadata.contentEncoding.trim().toLowerCase() : "identity";
    const decoded = encoding === "zstd" ? await decodeZstd(dataDir, session, root, record) : decodedBody(original, encoding, record.streamState === "interrupted");
    if (captureContainsPrivateKey(original) || captureContainsPrivateKey(decoded)) throw new CapturePayloadError("privacy_rejected");
    const process = { processSessionId: record.processSessionId, rootPid: record.rootPid, producerPid: record.producerPid, recordId: record.recordId, direction: record.direction, sequence: record.sequence };
    let destinations: string[] = [];
    if (typeof record.metadata.url === "string") {
      const url = new URL(record.metadata.url);
      url.username = ""; url.password = ""; url.search = ""; url.hash = "";
      if (url.toString().length <= 2048) destinations = [url.toString()];
    }
    const base = {
      version: 1 as const, captureId: session.id, source: record.source,
      hostId: session.subject.hostId, runId: null, nativeSessionId: null,
      destinations, transport: record.transport, requestId: record.requestId,
      observedAt: record.observedAt, sourceOffset: 0, streamState: record.streamState,
      payloadSecrets: "not-guaranteed" as const,
    };
    let bodyArtifactId: string | null = null;
    if (original.length > 0) {
      let transformed: { bytes: Uint8Array; redacted: boolean };
      let binary = false;
      try { transformed = redactCapturePayload(decoded); }
      catch (error) {
        if (!(error instanceof CapturePayloadError) || error.code !== "invalid_utf8") throw error;
        transformed = { bytes: decoded, redacted: false };
        binary = true;
      }
      const prepared = capturePreparePayload(original, transformed, CAPTURE_CHUNK_BYTES);
      const fields = {
        ...base, ...prepared.fields, sourceId: `${record.recordId}:body`,
        process: { ...process, role: "body" as const },
        ...(binary ? { models: [], indexLimited: false } : captureReportedModels(prepared.bytes)),
        representation: binary ? "binary" as const : "raw" as const,
        redactionPolicy: binary ? "owner-reviewed-binary-v1" as const : "headers-json-credentials-v1" as const,
        fidelity: original !== decoded ? "normalized-source" as const : transformed.redacted ? "redacted-source" as const : "source-bytes" as const,
      };
      const manifest = captureManifestSchema.parse({ ...fields, artifactId: captureObjectDigest(fields) });
      await spool(manifest, prepared.bytes);
      bodyArtifactId = manifest.artifactId;
    }
    const metadataSource = Buffer.from(JSON.stringify({ ...record, bodyArtifactId }));
    const prepared = capturePreparePayload(metadataSource, redactCapturePayload(metadataSource), CAPTURE_CHUNK_BYTES);
    const fields = {
      ...base, ...prepared.fields, sourceId: `${record.recordId}:metadata`,
      process: { ...process, role: "metadata" as const }, models: [], indexLimited: false,
      representation: "normalized" as const, redactionPolicy: "headers-json-credentials-v1" as const,
      fidelity: "normalized-source" as const,
    };
    const manifest = captureManifestSchema.parse({ ...fields, artifactId: captureObjectDigest(fields) });
    await spool(manifest, prepared.bytes);
    await captureWritePrivate(root, doneName, Buffer.from(manifest.artifactId));
    await rm(join(root, bodyName), { force: true });
    await rm(join(root, `${record.recordId}.decoded`), { force: true });
    await rm(join(root, entry.name), { force: true });
    await captureSyncDirectory(root);
    if (record.streamState !== "complete") gap = "partial_source";
    } catch (error) {
      if (!(error instanceof CapturePayloadError) || error.code !== "privacy_rejected") throw error;
      await captureWritePrivate(root, "gap.json", Buffer.from(JSON.stringify({ phase: "privacy_rejected" })), true);
      await rm(join(root, bodyName), { force: true });
      await rm(join(root, `${record.recordId}.decoded`), { force: true });
      await rm(join(root, entry.name), { force: true });
      await captureSyncDirectory(root);
    }
    } catch (error) {
      gap = error instanceof CaptureStorageError ? error.code : error instanceof CapturePayloadError ? error.code === "invalid_utf8" ? "partial_source" : error.code : "source_unavailable";
    }
  }
  return gap;
}
