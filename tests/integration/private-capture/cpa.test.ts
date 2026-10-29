import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEnvironment, createProject, createThread, noopNotifier, saveExecutionContext, upsertHost } from "@bb/db";
import { CAPTURE_CHUNK_BYTES, executionContextSchema, redactCapturePayload, type CaptureSession } from "@bb/domain";
import { createModelConnectionRequestSchema } from "@bb/server-contract";
import { captureObjectDigest } from "@bb/process-utils";
import { createModelConnectionDefinition, resolveThreadExecutionBinding } from "../../../apps/server/src/services/execution-contexts.js";
import { listCaptureArtifacts, createPrivateCapture, downloadCaptureArtifact, getPrivateCapture, syncPrivateCapture } from "../../../apps/server/src/services/private-captures.js";
import { gatewayLogManifest } from "../../../apps/server/src/services/gateway-logs.js";
import { createTestAppHarness, type TestAppHarness } from "../../../apps/server/test/helpers/test-app.js";
import { captureFixtureKeys, captureSessionFixture } from "../../../apps/host-daemon/test/private-capture-fixtures.js";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function nativeCpaFile(threadId: string, payload: string): Buffer {
  return Buffer.from(`=== REQUEST INFO ===\nVersion: synthetic\nURL: /v1/responses\nMethod: POST\n\n=== HEADERS ===\nContent-Type: application/json\nx-bb-thread-id: ${threadId}\nAuthorization: Bearer SYNTHETIC_HEADER_SECRET\n\n=== REQUEST BODY ===\n${JSON.stringify({ model: "personal/synthetic-model", api_key: "SYNTHETIC_BODY_SECRET", input: payload })}\n\n=== API REQUEST ===\nSYNTHETIC_UPSTREAM_REQUEST\n\n=== API RESPONSE ===\ndata: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"synthetic-tool","name":"synthetic-tool","arguments":"{}"}}\n\ndata: [DONE]\n\n=== RESPONSE ===\nStatus: 200\nSYNTHETIC_RESPONSE_TAIL\n`);
}

