import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { events, noopNotifier, type DbConnection } from "@bb/db";
import type { NativeEngine, NativeSessionSource } from "@bb/host-daemon-contract";
import { nativeImportManifestSchema } from "@bb/server-contract";
import type { JsonValue } from "@bb/domain";
import { discoverNativeSessions, readNativeSession, snapshotNativeSession } from "../../../apps/host-daemon/src/command-handlers/native-sessions.js";
import { NativeSessionImports } from "../../../apps/server/src/services/threads/native-session-imports.js";
import { createNativeArchiveFixture, disposeNativeArchiveFixtures } from "./helpers/native-session-import.js";

const services: NativeSessionImports[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.dispose(); await disposeNativeArchiveFixtures(); });
const message = (id: string, text: string) => ({ type: "message", id, parentId: "user-a", message: { role: "assistant", content: [{ type: "text", text }] } });

async function titledFixture() {
  return createNativeArchiveFixture({ records: (id, cwd): JsonValue[] => [
    { type: "title", v: 1, title: "Original", source: "auto", updatedAt: "2026-01-01", pad: "    " },
    { type: "session", version: 3, id, cwd, timestamp: "2026-01-01", title: "Original", titleSource: "auto" },
    { type: "message", id: "user-a", message: { role: "user", content: [{ type: "text", text: "Unchanged request 🧭" }] } },
  ] });
}

function archiveRows(saved: { db: DbConnection }, threadId: string) {
  return saved.db.select().from(events).where(eq(events.threadId, threadId)).orderBy(events.sequence).all();
}

function reboundService(saved: { db: DbConnection; directory: string; engine: NativeEngine; sourceRoot: string; artifactRoot: string }) {
  const service = new NativeSessionImports({ db: saved.db, hub: noopNotifier, dataDir: join(saved.directory, "core"),
    read: (_hostId, input, signal) => readNativeSession(input, signal),
    snapshot: (_hostId, source, resolveOriginal, signal) => snapshotNativeSession({ source, resolveOriginal, roots: [{ engine: saved.engine, path: saved.sourceRoot, profile: "Known original profile", artifactRoots: [saved.artifactRoot] }] }, signal),
  });
  services.push(service);
  return service;
}

