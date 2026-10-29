import { z } from "zod";
import type { JsonValue } from "./json-value.js";
export const NATIVE_HISTORY_OWNER = "native-session-history";

const objectSchema = z.record(z.string(), z.json());
export type NativeRecordObject = z.infer<typeof objectSchema>;
export interface NativeHistoryPart {
  id: string;
  kind: "user" | "assistant" | "reasoning" | "tool-call" | "tool-result";
  text: string;
  name: string | null;
  callId: string | null;
  parentId: string | null;
  failed: boolean;
  arguments: NativeRecordObject | null;
}
export interface NativeHistoryRecord {
  id: string | null;
  parentId: string | null;
  timestamp: number | null;
  type: string;
  sessionId: string | null;
  cwd: string | null;
  title: string | null;
  parts: NativeHistoryPart[];
  artifacts: string[];
  state: NativeRecordObject;
}
function object(value: JsonValue | undefined): NativeRecordObject {
  return objectSchema.safeParse(value).data ?? {};
}
function string(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function text(value: JsonValue | undefined): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((entry) => {
    const block = object(entry);
    return typeof block.text === "string" ? block.text : typeof block.content === "string" ? block.content : JSON.stringify(entry);
  }).join("\n");
  return value === undefined ? "" : JSON.stringify(value);
}
export function nativeArtifactReferences(value: NativeRecordObject): string[] {
  const references = new Set<string>();
  const queue: JsonValue[] = [value];
  for (let index = 0; index < queue.length; index++) {
    const entry = queue[index];
    if (Array.isArray(entry)) { for (const child of entry) queue.push(child); continue; }
    if (!entry || typeof entry !== "object") continue;
    for (const [key, child] of Object.entries(entry)) {
      if (["blobPath", "artifactPath", "blobId", "checkpointPath", "statePath"].includes(key) && typeof child === "string") references.add(child);
      if (["blob", "attachment", "artifact"].includes(key)) {
        if (typeof child === "string") references.add(child);
        else if (child && typeof child === "object" && !Array.isArray(child)) {
          const path = child.path ?? child.filePath;
          if (typeof path === "string") references.add(path);
        }
      }
      if (typeof child === "string" && child.startsWith("blob://")) references.add(child.slice(7));
      if (child && typeof child === "object") queue.push(child);
    }
  }
  return [...references];
}
export function parseNativeHistoryRecord(input: unknown, ordinal: number): NativeHistoryRecord {
  const record = objectSchema.parse(input);
  const payload = object(record.payload);
  const message = object(record.message);
  const body = Object.keys(message).length ? message : Object.keys(payload).length ? payload : record;
  const type = string(record.type) ?? string(body.type) ?? "native-state";
  const id = string(record.id) ?? string(record.uuid) ?? string(body.id);
  const parentId = string(record.parentId) ?? string(record.parentUuid) ?? string(record.parent_id);
  const timestampValue = record.timestamp ?? body.timestamp;
  const parsedTime = typeof timestampValue === "number" ? timestampValue : typeof timestampValue === "string" ? Date.parse(timestampValue) : NaN;
  const parts: NativeHistoryPart[] = [];
  const push = (kind: NativeHistoryPart["kind"], content: string, block: NativeRecordObject, partIndex: number) => {
    const callId = string(block.toolCallId) ?? string(block.tool_use_id) ?? string(block.call_id) ?? string(block.id);
    let args = object(block.arguments ?? block.input);
    if (typeof block.arguments === "string") {
      try { args = objectSchema.parse(JSON.parse(block.arguments)); } catch { args = { nativeArguments: block.arguments }; }
    }
    parts.push({ id: `${id ?? ordinal}:${partIndex}`, kind, text: content,
      name: string(block.toolName) ?? string(block.name), callId,
      parentId: string(record.parent_tool_use_id),
      failed: block.isError === true || block.is_error === true,
      arguments: Object.keys(args).length ? args : null });
  };
  const role = string(body.role) ?? (type === "user" ? "user" : type === "assistant" ? "assistant" : null);
  const content = body.content;
  if (role === "toolResult" || role === "tool") {
    push("tool-result", text(content ?? body.output), body, 0);
  } else if (role === "user" || role === "assistant") {
    if (typeof content === "string") push(role, content, body, 0);
    else if (Array.isArray(content)) content.forEach((entry, index) => {
      const block = object(entry);
      const blockType = string(block.type);
      if (["tool_use", "toolCall", "function_call"].includes(blockType ?? "")) push("tool-call", "", block, index);
      else if (["tool_result", "toolResult", "function_call_output"].includes(blockType ?? "")) push("tool-result", text(block.content ?? block.output), block, index);
      else if (["thinking", "reasoning"].includes(blockType ?? "")) push("reasoning", text(block.thinking ?? block.text), block, index);
      else if (typeof block.text === "string") push(role, block.text, block, index);
      else if (["image", "image_url", "input_image", "document"].includes(blockType ?? "")) push(role, JSON.stringify(block), block, index);
    });
  } else if (type === "response_item") {
    if (body.type === "function_call" || body.type === "custom_tool_call") push("tool-call", "", body, 0);
    else if (body.type === "function_call_output" || body.type === "custom_tool_call_output") push("tool-result", text(body.output), body, 0);
    else if (body.type === "reasoning") push("reasoning", text(body.summary ?? body.content), body, 0);
  } else if (type === "event_msg" && ["user_message", "agent_message"].includes(String(body.type))) {
    push(body.type === "user_message" ? "user" : "assistant", text(body.message), body, 0);
  }
  const header = type === "session_meta" ? payload : record;
  return { id, parentId, timestamp: Number.isFinite(parsedTime) ? parsedTime : null, type,
    sessionId: type === "session" || type === "session_meta" ? string(header.id) : string(record.sessionId) ?? string(record.session_id),
    cwd: string(header.cwd), title: string(record.title) ?? string(record.summary),
    parts, artifacts: nativeArtifactReferences(record), state: record };
}
