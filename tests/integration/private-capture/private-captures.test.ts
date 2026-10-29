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
import { createPrivateCapturesArea } from "../../../packages/sdk/src/areas/private-captures.js";
import { createHttpTransport } from "../../../packages/sdk/src/transport-http.js";

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

  it.each(["raw", "transcript", "binary"] as const)("round-trips every authorized %s byte through SDK upload, real Core routes and encrypted storage", async representation => {
    const session = createCapture();
    const scope = { projectId: session.subject.projectId, executionContextId: session.subject.executionContextId };
    const source = Buffer.concat([
      Buffer.alloc(CAPTURE_CHUNK_BYTES - 10, 115),
      Buffer.from('Authorization: Bearer SYNTHETIC_HEADER_SECRET\r\n=== REQUEST BODY ===\n' + JSON.stringify({ input: JSON.stringify({ authorization: "SYNTHETIC_NESTED_SECRET" }), "\\u0078-api-key": "SYNTHETIC_ESCAPED_SECRET" }, null, 2)),
      Buffer.from('\n-----BEGIN PRIVATE KEY-----\nSYNTHETIC_NOT_A_REAL_KEY\n-----END PRIVATE KEY-----\n'),
      Buffer.from([0, 255, 254, 128]),
    ]);
    const api = createPrivateCapturesArea({ transport: createHttpTransport({
      baseUrl: "http://localhost", runtime: "browser",
      fetch: async (input, init) => harness.app.request(new Request(input, init)),
    }) });
    const input = { ...scope, captureId: session.id, operationId: "00000000-0000-4000-8000-000000000002", sourceId: `sensitive-${representation}`, file: new Blob([source]), representation, streamState: "unknown" as const };
    const artifact = await api.upload(input);
    expect(artifact.completedAt).not.toBeNull();
    expect(artifact.rejectedAt).toBeNull();
    expect(artifact.manifest).toMatchObject({ version: 2, redacted: false, fidelity: "source-bytes", redactionPolicy: "source-preserved-v2", sourceBytes: source.length, storedBytes: source.length });
    expect(artifact.manifest.sourceSha256).toBe(artifact.manifest.storedSha256);
    const downloaded = await api.download({ ...scope, captureId: session.id, artifactId: artifact.manifest.artifactId });
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(source);
    const replay = await api.upload(input);
    expect(replay.manifest.artifactId).toBe(artifact.manifest.artifactId);
    expect(replay.completedAt).toBe(artifact.completedAt);
    expect(replay.committedSequences).toEqual([0, 1]);
  });

  it("commits credential-bearing host evidence through the real exchange and ACK deletion path", async () => {
    const session = createCapture(true);
    const scope = { projectId: session.subject.projectId, executionContextId: session.subject.executionContextId };
    const sensitive = Buffer.from("SYNTHETIC_BINARY\u0000-----BEGIN PRIVATE KEY-----\nSYNTHETIC_NOT_A_REAL_KEY\n-----END PRIVATE KEY-----");
    const pair = orderedCaptureArtifacts(session, sensitive, Buffer.from("SYNTHETIC_LATER_DELIVERY"));
    await writeCaptureSessionFixture(hostRoot, session);
    const earlierRoot = await writeCaptureArtifactFixture(hostRoot, pair.earlier);
    await writeCaptureArtifactFixture(hostRoot, pair.later);
    registerRealCapturePeer();
    await syncPrivateCapture(harness.deps, session.id, scope);
    await syncPrivateCapture(harness.deps, session.id, scope);
    for (const artifact of [pair.earlier, pair.later]) {
      const retained = captureArtifact(harness.deps, session.id, artifact.manifest.artifactId, scope);
      expect(retained.rejectedAt).toBeNull();
      expect(retained.completedAt).not.toBeNull();
      expect(Buffer.from(await (await downloadCaptureArtifact(harness.deps, session.id, artifact.manifest.artifactId, scope)).arrayBuffer())).toEqual(artifact.bytes);
    }
    await expect(lstat(join(earlierRoot, "0.chunk"))).rejects.toMatchObject({ code: "ENOENT" });
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
        await expect(downloadCaptureArtifact(receiver, session.id, artifact.manifest.artifactId, scope)).rejects.toMatchObject({ code: "storage_unavailable" });
      } else {
        const replay = await acceptCaptureChunk(receiver, scope, chunk);
        expect(replay.status).toBe("duplicate");
        expect(replay.receiptId).toBe(committed.receiptId);
        expect(Buffer.from(await (await downloadCaptureArtifact(receiver, session.id, artifact.manifest.artifactId, scope)).arrayBuffer())).toEqual(artifact.bytes);
      }
      expect(reopened.select().from(privateCaptureChunks).where(eq(privateCaptureChunks.captureId, session.id)).all().map(row => row.receiptId)).toEqual([committed.receiptId]);
    } finally { reopened.$client.close(); }
  });
});
