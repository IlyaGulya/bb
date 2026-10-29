import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestAppHarness } from "../../../apps/server/test/helpers/test-app.js";
import type * as FileSystem from "node:fs/promises";
import type * as CaptureService from "../../../apps/server/src/services/private-captures.js";
import type * as CaptureFixtures from "../../../apps/host-daemon/test/private-capture-fixtures.js";
import type * as Database from "@bb/db";
import type * as Domain from "@bb/domain";
import type * as Files from "@bb/process-utils";

const filesystemFault = vi.hoisted((): { directory: string | null } => ({ directory: null }));
vi.mock("node:fs/promises", async importOriginal => {
  const real = await importOriginal<typeof FileSystem>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      if (typeof args[0] !== "string" || args[0] !== filesystemFault.directory) return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === "sync") return async () => { throw Object.assign(new Error("SYNTHETIC_ANCESTOR_SYNC_FAILURE"), { code: "EIO" }); };
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")("capture storage consumer failure boundaries", () => {
  let harness: TestAppHarness | undefined;
  let disposeKeys: (() => void) | undefined;
  let service: typeof CaptureService;
  let fixtures: typeof CaptureFixtures;
  let database: typeof Database;
  let domain: typeof Domain;
  let files: typeof Files;

  beforeEach(async () => {
    harness = undefined;
    disposeKeys = undefined;
    filesystemFault.directory = null;
    const { createTestAppHarness } = await import("../../../apps/server/test/helpers/test-app.js");
    harness = await createTestAppHarness({ seedFirstPartyProviders: false });
    fixtures = await import("../../../apps/host-daemon/test/private-capture-fixtures.js");
    database = await import("@bb/db");
    domain = await import("@bb/domain");
    files = await import("@bb/process-utils");
    service = await import("../../../apps/server/src/services/private-captures.js");
    disposeKeys = fixtures.captureFixtureKeys(harness.config.dataDir);
  });
  afterEach(async () => {
    filesystemFault.directory = null;
    if (harness) {
      await harness.cleanup();
      harness.db.$client.close();
    }
    disposeKeys?.();
    vi.unstubAllEnvs();
  });

  function createCapture() {
    if (!harness) throw new Error("Synthetic capture harness is unavailable");
    const current = harness;
    const hostId = "synthetic-storage-boundary-host";
    database.upsertHost(current.db, database.noopNotifier, { id: hostId, name: "Synthetic storage boundary host" });
    const projectId = database.createProject(current.db, database.noopNotifier, { name: "Synthetic storage boundary", source: { type: "local_path", hostId, path: current.config.dataDir } }).project.id;
    const executionContextId = "synthetic-storage-boundary-context";
    database.saveExecutionContext(current.db, domain.executionContextSchema.parse({ id: executionContextId, name: "Synthetic storage context", projectIds: [projectId], createdAt: 1, updatedAt: 1 }));
    const fixture = fixtures.captureSessionFixture(undefined, { projectId, executionContextId, hostId });
    const session = service.createPrivateCapture(current.deps, { id: fixture.id, ...fixture.subject, policy: fixture.policy }).session;
    return { current, session, scope: { projectId, executionContextId } };
  }

  it.each(["data", "capture", "core", "scope", "session"] as const)("does not commit a chunk ACK when the %s ancestor directory cannot be fsynced", async ancestor => {
    const { current, session, scope } = createCapture();
    const artifact = fixtures.captureArtifactFixture(session, Buffer.from("SYNTHETIC_ANCESTOR_FSYNC_BODY"), "ancestor-fsync-failure");
    service.stageCaptureManifest(current.deps, scope, artifact.manifest);
    const dataDir = await realpath(current.config.dataDir);
    const scopeRoot = join(dataDir, "private-capture", "core", files.captureObjectDigest(scope));
    const ancestors = {
      data: dataDir,
      capture: join(dataDir, "private-capture"),
      core: join(dataDir, "private-capture", "core"),
      scope: scopeRoot,
      session: join(scopeRoot, session.id),
    };
    filesystemFault.directory = ancestors[ancestor];
    const chunk = artifact.manifest.chunks[0]!;
    const outcome = await service.acceptCaptureChunk(current.deps, scope, {
      captureId: session.id, artifactId: artifact.manifest.artifactId,
      sequence: chunk.sequence, sha256: chunk.sha256, base64: artifact.bytes.toString("base64"),
    }).then(receipt => ({ receipt, error: null }), (error: unknown) => ({ receipt: null, error }));
    expect(outcome.receipt).toBeNull();
    expect(outcome.error).toMatchObject({ status: 503, body: { code: "capture_storage_unavailable" } });
    expect(current.db.select({ receiptId: database.privateCaptureChunks.receiptId }).from(database.privateCaptureChunks).all()).toEqual([]);
    const retained = service.captureArtifact(current.deps, session.id, artifact.manifest.artifactId, scope);
    expect(retained.completedAt).toBeNull();
    expect(retained.committedSequences).toEqual([]);
    expect(service.getPrivateCapture(current.deps, session.id, scope).lastAckAt).toBeNull();
  });

  it("returns generic 503 before binary headers when a completed encrypted capture loses its Core key", async () => {
    const { current, session, scope } = createCapture();
    const bytes = Buffer.from("SYNTHETIC_PRIVATE_DOWNLOAD_PAYLOAD_".repeat(9000));
    const artifact = fixtures.captureArtifactFixture(session, bytes, "download-key-unavailable");
    service.stageCaptureManifest(current.deps, scope, artifact.manifest);
    for (const chunk of artifact.manifest.chunks) {
      await service.acceptCaptureChunk(current.deps, scope, {
        captureId: session.id, artifactId: artifact.manifest.artifactId,
        sequence: chunk.sequence, sha256: chunk.sha256,
        base64: bytes.subarray(chunk.sequence * domain.CAPTURE_CHUNK_BYTES, chunk.sequence * domain.CAPTURE_CHUNK_BYTES + chunk.bytes).toString("base64"),
      });
    }
    const query = new URLSearchParams(scope).toString();
    const artifactUrl = `/api/v1/private-captures/${session.id}/artifacts/${artifact.manifest.artifactId}?${query}`;
    const downloadUrl = `/api/v1/private-captures/${session.id}/artifacts/${artifact.manifest.artifactId}/download?${query}`;
    const available = await current.app.request(downloadUrl);
    expect(available.status).toBe(200);
    expect(Buffer.from(await available.arrayBuffer())).toEqual(bytes);
    disposeKeys?.();
    disposeKeys = undefined;
    const missingKey = join(current.config.dataDir, "SYNTHETIC_MISSING_CORE_KEY_REFERENCE");
    vi.stubEnv("BB_PRIVATE_CAPTURE_CORE_KEY_REF", `memory-file:${missingKey}`);
    const metadata = await current.app.request(artifactUrl);
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      completedAt: expect.any(Number), committedSequences: [0, 1],
      manifest: { artifactId: artifact.manifest.artifactId, storedSha256: artifact.manifest.storedSha256 },
    });
    const unavailable = await current.app.request(downloadUrl);
    try {
      expect(unavailable.status).toBe(503);
      expect(unavailable.headers.get("content-type")).toContain("application/json");
      expect(unavailable.headers.get("content-disposition")).toBeNull();
      const text = await unavailable.text();
      expect(JSON.parse(text)).toMatchObject({ code: "capture_storage_unavailable" });
      for (const sensitive of [missingKey, current.config.dataDir, "memory-file:", "SYNTHETIC_PRIVATE_DOWNLOAD_PAYLOAD", "SYNTHETIC_MISSING_CORE_KEY_REFERENCE"]) expect(text).not.toContain(sensitive);
    } finally {
      await unavailable.body?.cancel().catch(() => {});
    }
    const retained = service.captureArtifact(current.deps, session.id, artifact.manifest.artifactId, scope);
    expect(retained.completedAt).not.toBeNull();
    expect(retained.committedSequences).toEqual([0, 1]);
  });
});
