import { z } from "zod";
import { parseStoredThreadEvent, threadEventItemSchema, turnScope, type NativeHistoryRecord, type PromptInput, type ThreadEventItem } from "@bb/domain";
import type { DbConnection, InsertEventInput, StoredEventRow } from "@bb/db";
import { mapTimelineRowTree } from "@bb/server-contract";
import { buildThreadTimelineFromEvents, type ThreadEventWithMeta } from "@bb/thread-view";
import { nativeHistoryMetadata } from "./native-history-guard.js";

const INLINE_CHARS = 16 * 1024;
function historyTurnId(importId: string, ordinal: number): string {
  return `native:${importId}:record:${ordinal}`;
}
export function nativeHistoryEvents(args: {
  importId: string; threadId: string; sessionId: string; ordinal: number;
  sequence: number; record: NativeHistoryRecord; fallbackTimestamp: number; recordSha256: string;
  toolContext(id: string): Extract<ThreadEventItem, { type: "toolCall" }> | null;
}): InsertEventInput[] {
  if (!args.record.parts.length) return [];
  const events: InsertEventInput[] = [];
  const base = { threadId: args.threadId, providerThreadId: args.sessionId, scope: turnScope(historyTurnId(args.importId, args.ordinal)), createdAt: args.record.timestamp ?? args.fallbackTimestamp };
  const provenance = { importId: args.importId, ordinal: args.ordinal, sha256: args.recordSha256, eventCount: args.record.parts.length + 2, projectionVersion: 2 };
  const boundary = (type: "turn/started" | "turn/completed") => events.push({
    ...base, sequence: args.sequence + events.length, type, itemId: null, itemKind: null, parentToolCallId: null,
    data: JSON.stringify({ providerThreadId: args.sessionId, ...(type === "turn/completed" ? { status: "completed" } : {}), nativeImportRecord: provenance }),
  });
  boundary("turn/started");
  const bounded = (text: string) => text.length <= INLINE_CHARS ? text : `${text.slice(0, INLINE_CHARS)}\n\n[Display preview. Open this thread's imported history and choose record ${args.ordinal} for the permanently retained full value.]`;
  for (const part of args.record.parts) {
    const id = part.callId && ["tool-call", "tool-result"].includes(part.kind)
      ? `native:${args.importId}:tool:${part.callId}` : `native:${args.importId}:${args.ordinal}:${part.id}`;
    let item: ThreadEventItem;
    const previous = part.kind === "tool-result" ? args.toolContext(id) : null;
    const argumentText = part.arguments === null ? null : JSON.stringify(part.arguments);
    const argumentsValue = argumentText !== null && argumentText.length > INLINE_CHARS ? { nativeArgumentsPreview: bounded(argumentText) } : part.arguments ?? previous?.arguments;
    if (part.kind === "user") {
      const input: Extract<PromptInput, { type: "text" }> = { type: "text", text: bounded(part.text), mentions: [] };
      item = { type: "userMessage", id, content: [input] };
    }
    else if (part.kind === "assistant") item = { type: "agentMessage", id, text: bounded(part.text) };
    else if (part.kind === "reasoning") item = { type: "reasoning", id, summary: [], content: [bounded(part.text)] };
    else item = {
      type: "toolCall", id, tool: part.name ?? previous?.tool ?? "Native tool",
      ...(argumentsValue ? { arguments: argumentsValue } : {}),
      status: part.kind === "tool-call" ? "pending" : part.failed ? "failed" : "completed",
      ...(part.kind === "tool-result" ? { result: bounded(part.text) } : {}),
    };
    const parentToolCallId = part.parentId === null ? null : `native:${args.importId}:tool:${part.parentId}`;
    if (parentToolCallId) item = { ...item, parentToolCallId };
    item = threadEventItemSchema.parse(item);
    events.push({
      ...base, sequence: args.sequence + events.length,
      type: part.kind === "tool-call" ? "item/started" : "item/completed",
      itemId: item.id, itemKind: item.type, parentToolCallId,
      data: JSON.stringify({ providerThreadId: args.sessionId, item, nativeImportRecord: provenance }),
    });
  }
  boundary("turn/completed");
  return events;
}