describe("self-service native refresh", () => {
  it("accepts only OMP title metadata rewrites, retains original bytes, and projects each growing tail once", async () => {
    const saved = await titledFixture();
    const initial = await saved.imports.settle((await saved.imports.start(saved.selection)).id);
    const before = archiveRows(saved, initial.threadId!);
    const changed = saved.original.replaceAll('"title":"Original"', '"title":"A much longer automatically generated title"').replace('"updatedAt":"2026-01-01"', '"updatedAt":"2026-02-02"').replace('"pad":"    "', '"pad":" "');
    const tail = JSON.stringify(message("reply-one", "First independently requested reply 🧭"));
    await writeFile(saved.path, `${changed}\n${tail}\n`);
    const admitted = await saved.imports.refresh(initial.id);
    expect(admitted).toMatchObject({ id: initial.id, threadId: initial.threadId, mode: "archive" });
    const refreshed = await saved.imports.settle(initial.id);
    expect(refreshed).toMatchObject({ status: "ready", id: initial.id, threadId: initial.threadId, records: 4, sourceBoundaryBytes: Buffer.byteLength(`${changed}\n${tail}\n`) });
    expect(refreshed.headerVersions).toHaveLength(2);
    expect(await readFile(join(saved.imports.directory(initial.id), "native.jsonl"))).toEqual(Buffer.from(`${saved.original}\n${tail}\n`));
    expect(archiveRows(saved, initial.threadId!).slice(0, before.length)).toEqual(before);
    for (const version of refreshed.headerVersions) {
      const raw = await saved.imports.download(initial.id, version.file);
      expect(Buffer.from(await raw.arrayBuffer()).toString()).toContain("A much longer automatically generated title");
    }
    const once = archiveRows(saved, initial.threadId!);
    await saved.imports.refresh(initial.id);
    const repeated = await saved.imports.settle(initial.id);
    expect(repeated).toMatchObject({ status: "ready", records: 4 });
    expect(repeated.headerVersions).toHaveLength(2);
    expect(archiveRows(saved, initial.threadId!)).toEqual(once);
    const second = JSON.stringify(message("reply-two", "Later reply requires another explicit refresh"));
    await appendFile(saved.path, `${second}\n`);
    await saved.imports.refresh(initial.id);
    expect(await saved.imports.settle(initial.id)).toMatchObject({ status: "ready", records: 5, threadId: initial.threadId });
    expect((await saved.imports.list({ hostId: saved.host.id, projectId: saved.project.id })).map((entry) => entry.id)).toEqual([initial.id]);
  });

  it("rejects actual old conversation mutation and preserves accepted archive, header provenance, events and artifacts", async () => {
    const saved = await titledFixture();
    const ready = await saved.imports.settle((await saved.imports.start(saved.selection)).id);
    const rows = archiveRows(saved, ready.threadId!);
    await writeFile(saved.path, saved.original.replace("Original", "New title").replace("Unchanged request", "Rewritten request"));
    await saved.imports.refresh(ready.id);
    const failed = await saved.imports.settle(ready.id);
    expect(failed).toMatchObject({ status: "failed", bytes: ready.bytes, records: ready.records, source: ready.source, headerVersions: [] });
    expect(await readFile(join(saved.imports.directory(ready.id), "native.jsonl"))).toEqual(Buffer.from(saved.original));
    expect(archiveRows(saved, ready.threadId!)).toEqual(rows);
    await writeFile(saved.path, `${saved.original}\n${JSON.stringify(message("recovered", "Retry after failed refresh"))}\n`);
    await saved.imports.refresh(ready.id);
    expect(await saved.imports.settle(ready.id)).toMatchObject({ status: "ready", records: 4, threadId: ready.threadId });
  });

  it("excludes a partial UTF8 JSON tail until a later click captures its completed record", async () => {
    const saved = await titledFixture();
    const ready = await saved.imports.settle((await saved.imports.start(saved.selection)).id);
    const tail = Buffer.from(`${JSON.stringify(message("split", "Split record 🧭 across native writes"))}\n`);
    const split = tail.indexOf(Buffer.from("🧭")) + 2;
    await appendFile(saved.path, Buffer.concat([Buffer.from("\n"), tail.subarray(0, split)]));
    await saved.imports.refresh(ready.id);
    const partial = await saved.imports.settle(ready.id);
    expect(partial).toMatchObject({ status: "ready", records: 3 });
    await appendFile(saved.path, tail.subarray(split));
    await saved.imports.refresh(ready.id);
    const completed = await saved.imports.settle(ready.id);
    expect(completed).toMatchObject({ status: "ready", records: 4, threadId: ready.threadId });
    expect((await saved.imports.records({ importId: ready.id, after: 0, limit: 100, query: "Split record 🧭" })).records.map((entry) => entry.nativeId)).toEqual(["split"]);
  });

  it("rebinds a legacy frozen manifest to its unique original without changing import/thread IDs or allowing a duplicate start", async () => {
    const saved = await titledFixture();
    const frozenRoot = join(saved.directory, "native-imports", "checkpoint-final");
    await mkdir(frozenRoot, { recursive: true });
    const frozenPath = join(frozenRoot, "source.jsonl");
    await writeFile(frozenPath, saved.original);
    const page = await discoverNativeSessions({ roots: [{ engine: "omp", path: frozenRoot, profile: "read-only-checkpoint", artifactRoots: [] }], cursor: 0, limit: 10 });
    const frozen: NativeSessionSource | undefined = page.sessions[0];
    if (!frozen) throw new Error(page.warnings.join("; "));
    const service = reboundService(saved);
    const original = await service.settle((await service.start({ ...saved.selection, source: frozen })).id);
    const legacy = { ...original };
    const { previousSources: _previous, headerVersions: _headers, sourceBoundaryBytes: _boundary, ...legacyFields } = legacy;
    await writeFile(join(service.directory(original.id), "manifest.json"), JSON.stringify(legacyFields));
    expect(nativeImportManifestSchema.parse(legacyFields)).toMatchObject({ previousSources: [], headerVersions: [], sourceBoundaryBytes: null });
    await appendFile(saved.path, `\n${JSON.stringify(message("live-reply", "Reply after frozen checkpoint"))}\n`);
    await service.refresh(original.id);
    const rebound = await service.settle(original.id);
    expect(rebound).toMatchObject({ status: "ready", id: original.id, threadId: original.threadId, records: 4, source: { path: saved.path } });
    expect(rebound.previousSources.map((entry) => entry.path)).toEqual([frozenPath]);
    const startedAgain = await service.start({ ...saved.selection, source: await saved.discover() });
    expect(startedAgain).toMatchObject({ id: original.id, threadId: original.threadId });
    await service.settle(original.id);
    expect(await service.list({ projectId: saved.project.id })).toHaveLength(1);
  });

  it("keeps the click-time snapshot fixed while the original appends during transfer, then captures the later tail on the next refresh", async () => {
    const saved = await titledFixture();
    let grow = false;
    const later = JSON.stringify(message("after-click", "Arrived after the refresh click"));
    const service = new NativeSessionImports({ db: saved.db, hub: noopNotifier, dataDir: join(saved.directory, "core"),
      snapshot: (_hostId, source, resolveOriginal, signal) => snapshotNativeSession({ source, resolveOriginal }, signal),
      read: async (_hostId, input, signal) => {
        if (grow && input.artifact === null) { grow = false; await appendFile(saved.path, `${later}\n`); }
        return readNativeSession(input, signal);
      },
    });
    services.push(service);
    const ready = await service.settle((await service.start(saved.selection)).id);
    const first = JSON.stringify(message("before-click", "Ready before the refresh click"));
    await appendFile(saved.path, `\n${first}\n`);
    grow = true;
    await service.refresh(ready.id);
    expect(await service.settle(ready.id)).toMatchObject({ status: "ready", records: 4 });
    expect((await service.records({ importId: ready.id, after: 0, limit: 100, query: "Arrived after" })).records).toEqual([]);
    await service.refresh(ready.id);
    expect(await service.settle(ready.id)).toMatchObject({ status: "ready", records: 5, threadId: ready.threadId });
  });

  it("recovers a missing artifact using its original record authority after variable-length OMP header mutation", async () => {
    const saved = await createNativeArchiveFixture({ records: (id, cwd): JsonValue[] => [
      { type: "title", v: 1, title: "Original", source: "auto", updatedAt: "2026-01-01", pad: "" },
      { type: "session", id, cwd, title: "Original", titleSource: "auto" },
      { type: "branch_checkpoint", id: "artifact-record", artifactPath: "recovered.bin" },
    ] });
    const ready = await saved.imports.settle((await saved.imports.start(saved.selection)).id);
    expect(ready.artifacts).toMatchObject([{ reference: "recovered.bin", status: "unavailable" }]);
    await writeFile(join(saved.artifactRoot, "recovered.bin"), "Retained recovered artifact");
    await writeFile(saved.path, saved.original.replaceAll('"title":"Original"', '"title":"New title with a different byte length"'));
    await saved.imports.refresh(ready.id);
    const recovered = await saved.imports.settle(ready.id);
    expect(recovered).toMatchObject({ status: "ready", threadId: ready.threadId, records: ready.records });
    expect(recovered.artifacts).toMatchObject([{ reference: "recovered.bin", status: "ready" }]);
    expect(Buffer.from(await (await saved.imports.download(ready.id, recovered.artifacts[0]!.file)).arrayBuffer()).toString()).toBe("Retained recovered artifact");
    expect(await readFile(join(saved.imports.directory(ready.id), "native.jsonl"))).toEqual(Buffer.from(saved.original));
  });

  it("reports an unavailable original as an error instead of no new content and retains a readable accepted archive", async () => {
    const saved = await titledFixture();
    const ready = await saved.imports.settle((await saved.imports.start(saved.selection)).id);
    await rm(saved.path);
    await expect(saved.imports.refresh(ready.id)).rejects.toThrow();
    expect(await saved.imports.get(ready.id)).toMatchObject({ status: "ready", bytes: ready.bytes, records: ready.records });
    expect(Buffer.from(await (await saved.imports.download(ready.id, "native")).arrayBuffer())).toEqual(Buffer.from(saved.original));
  });
});
