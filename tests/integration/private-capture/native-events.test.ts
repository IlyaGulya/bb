import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import {
  createConnection, createEnvironment, createProject, createThread, events, noopNotifier,
  privateCaptureArtifacts, privateCaptureChunks, privateCaptureSessions,
  saveExecutionContext, upsertHost,
} from "@bb/db";
import { captureManifestSchema, executionContextSchema } from "@bb/domain";
import {
  captureCipherContext, captureObjectDigest, capturePrivateDirectory,
  captureSha256, captureWriteEncrypted,
} from "@bb/process-utils";
import { resolveThreadExecutionBinding } from "../../../apps/server/src/services/execution-contexts.js";
import {
  createPrivateCapture, downloadCaptureArtifact, listCaptureArtifacts, syncPrivateCapture,
} from "../../../apps/server/src/services/private-captures.js";
import { createTestAppHarness } from "../../../apps/server/test/helpers/test-app.js";
import type { TestAppHarness } from "../../../apps/server/test/helpers/test-app.js";
import {
  captureAckFixture, captureArtifactFixture, captureFixtureKeys, captureSessionFixture,
} from "../../../apps/host-daemon/test/private-capture-fixtures.js";

describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")("native-event capture replay recovery", () => {
  let harness: TestAppHarness;
  let disposeKeys: () => void;
  let activeDb: ReturnType<typeof createConnection> | undefined;

  beforeEach(async () => {
    harness = await createTestAppHarness({ seedFirstPartyProviders: false });
    disposeKeys = captureFixtureKeys(harness.config.dataDir);
    activeDb = undefined;
  });
  afterEach(async () => {
    activeDb?.$client.close();
    await harness.cleanup();
    harness.db.$client.close();
    disposeKeys();
  });

  it("backfills every retained native event after a completed v2 artifact loses its cursor update and SQLite reopens", async () => {
    const hostId = "synthetic-native-replay-host";
    upsertHost(harness.db, noopNotifier, { id: hostId, name: "Synthetic replay host" });
    const projectId = createProject(harness.db, noopNotifier, {
      name: "Synthetic native replay", source: { type: "local_path", hostId, path: harness.config.dataDir },
    }).project.id;
    const environment = createEnvironment(harness.db, noopNotifier, {
      projectId, hostId, path: harness.config.dataDir, status: "ready", providerOwnsPath: false,
    });
    const executionContextId = "synthetic-native-replay-context";
    saveExecutionContext(harness.db, executionContextSchema.parse({
      id: executionContextId, name: "Synthetic native replay context", projectIds: [projectId], createdAt: 1, updatedAt: 1,
    }));
    const binding = resolveThreadExecutionBinding(harness.db, { projectId, hostId, provider: "acp-omp", executionContextId });
    const thread = createThread(harness.db, noopNotifier, { projectId, environmentId: environment.id, providerId: "acp-omp", executionBinding: binding });
    const sourceEvents = harness.db.insert(events).values([1, 2, 100].map(sequence => ({
      id: `synthetic-native-event-${sequence}`, threadId: thread.id, environmentId: environment.id,
      scopeKind: "thread" as const, sequence, type: "system/error" as const,
      data: JSON.stringify({ message: `SYNTHETIC_NATIVE_${sequence}`, authorization: `SYNTHETIC_EMBEDDED_${sequence}` }),
      createdAt: sequence,
    }))).returning().all();
    const path = join(harness.config.dataDir, "native-event-replay.sqlite");
    await writeFile(path, harness.db.$client.serialize(), { mode: 0o600 });
    let db = createConnection(path);
    activeDb = db;
    let deps = { ...harness.deps, db };
    const scope = { projectId, executionContextId };
    const fixture = captureSessionFixture(undefined, {
      ...scope, hostId, threadId: thread.id, runtimeId: thread.providerId,
    }, { nativeEvents: true });
    const session = createPrivateCapture(deps, { id: fixture.id, ...fixture.subject, policy: fixture.policy }).session;
    const historical: {
      manifest: ReturnType<typeof captureManifestSchema.parse>;
      bytes: Buffer;
      directory: string;
      ciphertext: Buffer;
    }[] = [];
    for (const event of sourceEvents) {
      const original = Buffer.from(JSON.stringify(event));
      const bytes = Buffer.from(JSON.stringify({ ...event, data: JSON.stringify({ message: "[REDACTED]" }) }));
      const { artifactId: _artifactId, ...base } = captureArtifactFixture(session, bytes, `event:${event.id}:${event.sequence}`).manifest;
      const fields = {
        ...base, version: 1 as const, source: "native-events" as const,
        sourceBytes: original.length, sourceSha256: captureSha256(original),
        representation: "normalized" as const, fidelity: "normalized-source" as const,
        transport: "native" as const, observedAt: event.createdAt,
        redactionPolicy: "headers-json-credentials-v1" as const, redacted: true,
      };
      const manifest = captureManifestSchema.parse({ ...fields, artifactId: captureObjectDigest(fields) });
      const directory = await capturePrivateDirectory(harness.config.dataDir, "core", captureObjectDigest(scope), session.id, manifest.artifactId);
      await captureWriteEncrypted(directory, "0.chunk", bytes, captureCipherContext(harness.config.dataDir, "core", session, `${manifest.artifactId}/0.chunk`));
      const receipt = captureAckFixture(manifest, 0);
      db.insert(privateCaptureArtifacts).values({ captureId: session.id, artifactId: manifest.artifactId, manifest, createdAt: 1, completedAt: 2 }).run();
      db.insert(privateCaptureChunks).values({ captureId: session.id, artifactId: manifest.artifactId, sequence: 0, sha256: manifest.chunks[0]!.sha256, bytes: bytes.length, receiptId: receipt.receiptId, committedAt: receipt.committedAt }).run();
      historical.push({ manifest, bytes, directory, ciphertext: await readFile(join(directory, "0.chunk")) });
    }
    db.update(privateCaptureSessions).set({ eventCursor: 100 }).where(eq(privateCaptureSessions.id, session.id)).run();
    const legacyReceipts = db.select().from(privateCaptureChunks).where(eq(privateCaptureChunks.captureId, session.id)).orderBy(asc(privateCaptureChunks.artifactId), asc(privateCaptureChunks.sequence)).all();
    db.$client.exec(`
      CREATE TRIGGER fail_native_cursor_after_completion
      BEFORE UPDATE OF event_cursor ON private_capture_sessions
      WHEN NEW.event_cursor = 1 AND EXISTS (
        SELECT 1 FROM private_capture_artifacts
        WHERE capture_id = NEW.id AND completed_at IS NOT NULL
          AND json_extract(manifest, '$.source') = 'native-events'
          AND json_extract(manifest, '$.version') = 2
      )
      BEGIN SELECT RAISE(FAIL, 'SYNTHETIC_CURSOR_UPDATE_FAILURE_AFTER_COMPLETION'); END;
    `);
    const interrupted = await syncPrivateCapture(deps, session.id, scope);
    expect(interrupted.gap).toBe("storage_unavailable");
    const firstV2 = listCaptureArtifacts(deps, session.id, { ...scope, source: "native-events", limit: 100 }).filter(value => value.manifest.version === 2);
    expect(firstV2.map(value => value.manifest.sourceId)).toEqual(["event:synthetic-native-event-1:1"]);
    expect(firstV2[0]!.completedAt).not.toBeNull();
    const firstReceipts = db.select().from(privateCaptureChunks).where(and(eq(privateCaptureChunks.captureId, session.id), eq(privateCaptureChunks.artifactId, firstV2[0]!.manifest.artifactId))).all();
    const interruptedCursor = db.select({ cursor: privateCaptureSessions.eventCursor }).from(privateCaptureSessions).where(eq(privateCaptureSessions.id, session.id)).get()!.cursor;
    db.$client.close();
    activeDb = undefined;
    db = createConnection(path);
    activeDb = db;
    deps = { ...harness.deps, db };
    db.$client.exec("DROP TRIGGER fail_native_cursor_after_completion");
    await syncPrivateCapture(deps, session.id, scope);
    const artifacts = listCaptureArtifacts(deps, session.id, { ...scope, source: "native-events", limit: 100 });
    const fresh = artifacts.filter(value => value.manifest.version === 2);
    expect(fresh.map(value => value.manifest.sourceId).sort()).toEqual(sourceEvents.map(event => `event:${event.id}:${event.sequence}`).sort());
    for (const event of sourceEvents) {
      const artifact = fresh.find(value => value.manifest.sourceId === `event:${event.id}:${event.sequence}`)!;
      const bytes = Buffer.from(JSON.stringify(event));
      expect(artifact.completedAt).not.toBeNull();
      expect(artifact.manifest).toMatchObject({ representation: "normalized", fidelity: "normalized-source", redacted: false, sourceBytes: bytes.length, storedBytes: bytes.length, sourceSha256: captureSha256(bytes), storedSha256: captureSha256(bytes) });
      expect(Buffer.from(await (await downloadCaptureArtifact(deps, session.id, artifact.manifest.artifactId, scope)).arrayBuffer())).toEqual(bytes);
    }
    expect(interruptedCursor).toBe(0);
    expect(db.select({ cursor: privateCaptureSessions.eventCursor }).from(privateCaptureSessions).where(eq(privateCaptureSessions.id, session.id)).get()).toEqual({ cursor: 100 });
    expect(fresh.find(value => value.manifest.artifactId === firstV2[0]!.manifest.artifactId)).toEqual(firstV2[0]);
    expect(db.select().from(privateCaptureChunks).where(and(eq(privateCaptureChunks.captureId, session.id), eq(privateCaptureChunks.artifactId, firstV2[0]!.manifest.artifactId))).all()).toEqual(firstReceipts);
    for (const old of historical) {
      expect(artifacts.find(value => value.manifest.artifactId === old.manifest.artifactId)).toMatchObject({ manifest: old.manifest, completedAt: 2 });
      expect(await readFile(join(old.directory, "0.chunk"))).toEqual(old.ciphertext);
      expect(Buffer.from(await (await downloadCaptureArtifact(deps, session.id, old.manifest.artifactId, scope)).arrayBuffer())).toEqual(old.bytes);
    }
    const receipts = db.select().from(privateCaptureChunks).where(eq(privateCaptureChunks.captureId, session.id)).orderBy(asc(privateCaptureChunks.artifactId), asc(privateCaptureChunks.sequence)).all();
    expect(receipts.filter(value => historical.some(old => old.manifest.artifactId === value.artifactId))).toEqual(legacyReceipts);
    expect(receipts.map(value => `${value.artifactId}:${value.sequence}`).sort()).toEqual(artifacts.flatMap(value => value.manifest.chunks.map(chunk => `${value.manifest.artifactId}:${chunk.sequence}`)).sort());
    await syncPrivateCapture(deps, session.id, scope);
    expect(listCaptureArtifacts(deps, session.id, { ...scope, source: "native-events", limit: 100 })).toEqual(artifacts);
    expect(db.select().from(privateCaptureChunks).where(eq(privateCaptureChunks.captureId, session.id)).orderBy(asc(privateCaptureChunks.artifactId), asc(privateCaptureChunks.sequence)).all()).toEqual(receipts);
  });
});
