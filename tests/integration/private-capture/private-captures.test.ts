import { mkdtemp, lstat, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createConnection, createProject, noopNotifier, privateCaptureChunks,
  saveExecutionContext, upsertHost,
} from "@bb/db";
import { CAPTURE_CHUNK_BYTES, executionContextSchema } from "@bb/domain";
import { hostDaemonServerWsMessageSchema, hostDaemonOnlineRpcResponseMessageSchema } from "@bb/host-daemon-contract";
import { captureObjectDigest } from "@bb/process-utils";
import {
  acceptCaptureChunk, captureArtifact, createPrivateCapture, downloadCaptureArtifact,
  stageCaptureManifest, syncPrivateCapture,
} from "../../../apps/server/src/services/private-captures.js";
import { createTestAppHarness, type TestAppHarness } from "../../../apps/server/test/helpers/test-app.js";
import { exchangeHostCapture, startHostCaptureOutbox } from "../../../apps/host-daemon/src/private-capture.js";
import {
  captureArtifactFixture, captureSessionFixture, orderedCaptureArtifacts,
  writeCaptureArtifactFixture, writeCaptureSessionFixture,
  captureFixtureKeys,
} from "../../../apps/host-daemon/test/private-capture-fixtures.js";

describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")("private capture Core consumer boundaries", () => {
  let harness: TestAppHarness;
  let hostRoot: string;
  let disposeKeys: () => void;
  const hostId = "host_capture_regression";
  const connectionId = "synthetic-capture-peer";

  beforeEach(async () => {
    harness = await createTestAppHarness({ seedFirstPartyProviders: false });
    hostRoot = await mkdtemp(join(tmpdir(), "bb-capture-core-peer-"));
    disposeKeys = captureFixtureKeys(hostRoot, harness.config.dataDir);
    upsertHost(harness.db, noopNotifier, { id: hostId, name: "Synthetic capture host" });
  });
  afterEach(async () => {
    harness.hub.unregisterDaemon(connectionId);
    const lifecycle = startHostCaptureOutbox(hostRoot);
    await lifecycle.stop();
    await harness.cleanup();
    harness.db.$client.close();
    await rm(hostRoot, { recursive: true, force: true });
    disposeKeys();
  });

  function createCapture(withHostDelivery = false) {
    const projectId = createProject(harness.db, noopNotifier, {
      name: "Synthetic private capture", source: { type: "local_path", hostId, path: hostRoot },
    }).project.id;
    const executionContextId = "context_capture_regression";
    saveExecutionContext(harness.db, executionContextSchema.parse({
      id: executionContextId, name: "Synthetic private context", projectIds: [projectId],
      createdAt: 1, updatedAt: 1,
    }));
    const fixture = captureSessionFixture(undefined, { projectId, executionContextId, hostId }, {
      nativeExports: withHostDelivery ? [{
        sourceId: "removed-export", relativePath: "no-longer-present.bin", representation: "binary",
        binaryReview: "owner-reviewed-no-auth-material",
      }] : [],
    });
    return createPrivateCapture(harness.deps, { id: fixture.id, ...fixture.subject, policy: fixture.policy }).session;
  }

  function registerRealCapturePeer() {
    harness.hub.registerDaemon(connectionId, hostId, {
      close() {},
      send(data: string) {
        const message = hostDaemonServerWsMessageSchema.parse(JSON.parse(data));
        if (message.type !== "host-rpc.request") return;
        const deliver = async () => {
          try {
            if (message.command.type !== "capture.exchange") throw new Error("Unexpected synthetic host command");
            const result = await exchangeHostCapture(hostRoot, message.command);
            harness.hub.recordHostOnlineRpcResponse({
              sessionId: connectionId,
              message: hostDaemonOnlineRpcResponseMessageSchema.parse({
                type: "host-rpc.response", requestId: message.requestId,
                commandType: message.command.type, ok: true, result,
              }),
            });
          } catch {
            harness.hub.recordHostOnlineRpcResponse({
              sessionId: connectionId,
              message: hostDaemonOnlineRpcResponseMessageSchema.parse({
                type: "host-rpc.response", requestId: message.requestId,
                commandType: message.command.type, ok: false,
                errorCode: "synthetic_capture_exchange_failed", errorMessage: "Synthetic capture exchange failed",
              }),
            });
          }
        };
        void deliver();
      },
    });
  }

  it.each([0, CAPTURE_CHUNK_BYTES])("denies completion and body access for a multiline escaped credential after %i bytes of padding", async padding => {
    const session = createCapture();
    const scope = { projectId: session.subject.projectId, executionContextId: session.subject.executionContextId };
    const source = Buffer.from(`{\n  "safe": "${"s".repeat(padding)}",\n  "\\u0078-api-key": "SYNTHETIC_SECRET"\n}\n`);
    const artifact = captureArtifactFixture(session, source, "escaped-credential");
    stageCaptureManifest(harness.deps, scope, artifact.manifest);
    for (const chunk of artifact.manifest.chunks.slice(0, -1)) {
      await acceptCaptureChunk(harness.deps, scope, {
        captureId: session.id, artifactId: artifact.manifest.artifactId,
        sequence: chunk.sequence, sha256: chunk.sha256,
        base64: source.subarray(chunk.sequence * CAPTURE_CHUNK_BYTES, chunk.sequence * CAPTURE_CHUNK_BYTES + chunk.bytes).toString("base64"),
      });
    }
    const last = artifact.manifest.chunks.at(-1)!;
    await expect(acceptCaptureChunk(harness.deps, scope, {
      captureId: session.id, artifactId: artifact.manifest.artifactId,
      sequence: last.sequence, sha256: last.sha256,
      base64: source.subarray(last.sequence * CAPTURE_CHUNK_BYTES).toString("base64"),
    })).rejects.toMatchObject({ status: 403, body: { code: "capture_privacy_rejected" } });
    const rejected = captureArtifact(harness.deps, session.id, artifact.manifest.artifactId, scope);
    expect(rejected.rejectedAt).not.toBeNull();
    expect(rejected.completedAt).toBeNull();
    expect(rejected.committedSequences).toEqual([]);
    expect(() => downloadCaptureArtifact(harness.deps, session.id, artifact.manifest.artifactId, scope)).toThrow();
  });

  it("propagates a Core privacy rejection to the real host and permits the next artifact to commit", async () => {
    const session = createCapture(true);
    const scope = { projectId: session.subject.projectId, executionContextId: session.subject.executionContextId };
    const forbidden = Buffer.from("SYNTHETIC_BINARY\u0000-----BEGIN PRIVATE KEY-----\nSYNTHETIC_NOT_A_REAL_KEY\n-----END PRIVATE KEY-----");
    const pair = orderedCaptureArtifacts(session, forbidden, Buffer.from("SYNTHETIC_LATER_DELIVERY"));
    await writeCaptureSessionFixture(hostRoot, session);
    const rejectedRoot = await writeCaptureArtifactFixture(hostRoot, pair.earlier);
    await writeCaptureArtifactFixture(hostRoot, pair.later);
    registerRealCapturePeer();

    await syncPrivateCapture(harness.deps, session.id, scope);
    await syncPrivateCapture(harness.deps, session.id, scope);

    const rejected = captureArtifact(harness.deps, session.id, pair.earlier.manifest.artifactId, scope);
    expect(rejected.rejectedAt).not.toBeNull();
    expect(rejected.completedAt).toBeNull();
    await expect(lstat(join(rejectedRoot, "0.chunk"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(captureArtifact(harness.deps, session.id, pair.later.manifest.artifactId, scope).completedAt).not.toBeNull();
    expect(Buffer.from(await downloadCaptureArtifact(harness.deps, session.id, pair.later.manifest.artifactId, scope).arrayBuffer())).toEqual(pair.later.bytes);
  });

  it.each([false, true])("audits a restarted SQLite receipt with missing ancestor = %s without claiming a power-loss proof", async missingAncestor => {
    const session = createCapture();
    const scope = { projectId: session.subject.projectId, executionContextId: session.subject.executionContextId };
    const artifact = captureArtifactFixture(session, Buffer.from("SYNTHETIC_COMMITTED_ANCESTOR_PAYLOAD"), "ancestor-receipt");
    stageCaptureManifest(harness.deps, scope, artifact.manifest);
    const chunk = {
      captureId: session.id, artifactId: artifact.manifest.artifactId, sequence: 0,
      sha256: artifact.manifest.chunks[0]!.sha256, base64: artifact.bytes.toString("base64"),
    };
    const committed = await acceptCaptureChunk(harness.deps, scope, chunk);
    const snapshot = join(harness.config.dataDir, "capture-receiver-restart.sqlite");
    await writeFile(snapshot, harness.db.$client.serialize(), { mode: 0o600 });
    const reopened = createConnection(snapshot);
    try {
      const receiver = { ...harness.deps, db: reopened };
      const receipt = reopened.select().from(privateCaptureChunks).where(and(eq(privateCaptureChunks.captureId, session.id), eq(privateCaptureChunks.artifactId, artifact.manifest.artifactId))).all();
      expect(receipt.map(row => row.receiptId)).toEqual([committed.receiptId]);
      if (missingAncestor) {
        await rm(join(harness.config.dataDir, "private-capture", "core", captureObjectDigest(scope)), { recursive: true });
        await expect(acceptCaptureChunk(receiver, scope, chunk)).rejects.toMatchObject({ code: "storage_unavailable" });
        await expect(downloadCaptureArtifact(receiver, session.id, artifact.manifest.artifactId, scope).arrayBuffer()).rejects.toThrow("capture_download_unavailable");
      } else {
        const replay = await acceptCaptureChunk(receiver, scope, chunk);
        expect(replay.status).toBe("duplicate");
        expect(replay.receiptId).toBe(committed.receiptId);
        expect(Buffer.from(await downloadCaptureArtifact(receiver, session.id, artifact.manifest.artifactId, scope).arrayBuffer())).toEqual(artifact.bytes);
      }
      expect(reopened.select().from(privateCaptureChunks).where(eq(privateCaptureChunks.captureId, session.id)).all().map(row => row.receiptId)).toEqual([committed.receiptId]);
    } finally { reopened.$client.close(); }
  });
});
