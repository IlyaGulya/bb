import { threadEventItemSchema, type NativeHistoryRecord, type ThreadEventItem } from "@bb/domain";
import type { InsertEventInput } from "@bb/db";

const INLINE_CHARS = 16 * 1024;
export function nativeHistoryEvents(args: {
  importId: string; threadId: string; sessionId: string; ordinal: number;
  sequence: number; record: NativeHistoryRecord; fallbackTimestamp: number; recordSha256: string;
  toolContext(id: string): Extract<ThreadEventItem, { type: "toolCall" }> | null;
}): InsertEventInput[] {
  const events: InsertEventInput[] = [];
  const bounded = (text: string) => text.length <= INLINE_CHARS ? text : `${text.slice(0, INLINE_CHARS)}\n\n[Display preview. Open this thread's imported history and choose record ${args.ordinal} for the permanently retained full value.]`;
  for (const part of args.record.parts) {
    const id = part.callId && ["tool-call", "tool-result"].includes(part.kind)
      ? `native:${args.importId}:tool:${part.callId}` : `native:${args.importId}:${args.ordinal}:${part.id}`;
    let item: ThreadEventItem;
    const previous = part.kind === "tool-result" ? args.toolContext(id) : null;
    const argumentText = part.arguments === null ? null : JSON.stringify(part.arguments);
    const argumentsValue = argumentText !== null && argumentText.length > INLINE_CHARS ? { nativeArgumentsPreview: bounded(argumentText) } : part.arguments ?? previous?.arguments;
    if (part.kind === "user") item = { type: "userMessage", id, content: [{ type: "text", text: bounded(part.text) }] };
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
      threadId: args.threadId, providerThreadId: args.sessionId,
      sequence: args.sequence + events.length, scope: { kind: "thread" },
      type: part.kind === "tool-call" ? "item/started" : "item/completed",
      itemId: item.id, itemKind: item.type, parentToolCallId,
      createdAt: args.record.timestamp ?? args.fallbackTimestamp,
      data: JSON.stringify({ providerThreadId: args.sessionId, item, nativeImportRecord: { importId: args.importId, ordinal: args.ordinal, sha256: args.recordSha256, eventCount: args.record.parts.length } }),
    });
  }
  return events;
}
