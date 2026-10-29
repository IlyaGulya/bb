import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyStoredProviderThreadClaim, createProject, getLatestThreadSequence, getThreadPluginMetadata, insertEvents, noopNotifier } from "@bb/db";
import { NATIVE_HISTORY_OWNER, type JsonValue } from "@bb/domain";
import { createNativeArchiveFixture, disposeNativeArchiveFixtures, nativeChecksum, nativeHeader, nativeUser } from "./helpers/native-session-import.js";

afterEach(disposeNativeArchiveFixtures);

async function expectOriginalArchive(saved: Awaited<ReturnType<typeof createNativeArchiveFixture>>, id: string) {
  const response = await saved.imports.download(id, "native");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(saved.original));
}

describe("reviewed native archive boundaries", () => {
  it.each(["omp", "claude", "codex"] as const)("does not grant file-read authority to ordinary %s message blob strings", async (engine) => {
    const saved = await createNativeArchiveFixture({ engine, records: (id, cwd) => [nativeHeader(engine, id, cwd), nativeUser(engine, id, "blob://ordinary-result.bin")] });
    await writeFile(join(saved.artifactRoot, "ordinary-result.bin"), "SYNTHETIC FILE THAT MESSAGE TEXT MUST NOT AUTHORIZE");
    const ready = await saved.imports.settle((await saved.imports.start(saved.selection)).id);
    expect(ready.status).toBe("ready");
    await expectOriginalArchive(saved, ready.id);
    expect(ready.artifacts).toEqual([]);
  });

  it.each(["omp", "claude"] as const)("does not interpret arbitrary %s tool arguments as artifact authority", async (engine) => {
    const saved = await createNativeArchiveFixture({ engine, records: (id, cwd): JsonValue[] => [nativeHeader(engine, id, cwd), engine === "omp"
      ? { type: "message", id: "tool-a", message: { role: "assistant", content: [{ type: "toolCall", id: "call-a", name: "example", arguments: { artifactPath: "arbitrary.bin" } }] } }
      : { type: "assistant", uuid: "tool-a", sessionId: id, message: { role: "assistant", content: [{ type: "tool_use", id: "call-a", name: "example", input: { artifactPath: "arbitrary.bin" } }] } }] });
    await writeFile(join(saved.artifactRoot, "arbitrary.bin"), "SYNTHETIC UNAUTHORIZED FILE");
    const ready = await saved.imports.settle((await saved.imports.start(saved.selection)).id);
    expect(ready.status).toBe("ready");
    await expectOriginalArchive(saved, ready.id);
    expect(ready.artifacts).toEqual([]);
  });

  it.each([".mcp.json", ".netrc", ".npmrc"])("never transfers a separately referenced %s credential/configuration file", async (reference) => {
    const saved = await createNativeArchiveFixture({ records: (id, cwd) => [nativeHeader("omp", id, cwd), { type: "checkpoint", id: "checkpoint-a", artifactPath: reference }] });
    await writeFile(join(saved.artifactRoot, reference), "SYNTHETIC SECRET; NOT A REAL CREDENTIAL");
    const ready = await saved.imports.settle((await saved.imports.start(saved.selection)).id);
    expect(ready.status).toBe("ready");
    await expectOriginalArchive(saved, ready.id);
    expect(ready.artifacts.filter((entry) => entry.status === "ready")).toEqual([]);
    expect(ready.artifacts.filter((entry) => entry.bytes !== 0)).toEqual([]);
    await expect(saved.imports.bytes({ importId: ready.id, file: `artifact-${nativeChecksum(reference)}`, offset: 0, length: 256 })).rejects.toMatchObject({ status: 404 });
  });

  it("rejects a forged zero-byte descriptor for a nonempty native source", async () => {
    const saved = await createNativeArchiveFixture();
    const result = await saved.imports.settle((await saved.imports.start({ ...saved.selection, source: { ...saved.source, sizeBytes: 0 } })).id);
    expect(result).toMatchObject({ status: "failed", records: 0, bytes: 0, sha256: null });
  });

  it("deduplicates the same physical session discovered through overlapping roots", async () => {
    const saved = await createNativeArchiveFixture();
    const first = await saved.imports.settle((await saved.imports.start(saved.selection)).id);
    const secondSource = await saved.discover(saved.leafRoot);
    expect(secondSource.path).toBe(saved.source.path);
    expect(secondSource.revision).toBe(saved.source.revision);
    const repeated = await saved.imports.settle((await saved.imports.start({ ...saved.selection, source: secondSource })).id);
    expect(repeated.id).toBe(first.id);
    expect(repeated.threadId).toBe(first.threadId);
    expect(repeated.sha256).toBe(first.sha256);
  });

  it("keeps Core writer claims coordinated across overlapping roots and distinct destination projects", async () => {
    const saved = await createNativeArchiveFixture();
    const first = await saved.imports.settle((await saved.imports.start(saved.selection)).id);
    expect(first.status).toBe("ready");
    insertEvents(saved.db, noopNotifier, [{ threadId: first.threadId!, providerThreadId: saved.sessionId, scope: { kind: "thread" }, sequence: getLatestThreadSequence(saved.db, { threadId: first.threadId! }) + 1, type: "thread/identity", itemId: null, itemKind: null, parentToolCallId: null, createdAt: 1, data: JSON.stringify({ providerThreadId: saved.sessionId }) }]);
    const other = createProject(saved.db, noopNotifier, { name: "Other explicit destination", source: { type: "local_path", hostId: saved.host.id, path: saved.cwd } }).project;
    const candidate = await saved.imports.settle((await saved.imports.start({ ...saved.selection, projectId: other.id, source: await saved.discover(saved.leafRoot) })).id);
    expect(candidate.status).toBe("ready");
    expect(classifyStoredProviderThreadClaim(saved.db, { threadId: candidate.threadId!, providerThreadId: saved.sessionId })).toBe("foreign");
  });

  it("deduplicates pathname aliases and preserves their Core writer claim", async () => {
    const saved = await createNativeArchiveFixture();
    const first = await saved.imports.settle((await saved.imports.start(saved.selection)).id);
    expect(first.status).toBe("ready");
    const canonicalRepeat = await saved.imports.settle((await saved.imports.start(saved.selection)).id);
    expect(canonicalRepeat).toMatchObject({ id: first.id, threadId: first.threadId, sha256: first.sha256 });
    insertEvents(saved.db, noopNotifier, [{ threadId: first.threadId!, providerThreadId: saved.sessionId, scope: { kind: "thread" }, sequence: getLatestThreadSequence(saved.db, { threadId: first.threadId! }) + 1, type: "thread/identity", itemId: null, itemKind: null, parentToolCallId: null, createdAt: 1, data: JSON.stringify({ providerThreadId: saved.sessionId }) }]);
    const other = createProject(saved.db, noopNotifier, { name: "Path alias destination", source: { type: "local_path", hostId: saved.host.id, path: saved.cwd } }).project;
    const canonicalCandidate = await saved.imports.settle((await saved.imports.start({ ...saved.selection, projectId: other.id })).id);
    expect(canonicalCandidate.status).toBe("ready");
    expect(classifyStoredProviderThreadClaim(saved.db, { threadId: canonicalCandidate.threadId!, providerThreadId: saved.sessionId })).toBe("foreign");
    const source = { ...saved.source, path: `${saved.leafRoot}/./${basename(saved.path)}` };
    const candidate = await saved.imports.settle((await saved.imports.start({ ...saved.selection, projectId: other.id, source })).id);
    const claim = classifyStoredProviderThreadClaim(saved.db, { threadId: candidate.threadId!, providerThreadId: saved.sessionId });
    const repeated = await saved.imports.settle((await saved.imports.start({ ...saved.selection, source })).id);
    expect({
      repeated: { status: repeated.status, id: repeated.id, threadId: repeated.threadId, sha256: repeated.sha256 },
      candidate: { status: candidate.status, id: candidate.id, threadId: candidate.threadId, claim },
    }).toEqual({
      repeated: { status: "ready", id: first.id, threadId: first.threadId, sha256: first.sha256 },
      candidate: { status: "ready", id: canonicalCandidate.id, threadId: canonicalCandidate.threadId, claim: "foreign" },
    });
  });

  it("retains committed manifest and Core provenance after rejecting a changed source prefix", async () => {
    const saved = await createNativeArchiveFixture();
    const ready = await saved.imports.settle((await saved.imports.start(saved.selection)).id);
    expect(ready.status).toBe("ready");
    const originalMetadata = getThreadPluginMetadata(saved.db, ready.threadId!, NATIVE_HISTORY_OWNER).metadata.source;
    const rejected: JsonValue[] = [{ type: "session", id: saved.sessionId, title: "Rejected candidate with a deliberately longer title", cwd: `${saved.cwd}/different-longer-workspace` }, nativeUser("omp", saved.sessionId, "A deliberately different and longer source request")];
    await writeFile(saved.path, rejected.map((record) => JSON.stringify(record)).join("\n"));
    await saved.imports.start({ ...saved.selection, source: await saved.discover() });
    const failed = await saved.imports.settle(ready.id);
    expect(failed.status).toBe("failed");
    await expectOriginalArchive(saved, ready.id);
    expect(failed.source).toEqual(ready.source);
    expect(getThreadPluginMetadata(saved.db, ready.threadId!, NATIVE_HISTORY_OWNER).metadata.source).toEqual(originalMetadata);
    expect(failed.boundarySha256).toBe(ready.boundarySha256);
  });
});
