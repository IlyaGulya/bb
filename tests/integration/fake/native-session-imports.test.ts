import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createProject, events, getLatestThreadSequence, getThread, insertEvents, noopNotifier, upsertHost } from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import { threadEventItemSchema, type JsonValue } from "@bb/domain";
import type { NativeEngine, NativeRead } from "@bb/host-daemon-contract";
import { threadTimelineResponseSchema, timelineRowChildren, type TimelineRow } from "@bb/server-contract";
import { discoverNativeSessions, readNativeSession } from "../../../apps/host-daemon/src/command-handlers/native-sessions.js";
import { NativeSessionImports } from "../../../apps/server/src/services/threads/native-session-imports.js";
import { buildThreadTimelineWithProfile } from "../../../apps/server/src/services/threads/timeline.js";

const checksum = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const fixtures: { dispose(): Promise<void> }[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.dispose(); });

function savedRecords(engine: NativeEngine, output: string): JsonValue[] {
  const timestamp = "2026-01-02T03:04:05.000Z";
  const sessionId = `${engine}-saved-fixture`;
  if (engine === "omp") return [
    { type: "session", id: sessionId, cwd: "/fixture/workspace", timestamp },
    { type: "message", id: "user-a", parentId: sessionId, timestamp, message: { role: "user", content: [{ type: "text", text: "Inspect the saved project" }] } },
    { type: "message", id: "assistant-a", parentId: "user-a", timestamp, message: { role: "assistant", content: [{ type: "thinking", thinking: "Saved reasoning" }, { type: "toolCall", id: "call-a", name: "bash", arguments: { command: "never-execute-imported-command" } }] } },
    { type: "message", id: "result-a", parentId: "assistant-a", timestamp, message: { role: "toolResult", toolCallId: "call-a", toolName: "bash", content: [{ type: "text", text: output }] } },
    { type: "message", id: "assistant-b", parentId: "result-a", timestamp, message: { role: "assistant", content: [{ type: "text", text: "Saved answer" }] } },
    { type: "branch_checkpoint", id: "checkpoint-a", parentId: "assistant-b", timestamp, state: { opaque: "native-state", branch: "saved-branch" }, artifactPath: "result.bin" },
  ];
  if (engine === "claude") return [
    { type: "user", uuid: "user-a", parentUuid: null, sessionId, cwd: "/fixture/workspace", timestamp, message: { role: "user", content: "Inspect the saved project" } },
    { type: "assistant", uuid: "assistant-a", parentUuid: "user-a", sessionId, timestamp, message: { role: "assistant", content: [{ type: "thinking", thinking: "Saved reasoning" }, { type: "tool_use", id: "call-a", name: "bash", input: { command: "never-execute-imported-command" } }] } },
    { type: "user", uuid: "result-a", parentUuid: "assistant-a", sessionId, timestamp, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-a", content: output }] } },
    { type: "assistant", uuid: "assistant-b", parentUuid: "result-a", sessionId, timestamp, message: { role: "assistant", content: [{ type: "text", text: "Saved answer" }] } },
    { type: "system", subtype: "compact_boundary", uuid: "checkpoint-a", parentUuid: "assistant-b", sessionId, timestamp, state: { opaque: "native-state", branch: "saved-branch" }, artifactPath: "result.bin" },
  ];
  return [
    { type: "session_meta", timestamp, payload: { id: sessionId, cwd: "/fixture/workspace" } },
    { type: "response_item", id: "user-a", timestamp, payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect the saved project" }] } },
    { type: "response_item", id: "assistant-a", parentId: "user-a", timestamp, payload: { type: "function_call", call_id: "call-a", name: "bash", arguments: JSON.stringify({ command: "never-execute-imported-command" }) } },
    { type: "response_item", id: "result-a", parentId: "assistant-a", timestamp, payload: { type: "function_call_output", call_id: "call-a", output } },
    { type: "response_item", id: "assistant-b", parentId: "result-a", timestamp, payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Saved answer" }] } },
    { type: "compacted", id: "checkpoint-a", parentId: "assistant-b", timestamp, payload: { opaque: "native-state", branch: "saved-branch" }, artifactPath: "result.bin" },
  ];
}

async function fixture(engine: NativeEngine, output = "Saved tool result", beforeRead?: (input: NativeRead, signal: AbortSignal) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "bb-native-import-"));
  const sourceRoot = join(directory, "sessions");
  const artifactRoot = join(directory, "artifacts");
  await mkdir(sourceRoot); await mkdir(artifactRoot);
  const path = join(sourceRoot, "saved.jsonl");
  const records = savedRecords(engine, output);
  const original = records.map((record) => JSON.stringify(record)).join("\n");
  const artifact = Buffer.from([0, 255, 17, 0, 200, 64]);
  await writeFile(path, original); await writeFile(join(artifactRoot, "result.bin"), artifact);
  const roots = [{ engine, path: sourceRoot, profile: "Explicit source profile", artifactRoots: [artifactRoot] }];
  async function describe() {
    const discovered = await discoverNativeSessions({ roots, cursor: 0, limit: 100 });
    const source = discovered.sessions.find((entry) => entry.path === path);
    if (!source) throw new Error(`Fixture discovery failed: ${discovered.warnings.join("; ")}`);
    return source;
  }
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, { name: "Test Host" });
  const { project } = createProject(db, noopNotifier, { name: "Native archive fixture", source: { type: "local_path", hostId: host.id, path: "/fixture/workspace" } });
  const services: NativeSessionImports[] = [];
  function service() {
    const imports = new NativeSessionImports({ db, hub: noopNotifier, dataDir: join(directory, "core"), read: async (_hostId, input, signal) => {
      await beforeRead?.(input, signal);
      return readNativeSession(input, signal);
    } });
    services.push(imports);
    return imports;
  }
  fixtures.push({ dispose: async () => { try { for (const imports of services) await imports.dispose(); } finally { db.$client.close(); await rm(directory, { recursive: true, force: true }); } } });
  return { db, path, records, original, artifact, artifactRoot, describe, service, selection: { hostId: host.id, projectId: project.id, source: await describe() } };
}

