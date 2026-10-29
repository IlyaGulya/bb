import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { classifyStoredProviderThreadClaim, createProject, events, getLastStoredProviderThreadId, getLatestThreadSequence, getThread, getThreadExecutionBinding, getThreadPluginMetadata, insertEvents, noopNotifier } from "@bb/db";
import { NATIVE_HISTORY_OWNER, type JsonValue } from "@bb/domain";
import { NATIVE_SESSION_CHUNK_BYTES } from "@bb/host-daemon-contract";
import { threadTimelineResponseSchema, timelineRowChildren, type TimelineRow } from "@bb/server-contract";
import { createNativeArchiveFixture, disposeNativeArchiveFixtures, nativeChecksum, nativeHeader, nativeUser } from "./helpers/native-session-import.js";
import { completeNativeAdmission, createNativeContinuationFixture, disposeNativeContinuationFixtures } from "./helpers/native-session-continuation.js";
import { createNativeSessionHandoff } from "../../../apps/server/src/services/threads/native-session-continuation.js";
import { nativeWriterNamespace } from "../../../apps/server/src/services/threads/native-session-imports.js";
import { buildThreadTimelineWithProfile } from "../../../apps/server/src/services/threads/timeline.js";

afterEach(disposeNativeArchiveFixtures);
afterEach(disposeNativeContinuationFixtures);

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

  it.each(["new-handoff", "native-admitted"])("preserves completed %s state and registered writer across pathname-alias retries", async (mode) => {
    const saved = await createNativeContinuationFixture();
    const completed = mode === "new-handoff"
      ? await createNativeSessionHandoff(saved.harness.deps, saved.imports, { ...saved.request, input: "Selected context for a separate completed handoff" })
      : await completeNativeAdmission(saved, saved.request, { admitted: true, providerThreadId: saved.nativeId });
    expect(completed).toMatchObject({ status: "ready", mode });
    const writerThreadId = mode === "new-handoff" ? completed.continuationThreadId : completed.threadId;
    if (writerThreadId === null) throw new Error("Completed continuation must retain its writer thread.");
    const writerNativeId = mode === "new-handoff" ? `synthetic-handoff-${saved.nativeId}` : saved.nativeId;
    if (mode === "new-handoff") {
      expect(writerThreadId).not.toBe(completed.threadId);
      insertEvents(saved.harness.db, saved.harness.hub, [{ threadId: writerThreadId, providerThreadId: writerNativeId, scope: { kind: "thread" }, sequence: getLatestThreadSequence(saved.harness.db, { threadId: writerThreadId }) + 1, type: "thread/identity", itemId: null, itemKind: null, parentToolCallId: null, createdAt: 1, data: JSON.stringify({ providerThreadId: writerNativeId }) }]);
    } else expect(completed.continuationThreadId).toBeNull();
    const state = (manifest: typeof completed | null) => manifest === null ? null : { id: manifest.id, threadId: manifest.threadId, status: manifest.status, mode: manifest.mode, continuationThreadId: manifest.continuationThreadId, attemptedSource: manifest.attemptedSource };
    const writer = async () => {
      const binding = getThreadExecutionBinding(saved.harness.db, writerThreadId);
      return {
        nativeSessionId: getLastStoredProviderThreadId(saved.harness.db, writerThreadId),
        claim: classifyStoredProviderThreadClaim(saved.harness.db, { threadId: writerThreadId, providerThreadId: writerNativeId }),
        executionContextId: binding?.executionContext?.id ?? null,
        modelConnectionId: binding?.modelConnection?.id ?? null,
        receipt: mode === "native-admitted" ? await readFile(join(saved.harness.config.dataDir, "native-session-imports", "writer-claims", `${nativeWriterNamespace(completed)}.json`), "utf8") : null,
      };
    };
    const registered = await writer();
    expect(registered).toMatchObject({ nativeSessionId: writerNativeId, claim: "owned", modelConnectionId: saved.connection.id });
    const original = state(completed);
    const selection = { hostId: completed.hostId, projectId: completed.projectId, source: completed.source };
    const canonicalBefore = await saved.imports.start(selection);
    expect(state(canonicalBefore)).toEqual(original);
    expect(await writer()).toEqual(registered);
    const aliasPath = `${dirname(completed.source.path)}/./${basename(completed.source.path)}`;
    const submitted = { ...completed.source, path: aliasPath };
    const aliased = await saved.imports.start({ ...selection, source: submitted }).then((manifest) => manifest, (error: unknown) => { expect(error).toMatchObject({ status: 409 }); return null; });
    const afterAlias = { manifest: state(await saved.imports.get(completed.id)), writer: await writer() };
    const canonicalAfter = await saved.imports.start(selection).then((manifest) => manifest, () => null);
    const afterCanonical = { manifest: state(await saved.imports.get(completed.id)), writer: await writer() };
    expect({ afterAlias, canonicalResult: state(canonicalAfter), afterCanonical }).toEqual({
      afterAlias: { manifest: original, writer: registered },
      canonicalResult: original,
      afterCanonical: { manifest: original, writer: registered },
    });
    if (aliased !== null) expect(state(aliased)).toEqual(original);
    expect(submitted.path).toBe(aliasPath);
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

describe("retained numeric spill search", () => {
  async function retainedSpill(output: Buffer) {
    const saved = await createNativeArchiveFixture({ records: (id, cwd): JsonValue[] => [
      nativeHeader("omp", id, cwd),
      nativeUser("omp", id, "Original saved request"),
      { type: "message", id: "call-spill", message: { role: "assistant", content: [{ type: "toolCall", id: "call-spill", name: "bash", arguments: { command: "never-execute-imported-command" } }] } },
      { type: "message", id: "result-spill", message: { role: "toolResult", toolCallId: "call-spill", toolName: "bash", content: [{ type: "text", text: "Bounded native preview\n[Raw output: artifact://17]" }] } },
      { type: "branch_checkpoint", id: "after-spill", state: { branch: "saved" } },
    ] });
    const stem = join(saved.leafRoot, "source");
    await mkdir(stem);
    await writeFile(join(stem, "17.bash-original.log"), output);
    const selection = { ...saved.selection, source: { ...saved.source, artifactRoots: [...saved.source.artifactRoots, stem] } };
    const ready = await saved.imports.settle((await saved.imports.start(selection)).id);
    expect(ready).toMatchObject({ status: "ready", mode: "archive", continuationThreadId: null });
    const artifact = ready.artifacts.find((entry) => entry.reference === "artifact://17");
    if (!artifact || artifact.status !== "ready") throw new Error("Synthetic numeric spill was not retained.");
    expect(artifact).toMatchObject({ recordOrdinal: 4, bytes: output.length, sha256: nativeChecksum(output) });
    return { ...saved, ready, artifact };
  }

  it.each([
    { boundary: "marker", split: 6 },
    { boundary: "UTF-8 code point", split: Buffer.byteLength("OWNED_SPILL_") + 1 },
  ])("finds a sidecar-only tail across a $boundary boundary without duplicate records or cursor drift", async ({ split }) => {
    const marker = "OWNED_SPILL_É🧭_TAIL";
    const output = Buffer.from(`${"x".repeat(NATIVE_SESSION_CHUNK_BYTES - split)}${marker}\n${"y".repeat(NATIVE_SESSION_CHUNK_BYTES)}\nBounded native preview`);
    const saved = await retainedSpill(output);
    const query = marker.toLocaleLowerCase();
    const page = await saved.imports.records({ importId: saved.ready.id, after: 0, limit: 1, query });
    expect(page.records.map((record) => record.nativeId)).toEqual(["result-spill"]);
    expect(page.nextAfter).toBe(4);
    expect(await saved.imports.records({ importId: saved.ready.id, after: page.nextAfter!, limit: 1, query })).toEqual({ records: [], nextAfter: null });
    const both = await saved.imports.records({ importId: saved.ready.id, after: 0, limit: 100, query: "bounded native preview" });
    expect(both.records.map((record) => record.nativeId)).toEqual(["result-spill"]);
    await expectOriginalArchive(saved, saved.ready.id);
    expect(Buffer.from(await (await saved.imports.download(saved.ready.id, saved.artifact.file)).arrayBuffer())).toEqual(output);
    expect(await saved.imports.get(saved.ready.id)).toEqual(saved.ready);
  });

  it("rejects a changed retained spill even when its early prefix already matches", async () => {
    const query = "SPILL_CHECKSUM_NEEDLE";
    const output = Buffer.from(`${query}\n${"z".repeat(2 * NATIVE_SESSION_CHUNK_BYTES)}.`);
    const saved = await retainedSpill(output);
    const changed = Buffer.from(output);
    changed[changed.length - 1] = 0x21;
    await writeFile(join(saved.imports.directory(saved.ready.id), saved.artifact.file), changed);
    await expect(saved.imports.records({ importId: saved.ready.id, after: 0, limit: 100, query })).rejects.toThrow("Retained native spill checksum mismatch.");
    await expectOriginalArchive(saved, saved.ready.id);
  });

  it("requires checksum-proven tool-result authority rather than mutable record and artifact metadata", async () => {
    const saved = await retainedSpill(Buffer.from("Ordinary retained tool output"));
    const reference = "artifact://18";
    const file = `artifact-${nativeChecksum(reference)}`;
    const output = Buffer.from("UNPROVEN_SPILL_MUST_NOT_MATCH");
    const directory = saved.imports.directory(saved.ready.id);
    await writeFile(join(directory, file), output);
    const path = join(directory, "records", "2.json");
    const user = (await saved.imports.records({ importId: saved.ready.id, after: 1, limit: 1, query: "" })).records[0]!;
    await writeFile(path, JSON.stringify({ ...user, artifactReferences: [reference] }));
    await writeFile(join(directory, "manifest.json"), JSON.stringify({ ...saved.ready, artifacts: [...saved.ready.artifacts, {
      reference, recordOrdinal: 2, file, bytes: output.length, sha256: nativeChecksum(output), status: "ready", reason: null,
    }] }));
    expect(await saved.imports.records({ importId: saved.ready.id, after: 0, limit: 100, query: output.toString("utf8") })).toEqual({ records: [], nextAfter: null });
  });

  it("does not search retained images or arbitrary checkpoint artifacts as spill text", async () => {
    const query = "NON_SPILL_ARTIFACT_MUST_NOT_MATCH";
    const image = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><text>${query}</text></svg>`);
    const reference = `blob:sha256:${nativeChecksum(image)}`;
    const saved = await createNativeArchiveFixture({ records: (id, cwd) => [
      nativeHeader("omp", id, cwd),
      { type: "message", id: "image-a", message: { role: "user", content: [{ type: "image", data: reference, mimeType: "image/svg+xml" }] } },
      { type: "branch_checkpoint", id: "checkpoint-a", artifactPath: "result.bin" },
    ] });
    await writeFile(join(saved.artifactRoot, nativeChecksum(image)), image);
    await writeFile(join(saved.artifactRoot, "result.bin"), query);
    const ready = await saved.imports.settle((await saved.imports.start(saved.selection)).id);
    expect(ready.status).toBe("ready");
    expect(await saved.imports.records({ importId: ready.id, after: 0, limit: 100, query })).toEqual({ records: [], nextAfter: null });
  });

  it("refuses sidecar search when its native record checksum no longer proves the footer", async () => {
    const query = "NATIVE_RECORD_PROOF_NEEDLE";
    const saved = await retainedSpill(Buffer.from(query));
    await writeFile(join(saved.imports.directory(saved.ready.id), "native.jsonl"), saved.original.replace("Bounded", "B0unded"));
    await expect(saved.imports.records({ importId: saved.ready.id, after: 0, limit: 100, query })).rejects.toThrow("Native archive record checksum mismatch.");
  });
});

describe("native archive Core timeline", () => {
  function allRows(rows: readonly TimelineRow[]): TimelineRow[] {
    return rows.flatMap((row) => [row, ...allRows(timelineRowChildren(row) ?? [])]);
  }

  it.each([true, false])("renders a ready two-record standalone tool-result archive with deferContent=%s", async (deferContent) => {
    const preview = "Bounded preview only\n[Raw output: artifact://17]";
    const needle = "RETAINED_TIMELINE_SPILL_TAIL";
    const spill = Buffer.from(`${"Saved native tool output\n".repeat(16_000)}${needle}`);
    const saved = await createNativeArchiveFixture({ records: (id, cwd) => [
      { type: "session", version: 3, id, cwd },
      { type: "message", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: preview }] } },
    ] });
    const stem = join(saved.leafRoot, "source");
    await mkdir(stem);
    await writeFile(join(stem, "17.bash-original.log"), spill);
    const selection = { ...saved.selection, source: { ...saved.source, artifactRoots: [...saved.source.artifactRoots, stem] } };
    const ready = await saved.imports.settle((await saved.imports.start(selection)).id);
    expect(ready).toMatchObject({ status: "ready", mode: "archive", records: 2, continuationThreadId: null, sha256: nativeChecksum(saved.original) });
    expect(ready.artifacts).toMatchObject([{ reference: "artifact://17", recordOrdinal: 2, status: "ready", bytes: spill.length, sha256: nativeChecksum(spill) }]);
    const thread = ready.threadId === null ? null : getThread(saved.db, ready.threadId);
    if (!thread) throw new Error("Ready synthetic import has no Core thread.");
    const stored = () => saved.db.select().from(events).where(eq(events.threadId, thread.id)).orderBy(events.sequence).all();
    const before = stored();
    const { response } = buildThreadTimelineWithProfile(saved.db, thread, {
      completedTurnDisplay: "collapse",
      deferContent,
      eventBudget: 1_000_000,
      includeClearedContextHistory: false,
      includeDiagnosticOperations: false,
      includeNestedRows: false,
      maxInlineOutputChars: 32_000,
      maxSeq: getLatestThreadSequence(saved.db, { threadId: thread.id }),
      page: { kind: "latest", segmentLimit: 8 },
      summaryOnly: false,
    });
    const timeline = threadTimelineResponseSchema.parse(response);
    expect(allRows(timeline.rows)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "work", status: "completed", output: preview }),
    ]));
    expect((await saved.imports.records({ importId: ready.id, after: 0, limit: 100, query: needle })).records.map((record) => ({ ordinal: record.ordinal, nativeId: record.nativeId }))).toEqual([{ ordinal: 2, nativeId: null }]);
    expect(stored()).toEqual(before);
    expect(await saved.imports.get(ready.id)).toEqual(ready);
    await expectOriginalArchive(saved, ready.id);
  });
});
