import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CAPTURE_CHUNK_BYTES, type CaptureSession } from "@bb/domain";
import { exchangeHostCapture, startHostCaptureOutbox } from "../src/private-capture.js";
import {
  captureAckFixture, captureArtifactFixture, captureSessionFixture,
  orderedCaptureArtifacts, writeCaptureArtifactFixture, writeCaptureSessionFixture,
  captureFixtureKeys, readCaptureFixtureBody,
} from "./private-capture-fixtures.js";

const forbiddenBinary = Buffer.from("SYNTHETIC_BINARY\u0000-----BEGIN PRIVATE KEY-----\nSYNTHETIC_NOT_A_REAL_KEY\n-----END PRIVATE KEY-----");

describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")("private host capture restart states", () => {
  let root: string;
  let disposeKeys: () => void;
  const lifecycles: ReturnType<typeof startHostCaptureOutbox>[] = [];
  const readOnlyRoots: string[] = [];
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "bb-capture-host-regression-")); disposeKeys = captureFixtureKeys(root); });
  afterEach(async () => {
    for (const lifecycle of lifecycles.splice(0)) await lifecycle.stop();
    for (const directory of readOnlyRoots.splice(0)) await chmod(directory, 0o700);
    const cleanup = startHostCaptureOutbox(root);
    await cleanup.stop();
    await rm(root, { recursive: true, force: true });
    disposeKeys();
  });

  function exchange(session: CaptureSession, poll = true) {
    return exchangeHostCapture(root, { type: "capture.exchange", session, leaseUntil: Math.min(session.expiresAt, Date.now() + 300000), ack: null, poll });
  }

  async function sweepThroughDaemonLifecycle() {
    const lifecycle = startHostCaptureOutbox(root);
    await lifecycle.stop();
  }

  it("does not spool a reviewed binary export containing a forbidden private-key marker", async () => {
    const session = captureSessionFixture(undefined, {}, { nativeExports: [
      { sourceId: "synthetic-binary", relativePath: "export.bin", representation: "binary", binaryReview: "owner-reviewed-no-auth-material" },
    ] });
    const source = join(root, "private-capture-input", session.id);
    await mkdir(source, { recursive: true, mode: 0o700 });
    await writeFile(join(source, "export.bin"), forbiddenBinary, { mode: 0o600 });
    const result = await exchange(session);
    expect(result.status.gap).toBe("privacy_rejected");
    expect(result.chunk).toBeNull();
    expect(result.manifest).toBeNull();
    expect(result.status.pendingBytes).toBe(0);
    expect(await readFile(join(source, "export.bin"))).toEqual(forbiddenBinary);
    const outbox = join(root, "private-capture", "host", session.id, "outbox");
    expect(await readdir(outbox).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
      throw error;
    })).toEqual([]);
  });

  it("does not publish a manifest with a missing later chunk or let it block a complete artifact", async () => {
    const session = captureSessionFixture();
    await writeCaptureSessionFixture(root, session);
    const pair = orderedCaptureArtifacts(session, Buffer.alloc(CAPTURE_CHUNK_BYTES + 19, 65), Buffer.from("SYNTHETIC_COMPLETE_ARTIFACT"));
    const incomplete = await writeCaptureArtifactFixture(root, pair.earlier, [0]);
    await writeCaptureArtifactFixture(root, pair.later);
    const result = await exchange(session);
    expect(result.manifest?.artifactId).toBe(pair.later.manifest.artifactId);
    expect(Buffer.from(result.chunk!.base64, "base64")).toEqual(pair.later.bytes);
    expect(result.status.gap).not.toBe("none");
    expect(await readCaptureFixtureBody(root, session, pair.earlier.manifest, 0)).toEqual(pair.earlier.bytes.subarray(0, CAPTURE_CHUNK_BYTES));
    expect((await readFile(join(incomplete, "0.chunk"))).includes(pair.earlier.bytes.subarray(0, 256))).toBe(false);
  });

  async function retentionPair() {
    const earlier = captureSessionFixture("00000000-0000-4000-8000-000000000001");
    const later = { ...captureSessionFixture("00000000-0000-4000-8000-000000000002"), createdAt: Date.now() - 7200000, expiresAt: Date.now() - 60000 };
    const earlierRoot = await writeCaptureSessionFixture(root, earlier);
    await writeCaptureSessionFixture(root, later);
    const retained = await writeCaptureArtifactFixture(root, captureArtifactFixture(later, Buffer.from("SYNTHETIC_EXPIRED_RAW"), "expired"));
    return { earlierRoot, retained };
  }

  it("does not let an earlier capture's corrupt state starve another capture's retention", async () => {
    const { earlierRoot, retained } = await retentionPair();
    await writeFile(join(earlierRoot, "state.json"), "{invalid-json", { mode: 0o600 });
    await sweepThroughDaemonLifecycle();
    await expect(lstat(join(retained, "0.chunk"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.getuid?.() === 0)("continues other retention work when a private state write is denied", async () => {
    const { earlierRoot, retained } = await retentionPair();
    await chmod(earlierRoot, 0o500);
    readOnlyRoots.push(earlierRoot);
    await sweepThroughDaemonLifecycle();
    await expect(lstat(join(retained, "0.chunk"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["manifest.json", "acks.json"])("expires private bytes even when the artifact %s cannot be decoded", async metadata => {
    const session = { ...captureSessionFixture(), createdAt: Date.now() - 7200000, expiresAt: Date.now() - 60000 };
    await writeCaptureSessionFixture(root, session);
    const directory = await writeCaptureArtifactFixture(root, captureArtifactFixture(session, Buffer.from("SYNTHETIC_EXPIRED_CORRUPT_METADATA"), "corrupt-expired"));
    await writeFile(join(directory, metadata), "{invalid-json", { mode: 0o600 });
    await sweepThroughDaemonLifecycle();
    await expect(lstat(join(directory, "0.chunk"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reconciles raw chunks left behind after a durable ACK and does not retransmit or hide them from accounting", async () => {
    const session = captureSessionFixture();
    const bytes = Buffer.alloc(CAPTURE_CHUNK_BYTES + 23, 66);
    const artifact = captureArtifactFixture(session, bytes, "ack-before-delete");
    await writeCaptureSessionFixture(root, session, { pendingBytes: bytes.length, pendingChunks: 2, artifacts: 1 });
    const ack = captureAckFixture(artifact.manifest, 0);
    const directory = await writeCaptureArtifactFixture(root, artifact, [0, 1], [ack]);
    const result = await exchange(session);
    expect(result.chunk?.sequence).toBe(1);
    expect(Buffer.from(result.chunk!.base64, "base64")).toEqual(bytes.subarray(CAPTURE_CHUNK_BYTES));
    expect(result.status.pendingBytes).toBe(23);
    expect(result.status.pendingChunks).toBe(1);
    await expect(lstat(join(directory, "0.chunk"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readCaptureFixtureBody(root, session, artifact.manifest, 1)).toEqual(bytes.subarray(CAPTURE_CHUNK_BYTES));
    expect((await readFile(join(directory, "1.chunk"))).includes(bytes.subarray(CAPTURE_CHUNK_BYTES))).toBe(false);
  });

  it("reconciles a fully acknowledged artifact during daemon recovery without another ACK command", async () => {
    const session = captureSessionFixture();
    const artifact = captureArtifactFixture(session, Buffer.from("SYNTHETIC_ACKED_BUT_NOT_UNLINKED"), "ack-recovery");
    await writeCaptureSessionFixture(root, session, { pendingBytes: artifact.bytes.length, pendingChunks: 1, artifacts: 1 });
    const directory = await writeCaptureArtifactFixture(root, artifact, [0], [captureAckFixture(artifact.manifest, 0)]);
    await sweepThroughDaemonLifecycle();
    const lifecycle = startHostCaptureOutbox(root);
    lifecycles.push(lifecycle);
    const result = await exchange(session, false);
    expect(result.chunk).toBeNull();
    expect(result.status.pendingBytes).toBe(0);
    await expect(lstat(join(directory, "0.chunk"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not exceed physical quota or delete ciphertext while publishing a larger ACK file", async () => {
    const session = captureSessionFixture();
    const artifact = captureArtifactFixture(session, Buffer.from("SYNTHETIC_QUOTA_RETAINED_BODY"), "ack-quota");
    await writeCaptureSessionFixture(root, session);
    const directory = await writeCaptureArtifactFixture(root, artifact);
    let retained = 0;
    for (const name of await readdir(directory)) retained += (await lstat(join(directory, name))).size;
    const padding = join(directory, "quota-padding.bin");
    const handle = await open(padding, "wx", 0o600);
    try { await handle.truncate(512 * 1024 * 1024 - retained - 128); } finally { await handle.close(); }
    const command = { type: "capture.exchange" as const, session, leaseUntil: Math.min(session.expiresAt, Date.now() + 300000), ack: captureAckFixture(artifact.manifest, 0), poll: false };
    await expect(exchangeHostCapture(root, command)).rejects.toThrow("source_limit");
    expect(await readFile(join(directory, "acks.json"), "utf8")).toBe("[]");
    expect(await readCaptureFixtureBody(root, session, artifact.manifest, 0)).toEqual(artifact.bytes);
    await rm(padding);
    const recovered = await exchangeHostCapture(root, command);
    expect(recovered.status.pendingChunks).toBe(0);
    await expect(lstat(join(directory, "0.chunk"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