describe.skipIf(process.platform !== "linux")("CPA retained-file to encrypted Core delivery", () => {
  let harness: TestAppHarness;
  let root: string;
  let otherRoot: string;
  let session: CaptureSession;
  let releaseKeys: () => void;
  let context: ReturnType<typeof executionContextSchema.parse>;

  beforeEach(async () => {
    harness = await createTestAppHarness({ seedFirstPartyProviders: false });
    root = await mkdtemp(join(tmpdir(), "bb-cpa-capture-source-"));
    otherRoot = await mkdtemp(join(tmpdir(), "bb-cpa-capture-other-"));
    releaseKeys = captureFixtureKeys(harness.config.dataDir);
    const hostId = "synthetic-cpa-host";
    upsertHost(harness.db, noopNotifier, { id: hostId, name: "Synthetic CPA host" });
    const projectId = createProject(harness.db, noopNotifier, { name: "Synthetic Work data", source: { type: "local_path", hostId, path: root } }).project.id;
    const environment = createEnvironment(harness.db, noopNotifier, { projectId, hostId, path: root, status: "ready", providerOwnsPath: false });
    const connection = createModelConnectionDefinition(harness.db, createModelConnectionRequestSchema.parse({
      name: "Synthetic Personal payer", provider: "acp-omp", hostId: null,
      gateway: { baseUrl: "https://personal.example/v1", protocol: "openai-responses", accountPrefix: "personal", modelProvider: "openai-codex", credential: { kind: "env", name: "SYNTHETIC_CPA_KEY_REF" }, allowedHostIds: [hostId] },
    }));
    context = executionContextSchema.parse({ id: "synthetic-work-context", name: "Synthetic Work context", projectIds: [projectId], createdAt: 1, updatedAt: 1 });
    saveExecutionContext(harness.db, context);
    const binding = resolveThreadExecutionBinding(harness.db, { projectId, hostId, provider: "acp-omp", executionContextId: context.id, modelConnectionId: connection.id });
    const thread = createThread(harness.db, noopNotifier, { projectId, environmentId: environment.id, providerId: "acp-omp", executionBinding: binding });
    const fixture = captureSessionFixture(undefined, { projectId, executionContextId: context.id, hostId, threadId: thread.id, runtimeId: thread.providerId, modelConnectionId: connection.id }, { cpaLogs: true });
    session = createPrivateCapture(harness.deps, { id: fixture.id, ...fixture.subject, policy: fixture.policy }).session;
    vi.stubEnv("BB_CPA_LOG_DIRS", JSON.stringify({ "https://personal.example/v1/": root, "https://work.example/v1": otherRoot }));
  });
  afterEach(async () => {
    await harness.cleanup();
    harness.db.$client.close();
    releaseKeys();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
    await rm(otherRoot, { recursive: true, force: true });
  });

  async function source(bytes: Buffer, settled = true): Promise<string> {
    const path = join(root, "request.log");
    await writeFile(path, bytes, { mode: 0o600 });
    if (settled) {
      const past = new Date(Date.now() - 10000);
      await utimes(path, past, past);
    }
    return path;
  }
  function index() { return listCaptureArtifacts(harness.deps, session.id, { projectId: session.subject.projectId, executionContextId: session.subject.executionContextId, limit: 100 }); }

  it("retains the whole selected CPA file including upstream/tool/SSE/tail bytes, encrypts storage, and replays the same committed receipts", async () => {
    const original = nativeCpaFile(session.subject.threadId!, "SYNTHETIC_START" + "x".repeat(2 * CAPTURE_CHUNK_BYTES) + "SYNTHETIC_END");
    const path = await source(original);
    await writeFile(join(otherRoot, "request.log"), nativeCpaFile(session.subject.threadId!, "SYNTHETIC_OTHER_ACCOUNT"), { mode: 0o600 });
    await writeFile(join(root, "foreign.log"), nativeCpaFile("synthetic-foreign-thread", "SYNTHETIC_OTHER_THREAD"), { mode: 0o600 });
    const past = new Date(Date.now() - 10000);
    await utimes(join(otherRoot, "request.log"), past, past);
    await utimes(join(root, "foreign.log"), past, past);
    const nativeManifest = await gatewayLogManifest(root, session.subject.threadId!, Buffer.from("request.log").toString("base64url"));
    const before = await syncPrivateCapture(harness.deps, session.id, session.subject);
    expect(before.gap).toBe("none");
    expect(before.host).toBeNull();
    expect(before.session.subject.executionContextId).toBe(context.id);
    expect(before.session.subject.modelConnectionId).toBe(session.subject.modelConnectionId);
    const [artifact] = index();
    expect(index().map(value => value.manifest.sourceId)).toEqual([`cpa:${nativeManifest.id}`]);
    expect(artifact!.completedAt).not.toBeNull();
    expect(artifact!.manifest.sourceSha256).toBe(nativeManifest.sha256);
    expect(artifact!.manifest.sourceBytes).toBe(original.length);
    expect(artifact!.manifest.chunks.map(value => value.sequence)).toEqual([0, 1, 2]);
    const stored = Buffer.from(await downloadCaptureArtifact(harness.deps, session.id, artifact!.manifest.artifactId, session.subject).arrayBuffer());
    expect(stored).toEqual(Buffer.from(redactCapturePayload(original).bytes));
    expect(sha(stored)).toBe(artifact!.manifest.storedSha256);
    expect(stored.includes("SYNTHETIC_HEADER_SECRET") || stored.includes("SYNTHETIC_BODY_SECRET") || stored.includes("SYNTHETIC_OTHER_ACCOUNT") || stored.includes("SYNTHETIC_OTHER_THREAD")).toBe(false);
    expect(stored.toString()).toContain("SYNTHETIC_RESPONSE_TAIL");
    const directory = join(harness.config.dataDir, "private-capture", "core", captureObjectDigest({ projectId: session.subject.projectId, executionContextId: context.id }), session.id, artifact!.manifest.artifactId);
    for (const chunk of artifact!.manifest.chunks) {
      const disk = await readFile(join(directory, `${chunk.sequence}.chunk`));
      expect(disk.subarray(0, 6)).toEqual(Buffer.from("BBPC1\n"));
      expect(disk.includes(stored.subarray(chunk.sequence * CAPTURE_CHUNK_BYTES, chunk.sequence * CAPTURE_CHUNK_BYTES + Math.min(128, chunk.bytes)))).toBe(false);
    }
    const after = await syncPrivateCapture(harness.deps, session.id, session.subject);
    expect(after.committedChunks).toBe(before.committedChunks);
    expect(after.lastAckAt).toBe(before.lastAckAt);
    expect(index().map(value => [value.manifest.artifactId, value.completedAt, value.committedSequences])).toEqual([[artifact!.manifest.artifactId, artifact!.completedAt, artifact!.committedSequences]]);
    expect(await readFile(path)).toEqual(original);
  });

  it("does not acknowledge an unsettled source and can recover without a sticky old gap", async () => {
    const original = nativeCpaFile(session.subject.threadId!, "SYNTHETIC_SETTLING_BODY");
    const path = await source(original, false);
    const pending = await syncPrivateCapture(harness.deps, session.id, session.subject);
    expect(pending.gap).toBe("partial_source");
    expect(pending.committedChunks).toBe(0);
    expect(index()).toEqual([]);
    const past = new Date(Date.now() - 10000);
    await utimes(path, past, past);
    const committed = await syncPrivateCapture(harness.deps, session.id, session.subject);
    expect(committed.gap).toBe("none");
    expect(committed.gapCount).toBe(pending.gapCount);
    expect(committed.committedChunks).toBe(1);
    const [artifact] = index();
    expect(Buffer.from(await downloadCaptureArtifact(harness.deps, session.id, artifact!.manifest.artifactId, session.subject).arrayBuffer())).toEqual(Buffer.from(redactCapturePayload(original).bytes));
  });

  it("rechecks current scope before releasing decrypted CPA data", async () => {
    await source(nativeCpaFile(session.subject.threadId!, "SYNTHETIC_SCOPE_BODY"));
    await syncPrivateCapture(harness.deps, session.id, session.subject);
    const [artifact] = index();
    const response = downloadCaptureArtifact(harness.deps, session.id, artifact!.manifest.artifactId, session.subject);
    saveExecutionContext(harness.db, { ...context, enabled: false });
    await expect(response.arrayBuffer()).rejects.toThrow("capture_download_unavailable");
    expect(() => getPrivateCapture(harness.deps, session.id, session.subject)).toThrow();
  });
});
