import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  CAPTURE_CHUNK_BYTES, captureManifestSchema, captureSessionSchema,
  type CaptureAck, type CaptureManifest, type CaptureSession, type CaptureOutboxStatus,
} from "@bb/domain";
import { captureObjectDigest, capturePreparePayload, capturePrivateDirectory, captureCipherContext, captureReadEncrypted, captureWriteEncrypted, registerCaptureKeyProvider } from "@bb/process-utils";

export const captureFixtureId = "00000000-0000-4000-8000-000000000001";

export function captureFixtureKeys(...directories: string[]): () => void {
  const keys: Buffer[] = [];
  const release: Array<() => void> = [];
  for (const directory of directories) for (const role of ["host", "core"] as const) {
    const key = randomBytes(32);
    keys.push(key);
    release.push(registerCaptureKeyProvider(directory, role, async () => key));
  }
  return () => { for (const dispose of release) dispose(); for (const key of keys) key.fill(0); };
}
export function readCaptureFixtureBody(dataDir: string, session: CaptureSession, manifest: CaptureManifest, sequence: number): Promise<Buffer> {
  return captureReadEncrypted(join(dataDir, "private-capture", "host", session.id, "outbox", manifest.artifactId), `${sequence}.chunk`, CAPTURE_CHUNK_BYTES, captureCipherContext(dataDir, "host", session, `${manifest.artifactId}/${sequence}.chunk`));
}

export function captureSessionFixture(
  id = captureFixtureId,
  subject: Partial<CaptureSession["subject"]> = {},
  policy: Partial<CaptureSession["policy"]> = {},
): CaptureSession {
  const now = Date.now();
  return captureSessionSchema.parse({
    id, enabled: true, createdAt: now, expiresAt: now + 3600000,
    subject: {
      projectId: "proj_capture_regression", executionContextId: "context_capture_regression",
      hostId: "host_capture_regression", threadId: null, runId: null, nativeSessionId: null,
      runtimeId: "omp", runtimeVersion: null, modelConnectionId: null, model: null,
      ...subject,
    },
    policy: {
      consent: "private-full-content", payloadReview: "owner-approved-sensitive-application-data",
      retentionHours: 1, maxBytes: 4 * 1024 * 1024, maxArtifacts: 32,
      syncIntervalSeconds: 30, offlineLeaseSeconds: 300,
      bridgeRecorder: false, nativeEvents: false, cpaLogs: false, nativeExports: [],
      ...policy,
    },
  });
}

export function captureArtifactFixture(
  session: CaptureSession,
  bytes: Buffer,
  sourceId: string,
  representation: "raw" | "binary" = "raw",
): { manifest: CaptureManifest; bytes: Buffer } {
  const prepared = capturePreparePayload(bytes, CAPTURE_CHUNK_BYTES);
  const fields = {
    version: 2 as const, captureId: session.id, source: "owner-import" as const, sourceId,
    hostId: session.subject.hostId, runId: null, nativeSessionId: null,
    models: [], indexLimited: false, destinations: [], transport: "file" as const,
    requestId: null, observedAt: null, sourceOffset: 0, ...prepared.fields,
    representation, streamState: "complete" as const, fidelity: "source-bytes" as const,
    redactionPolicy: "source-preserved-v2" as const,
    payloadSecrets: "not-guaranteed" as const,
  };
  return { manifest: captureManifestSchema.parse({ ...fields, artifactId: captureObjectDigest(fields) }), bytes };
}

export function orderedCaptureArtifacts(session: CaptureSession, first: Buffer, second: Buffer) {
  const variants = Array.from({ length: 64 }, (_, index) => ({
    first: captureArtifactFixture(session, first, `synthetic-first-${index}`, "binary"),
    second: captureArtifactFixture(session, second, `synthetic-second-${index}`),
  }));
  const earlier = variants.map(value => value.first).sort((a, b) => a.manifest.artifactId.localeCompare(b.manifest.artifactId))[0]!;
  const later = variants.map(value => value.second).find(value => value.manifest.artifactId > earlier.manifest.artifactId);
  if (!later) throw new Error("Synthetic fixture has no ordered artifact pair");
  return { earlier, later };
}

export async function writeCaptureSessionFixture(dataDir: string, session: CaptureSession, status: Partial<CaptureOutboxStatus> = {}): Promise<string> {
  const directory = await capturePrivateDirectory(dataDir, "host", session.id);
  await writeFile(join(directory, "session.json"), JSON.stringify(session), { mode: 0o600 });
  await writeFile(join(directory, "state.json"), JSON.stringify({
    leaseUntil: Math.min(session.expiresAt, Date.now() + session.policy.offlineLeaseSeconds * 1000),
    nextScanAt: 0, cursors: {},
    status: { pendingBytes: 0, pendingChunks: 0, artifacts: 0, lastAckAt: null, gap: "none", droppedBytes: 0, ...status },
  }), { mode: 0o600 });
  return directory;
}

export async function writeCaptureArtifactFixture(
  dataDir: string,
  artifact: ReturnType<typeof captureArtifactFixture>,
  sequences = artifact.manifest.chunks.map(chunk => chunk.sequence),
  acknowledgements: CaptureAck[] = [],
): Promise<string> {
  const directory = await capturePrivateDirectory(dataDir, "host", artifact.manifest.captureId, "outbox", artifact.manifest.artifactId);
  const session = captureSessionSchema.parse(JSON.parse(await readFile(join(dataDir, "private-capture", "host", artifact.manifest.captureId, "session.json"), "utf8")));
  await writeFile(join(directory, "manifest.json"), JSON.stringify(artifact.manifest), { mode: 0o600 });
  for (const sequence of sequences) {
    const chunk = artifact.manifest.chunks[sequence]!;
    await captureWriteEncrypted(directory, `${sequence}.chunk`, artifact.bytes.subarray(sequence * CAPTURE_CHUNK_BYTES, sequence * CAPTURE_CHUNK_BYTES + chunk.bytes), captureCipherContext(dataDir, "host", session, `${artifact.manifest.artifactId}/${sequence}.chunk`));
  }
  await writeFile(join(directory, "acks.json"), JSON.stringify(acknowledgements), { mode: 0o600 });
  return directory;
}

export function captureAckFixture(manifest: CaptureManifest, sequence: number): CaptureAck {
  const identity = { captureId: manifest.captureId, artifactId: manifest.artifactId, sequence, sha256: manifest.chunks[sequence]!.sha256 };
  return { ...identity, receiptId: captureObjectDigest(identity), committedAt: Date.now(), status: "accepted" };
}
