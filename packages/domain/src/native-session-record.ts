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
function structuredNativeArtifacts(record: NativeRecordObject, body: NativeRecordObject, type: string): string[] {
  const references = new Set<string>();
  const add = (value: JsonValue | undefined) => {
    if (typeof value === "string" && value.length) references.add(value.startsWith("blob://") ? value.slice(7) : value);
  };
  const descriptor = (value: JsonValue | undefined) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const key of ["path", "filePath", "blobPath", "artifactPath", "blobId", "checkpointPath", "statePath"]) add(value[key]);
    for (const key of ["blob", "attachment", "artifact"]) {
      const child = value[key];
      if (typeof child === "string") add(child);
      else if (child && typeof child === "object" && !Array.isArray(child)) { add(child.path); add(child.filePath); }
    }
  };
  const images = (values: JsonValue | undefined, requireImageType: boolean) => {
    if (!Array.isArray(values)) return;
    for (const image of values) {
      if (!image || typeof image !== "object" || Array.isArray(image)) continue;
      if (image.type !== "image" && (requireImageType || typeof image.mimeType !== "string" || !/^image\//i.test(image.mimeType))) continue;
      if (typeof image.data !== "string" || !image.data.startsWith("blob:sha256:")) continue;
      const hash = image.data.slice("blob:sha256:".length);
      if (hash.length === 64 && /^[a-f0-9]{64}$/.test(hash)) references.add(hash);
    }
  };
  const message = record.message;
  if (type === "message" && message && typeof message === "object" && !Array.isArray(message)) {
    if (typeof message.role === "string" && ["user", "developer", "assistant", "toolResult", "custom", "hookMessage"].includes(message.role)) images(message.content, true);
    if (message.role === "bashExecution" || message.role === "compactionSummary") images(message.images, false);
    if (message.role === "toolResult") {
      const details = message.details;
      if (details && typeof details === "object" && !Array.isArray(details)) images(details.images, false);
    }
  }
  if (type === "custom_message") images(record.content, true);
  const preserveData = record.preserveData;
  if (type === "compaction" && preserveData && typeof preserveData === "object" && !Array.isArray(preserveData)) {
    let archive: JsonValue | undefined = preserveData.snapcompact;
    while (archive && typeof archive === "object" && !Array.isArray(archive)) {
      images(archive.frames, false);
      const view: JsonValue | undefined = archive.withoutThinking;
      archive = view && typeof view === "object" && !Array.isArray(view) ? view.archive : undefined;
    }
  }
  if (["checkpoint", "branch_checkpoint", "branch-checkpoint", "compacted", "compaction"].includes(type) || (type === "system" && record.subtype === "compact_boundary")) {
    descriptor(record);
    descriptor(record.payload);
  }
  descriptor(record.checkpoint);
  if (Array.isArray(record.attachments)) for (const attachment of record.attachments) descriptor(attachment);
  if (Array.isArray(body.content)) for (const value of body.content) {
    const block = object(value);
    if (["image", "image_url", "input_image", "document", "file", "attachment", "artifact"].includes(String(block.type))) {
      descriptor(block);
      descriptor(block.source);
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
    parts, artifacts: structuredNativeArtifacts(record, body, type), state: record };
}