describe("durable native session imports", () => {
  it.each(["omp", "claude", "codex"] as const)("archives complete %s history, projects Core tools, and reimports without duplicate events", async (engine) => {
    const saved = await fixture(engine, `${"Unicode 🧭 tool data\n".repeat(22_000)}TAIL-ONLY-SEARCH-TOKEN`);
    const imports = saved.service();
    const initial = await imports.start(saved.selection);
    const ready = await imports.settle(initial.id);
    expect(ready).toMatchObject({ status: "ready", mode: "archive", records: saved.records.length, bytes: Buffer.byteLength(saved.original), sha256: checksum(saved.original), continuationThreadId: null });
    const download = await imports.download(ready.id, "native");
    expect(Buffer.from(await download.arrayBuffer())).toEqual(Buffer.from(saved.original));
    const rows = saved.db.select().from(events).where(eq(events.threadId, ready.threadId!)).orderBy(events.sequence).all();
    const items = rows.filter((row) => row.type === "item/started" || row.type === "item/completed").map((row) => threadEventItemSchema.parse(JSON.parse(row.data).item));
    expect(items.filter((item) => item.type === "userMessage")).toMatchObject([{ content: [{ type: "text", text: "Inspect the saved project" }] }]);
    expect(items.filter((item) => item.type === "agentMessage")).toMatchObject([{ text: "Saved answer" }]);
    expect(items.filter((item) => item.type === "toolCall")).toMatchObject([{ tool: "bash", status: "pending", arguments: { command: "never-execute-imported-command" } }, { tool: "bash", status: "completed", arguments: { command: "never-execute-imported-command" } }]);
    const result = await imports.records({ importId: ready.id, after: 0, limit: 50, query: "TAIL-ONLY-SEARCH-TOKEN" });
    expect(result.records.map((record) => record.nativeId)).toEqual(["result-a"]);
    expect(ready.artifacts).toMatchObject([{ reference: "result.bin", status: "ready", sha256: checksum(saved.artifact) }]);
    const blob = await imports.download(ready.id, ready.artifacts[0]!.file);
    expect(Buffer.from(await blob.arrayBuffer())).toEqual(saved.artifact);
    const page = await imports.records({ importId: ready.id, after: 0, limit: 1, query: "" });
    const second = await imports.records({ importId: ready.id, after: page.nextAfter!, limit: 100, query: "" });
    expect([...page.records, ...second.records].map((record) => record.ordinal)).toEqual(saved.records.map((_, index) => index + 1));
    expect(second.records.find((record) => record.nativeId === "checkpoint-a")).toMatchObject({ parentId: "assistant-b" });
    const repeated = await imports.start(saved.selection);
    expect(repeated.threadId).toBe(ready.threadId);
    expect(saved.db.select().from(events).where(eq(events.threadId, ready.threadId!)).orderBy(events.sequence).all()).toEqual(rows);
  });

  it("recovers Core projection committed before the filesystem checkpoint without inserting duplicates", async () => {
    const saved = await fixture("omp");
    const imports = saved.service();
    const ready = await imports.settle((await imports.start(saved.selection)).id);
    const rows = saved.db.select().from(events).where(eq(events.threadId, ready.threadId!)).orderBy(events.sequence).all();
    await writeFile(join(imports.directory(ready.id), "manifest.json"), JSON.stringify({ ...ready, status: "importing", bytes: 0, records: 0, nextSequence: 1, sha256: null, boundaryBytes: 0, boundarySha256: null, artifacts: [] }));
    const recovered = saved.service();
    expect((await recovered.get(ready.id)).status).toBe("paused");
    await recovered.resume(ready.id);
    const finished = await recovered.settle(ready.id);
    expect(finished).toMatchObject({ status: "ready", threadId: ready.threadId, sha256: ready.sha256, records: ready.records });
    expect(saved.db.select().from(events).where(eq(events.threadId, ready.threadId!)).orderBy(events.sequence).all()).toEqual(rows);
  });

  it("rejects changed committed source prefixes and leaves the original archive readable", async () => {
    const saved = await fixture("omp");
    const imports = saved.service();
    const ready = await imports.settle((await imports.start(saved.selection)).id);
    await writeFile(saved.path, saved.original.replace("Inspect the saved project", "Rewrite the saved project"));
    await imports.start({ ...saved.selection, source: await saved.describe() });
    const failed = await imports.settle(ready.id);
    expect(failed.status).toBe("failed");
    expect(failed.bytes).toBe(ready.bytes);
    const archived = await imports.download(ready.id, "native");
    expect(Buffer.from(await archived.arrayBuffer())).toEqual(Buffer.from(saved.original));
  });

  it("cancels after committed records and resumes a partial large record exactly once", async () => {
    let hold = true;
    let reached = () => {};
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    const saved = await fixture("omp", "x".repeat(600_000), async (input, signal) => {
      if (hold && input.artifact === null && input.offset >= 256 * 1024) {
        reached();
        await new Promise<void>((_resolve, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
      }
    });
    const imports = saved.service();
    const started = await imports.start(saved.selection);
    await waiting;
    const cancelled = await imports.cancel(started.id);
    expect(cancelled).toMatchObject({ status: "cancelled", records: 3 });
    const prefix = Buffer.from(saved.original).subarray(0, cancelled.bytes);
    expect(cancelled.boundarySha256).toBe(checksum(prefix));
    const partial = await imports.download(started.id, "native");
    expect(Buffer.from(await partial.arrayBuffer())).toEqual(prefix);
    hold = false;
    const resumed = saved.service();
    await resumed.resume(started.id);
    const ready = await resumed.settle(started.id);
    expect(ready).toMatchObject({ status: "ready", records: saved.records.length, sha256: checksum(saved.original) });
    const final = await resumed.download(started.id, "native");
    expect(Buffer.from(await final.arrayBuffer())).toEqual(Buffer.from(saved.original));
  });

  it("retries a missing referenced artifact after source roots are explicitly reselected", async () => {
    const saved = await fixture("omp");
    await rm(join(saved.artifactRoot, "result.bin"));
    const imports = saved.service();
    const ready = await imports.settle((await imports.start(saved.selection)).id);
    expect(ready.artifacts).toMatchObject([{ reference: "result.bin", status: "unavailable", recordOrdinal: saved.records.length }]);
    await writeFile(join(saved.artifactRoot, "result.bin"), saved.artifact);
    await imports.start(saved.selection);
    const retried = await imports.settle(ready.id);
    expect(retried.artifacts).toMatchObject([{ reference: "result.bin", status: "ready", sha256: checksum(saved.artifact) }]);
    expect(await readFile(join(imports.directory(ready.id), "native.jsonl"))).toEqual(Buffer.from(saved.original));
  });

  it("opens a persisted native archive idempotently without rewriting legacy rows or accepting unrelated invalid events", async () => {
    const saved = await fixture("omp");
    const imports = saved.service();
    const ready = await imports.settle((await imports.start(saved.selection)).id);
    const thread = ready.threadId === null ? null : getThread(saved.db, ready.threadId);
    if (!thread) throw new Error("Ready archive must retain its original Core thread.");
    const stored = () => saved.db.select().from(events).where(eq(events.threadId, thread.id)).orderBy(events.sequence).all();
    const payloadSchema = z.object({ providerThreadId: z.string(), item: threadEventItemSchema, nativeImportRecord: z.object({ importId: z.string(), ordinal: z.number(), sha256: z.string(), eventCount: z.number() }) });
    for (const row of stored()) {
      if (row.type !== "item/started" && row.type !== "item/completed") continue;
      const payload = payloadSchema.parse(JSON.parse(row.data));
      saved.db.update(events).set({ scopeKind: "thread", turnId: null, data: JSON.stringify({ ...payload, nativeImportRecord: { ...payload.nativeImportRecord, eventCount: payload.nativeImportRecord.eventCount - 2 } }) }).where(eq(events.id, row.id)).run();
    }
    saved.db.delete(events).where(and(eq(events.threadId, thread.id), inArray(events.type, ["turn/started", "turn/completed"]))).run();
    const before = stored();
    const read = () => threadTimelineResponseSchema.parse(buildThreadTimelineWithProfile(saved.db, thread, {
      completedTurnDisplay: "collapse", deferContent: true, eventBudget: 1_000_000,
      includeClearedContextHistory: false, includeDiagnosticOperations: false, includeNestedRows: false,
      maxInlineOutputChars: 32_000, maxSeq: getLatestThreadSequence(saved.db, { threadId: thread.id }),
      page: { kind: "latest", segmentLimit: 8 },
    }).response);
    function flatten(rows: readonly TimelineRow[]): TimelineRow[] { return rows.flatMap((row) => [row, ...flatten(timelineRowChildren(row) ?? [])]); }
    const first = read();
    expect(flatten(first.rows)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "conversation", role: "user", text: "Inspect the saved project" }),
      expect.objectContaining({ kind: "work", status: "completed", output: "Saved tool result" }),
    ]));
    expect(read()).toEqual(first);
    expect(stored()).toEqual(before);
    expect(await imports.get(ready.id)).toEqual(ready);
    expect(Buffer.from(await (await imports.download(ready.id, "native")).arrayBuffer())).toEqual(Buffer.from(saved.original));
    insertEvents(saved.db, noopNotifier, [{ threadId: thread.id, sequence: getLatestThreadSequence(saved.db, { threadId: thread.id }) + 1, scope: { kind: "thread" }, type: "item/completed", providerThreadId: saved.selection.source.sessionId, itemId: "unrelated-invalid-item", itemKind: "agentMessage", parentToolCallId: null, data: JSON.stringify({ item: { type: "agentMessage", id: "unrelated-invalid-item", text: "Not imported history" } }) }]);
    expect(read).toThrow("item/completed requires turn scope but received thread scope");
  });
});