const historyOwnerSchema = z.object({ importId: z.string().regex(/^[a-f0-9]{64}$/), nativeSessionId: z.string().min(1) });
const historyPayloadSchema = z.object({
  providerThreadId: z.string(),
  item: threadEventItemSchema.optional(),
  status: z.literal("completed").optional(),
  nativeImportRecord: z.object({
    importId: z.string().regex(/^[a-f0-9]{64}$/), ordinal: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), eventCount: z.number().int().positive(),
    projectionVersion: z.literal(2).optional(),
  }),
});
const historyEventTypes = new Set<StoredEventRow["type"]>(["item/started", "item/completed", "turn/started", "turn/completed"]);
const emptyHistory: ReadonlyMap<string, ThreadEventWithMeta> = new Map();
function isHistoryCandidate(row: StoredEventRow): boolean {
  return historyEventTypes.has(row.type) && (row.itemId?.startsWith("native:") === true || row.turnId?.startsWith("native:") === true);
}
export function decodeNativeHistoryRows(db: DbConnection, rows: readonly StoredEventRow[]): ReadonlyMap<string, ThreadEventWithMeta> {
  if (!rows.some(isHistoryCandidate)) return emptyHistory;
  const decoded = new Map<string, ThreadEventWithMeta>();
  const owners = new Map<string, z.infer<typeof historyOwnerSchema> | null>();
  for (const row of rows) {
    if (!isHistoryCandidate(row)) continue;
    let owner = owners.get(row.threadId);
    if (owner === undefined) {
      owner = historyOwnerSchema.safeParse(nativeHistoryMetadata(db, row.threadId)).data ?? null;
      owners.set(row.threadId, owner);
    }
    if (owner === null || row.providerThreadId !== owner.nativeSessionId) continue;
    let payload: z.infer<typeof historyPayloadSchema>;
    try {
      const parsed = historyPayloadSchema.safeParse(JSON.parse(row.data));
      if (!parsed.success) continue;
      payload = parsed.data;
    } catch { continue; }
    const provenance = payload.nativeImportRecord;
    if (provenance.importId !== owner.importId || payload.providerThreadId !== owner.nativeSessionId) continue;
    const turnId = historyTurnId(owner.importId, provenance.ordinal);
    const legacy = provenance.projectionVersion === undefined && row.scopeKind === "thread" && row.turnId === null;
    if (!legacy && (provenance.projectionVersion !== 2 || row.scopeKind !== "turn" || row.turnId !== turnId)) continue;
    const prefix = `native:${owner.importId}:`;
    const item = payload.item;
    const isItem = row.type === "item/started" || row.type === "item/completed";
    if (isItem) {
      if (!item || row.itemId !== item.id || row.itemKind !== item.type || (item.parentToolCallId ?? null) !== row.parentToolCallId) continue;
      if (!item.id.startsWith(`${prefix}${provenance.ordinal}:`) && !(item.type === "toolCall" && item.id.startsWith(`${prefix}tool:`))) continue;
    } else if (legacy || row.itemId !== null || row.parentToolCallId !== null || provenance.eventCount < 3) continue;
    decoded.set(row.id, {
      event: parseStoredThreadEvent({ type: row.type, data: payload, threadId: row.threadId, providerThreadId: row.providerThreadId, scope: turnScope(turnId) }),
      meta: { id: row.id, seq: row.sequence, createdAt: row.createdAt },
    });
  }
  return decoded;
}

export function buildTimelineWithNativeHistory(
  args: Parameters<typeof buildThreadTimelineFromEvents>[0],
  native: ReadonlyMap<string, ThreadEventWithMeta>,
): ReturnType<typeof buildThreadTimelineFromEvents> {
  if (!native.size) return buildThreadTimelineFromEvents(args);
  const timeline = buildThreadTimelineFromEvents({ ...args, events: args.events.filter(({ meta }) => !native.has(meta.id)) });
  const frames = new Map<string, { first: ThreadEventWithMeta; last: ThreadEventWithMeta; items: ThreadEventWithMeta[] }>();
  for (const entry of args.events) {
    if (!native.has(entry.meta.id) || entry.event.scope.kind !== "turn") continue;
    const turnId = `native-history:${entry.event.threadId}`;
    let frame = frames.get(turnId);
    if (!frame) { frame = { first: entry, last: entry, items: [] }; frames.set(turnId, frame); }
    if (entry.meta.seq < frame.first.meta.seq) frame.first = entry;
    if (entry.meta.seq > frame.last.meta.seq) frame.last = entry;
    if (entry.event.type === "item/started" || entry.event.type === "item/completed") frame.items.push({ ...entry, event: { ...entry.event, scope: turnScope(turnId) } });
  }
  const events: ThreadEventWithMeta[] = [];
  for (const [turnId, frame] of frames) {
    if (!frame.items.length) continue;
    const boundary = (type: "turn/started" | "turn/completed", source: ThreadEventWithMeta): ThreadEventWithMeta => ({
      event: parseStoredThreadEvent({ type, threadId: source.event.threadId, providerThreadId: "providerThreadId" in source.event ? source.event.providerThreadId : null, scope: turnScope(turnId), data: type === "turn/completed" ? { status: "completed" } : {} }),
      meta: { ...source.meta, id: `${source.meta.id}:native-history:${type}` },
    });
    events.push(boundary("turn/started", frame.first), ...frame.items, boundary("turn/completed", frame.last));
  }
  const historical = buildThreadTimelineFromEvents({ ...args, events, headStateEvents: [], contextWindowEvents: [], acceptedClientRequestContext: { acceptedClientRequestEvents: [], rejectedClientRequestEvents: [] }, options: { ...args.options, includeNestedRows: true, preservePendingToolActivity: true } });
  const rows = mapTimelineRowTree(historical.rows.flatMap((row) => row.kind === "turn" ? row.children ?? [] : [row]), (row) => row.kind === "turn" ? row : { ...row, turnId: null });
  return { ...timeline, rows: [...timeline.rows, ...rows].sort((left, right) => left.sourceSeqStart - right.sourceSeqStart || left.sourceSeqEnd - right.sourceSeqEnd) };
}
