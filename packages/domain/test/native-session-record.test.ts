import { describe, expect, it } from "vitest";
import { nativeArtifactReferences, parseNativeHistoryRecord, type NativeRecordObject } from "../src/native-session-record.js";

const numericSpillRecord = (toolName: string, text: string): NativeRecordObject => ({ type: "message", message: { role: "toolResult", toolName, content: [{ type: "text", text }], details: { timeoutSeconds: 60, wallTimeMs: 5 } } });

describe("native history records", () => {
  it("keeps OMP branches, reasoning, tool arguments and opaque checkpoint state", () => {
    const original = { type: "message", id: "branch-b", parentId: "branch-a", timestamp: "2026-01-02T03:04:05Z", checkpoint: { branch: "saved", statePath: "state.bin" }, message: { role: "assistant", content: [{ type: "thinking", thinking: "Private saved reasoning" }, { type: "toolCall", id: "call-a", name: "bash", arguments: { command: "do-not-execute" } }] } };
    const parsed = parseNativeHistoryRecord(original, 3);
    expect(parsed).toMatchObject({ id: "branch-b", parentId: "branch-a", timestamp: Date.parse(original.timestamp), state: original, artifacts: ["state.bin"] });
    expect(parsed.parts).toMatchObject([{ kind: "reasoning", text: "Private saved reasoning" }, { kind: "tool-call", callId: "call-a", name: "bash", arguments: { command: "do-not-execute" } }]);
  });

  it("retains Claude failed tool results and their original parent identity", () => {
    const result = parseNativeHistoryRecord({ type: "user", uuid: "result", parentUuid: "assistant", sessionId: "claude-source", parent_tool_use_id: "parent-tool", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-a", is_error: true, content: [{ type: "text", text: "Original tool failure" }] }] } }, 4);
    expect(result).toMatchObject({ id: "result", parentId: "assistant", sessionId: "claude-source" });
    expect(result.parts).toMatchObject([{ kind: "tool-result", callId: "tool-a", parentId: "parent-tool", failed: true, text: "Original tool failure" }]);
  });

  it("preserves malformed Codex function arguments as data rather than evaluating them", () => {
    const value = "process.exit(12)";
    const parsed = parseNativeHistoryRecord({ type: "response_item", payload: { type: "function_call", call_id: "call-a", name: "shell", arguments: value } }, 2);
    expect(parsed.parts).toMatchObject([{ kind: "tool-call", callId: "call-a", arguments: { nativeArguments: value } }]);
  });

  it("keeps unsupported native state losslessly without inventing a message", () => {
    const original = { type: "future-checkpoint", id: "checkpoint-a", parentId: "branch-a", payload: { compressed: "opaque-value", version: 45, settings: { hook: "not-executed" } } };
    const parsed = parseNativeHistoryRecord(original, 8);
    expect(parsed.state).toEqual(original);
    expect(parsed.parts).toEqual([]);
    expect(parsed.parentId).toBe("branch-a");
  });

  it("finds deeply nested artifact references without overflowing spread argument limits", () => {
    const value: NativeRecordObject = { blocks: Array.from({ length: 150_000 }, () => null), payload: { images: [{ artifactPath: "image.bin" }, { attachment: { filePath: "image.bin" } }, { checkpointPath: "checkpoint.bin" }, { reference: "blob://result.bin" }] } };
    expect(nativeArtifactReferences(value)).toEqual(["image.bin", "checkpoint.bin", "result.bin"]);
  });

  it.each(["user", "developer", "assistant", "toolResult", "custom", "hookMessage"])("retains canonical OMP image blobs in %s content", (role) => {
    const hash = "0123456789abcdef".repeat(4);
    const image = { type: "image", data: `blob:sha256:${hash}`, mimeType: "image/png" };
    const original = { type: "message", message: { role, content: [image] } };
    const parsed = parseNativeHistoryRecord(original, 0);
    expect(parsed.artifacts).toEqual([hash]);
  });

  it.each(["bashExecution", "compactionSummary"])("retains canonical OMP saved images in %s", (role) => {
    const hash = "a".repeat(64);
    const parsed = parseNativeHistoryRecord({ type: "message", message: { role, images: [{ type: "image", data: `blob:sha256:${hash}`, mimeType: "image/png" }] } }, 0);
    expect(parsed.artifacts).toEqual([hash]);
  });

  it("retains saved native tool-result detail images without scanning other result metadata", () => {
    const hash = "a1".repeat(32);
    const image = { type: "image", data: `blob:sha256:${hash}`, mimeType: "image/png" };
    const other = { type: "image", data: `blob:sha256:${"a2".repeat(32)}`, mimeType: "image/png" };
    const parsed = parseNativeHistoryRecord({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: other.data }], details: { images: [image], other: { images: [other] } } } }, 0);
    expect(parsed.artifacts).toEqual([hash]);
  });

  it("retains images in native custom-message entries", () => {
    const hash = "b".repeat(64);
    const parsed = parseNativeHistoryRecord({ type: "custom_message", customType: "saved-image", content: [{ type: "image", data: `blob:sha256:${hash}`, mimeType: "image/png" }] }, 0);
    expect(parsed.artifacts).toEqual([hash]);
  });

  it("retains snapcompact frames and their without-thinking archive but not unrelated preserved data", () => {
    const full = "c".repeat(64);
    const withoutThinking = "d".repeat(64);
    const unrelated = { data: `blob:sha256:${"e".repeat(64)}`, mimeType: "image/png" };
    const parsed = parseNativeHistoryRecord({ type: "compaction", preserveData: {
      snapcompact: { frames: [{ data: `blob:sha256:${full}`, mimeType: "image/png" }], withoutThinking: { summary: "Saved context", archive: { frames: [{ data: `blob:sha256:${withoutThinking}`, mimeType: "image/png" }] } }, text: unrelated.data },
      other: { frames: [unrelated] },
    } }, 0);
    expect(parsed.artifacts).toEqual([full, withoutThinking]);
  });

  it.each([
    `blob:sha256:${"A".repeat(64)}`,
    `blob:sha256:${"a".repeat(63)}`,
    `blob:sha256:${"a".repeat(65)}`,
    `blob:sha256:${"a".repeat(64)}\n`,
    `blob:sha256:${"a".repeat(64)}.png`,
    `blob:sha256:${"a".repeat(64)}/../.netrc`,
    "blob:sha256:../.netrc",
    "blob:sha256:/outside/image.png",
    "blob://image.png",
    "data:image/png;base64,aW1hZ2U=",
  ])("does not turn noncanonical OMP image data into file authority: %j", (data) => {
    expect(parseNativeHistoryRecord({ type: "message", message: { role: "user", content: [{ type: "image", data, mimeType: "image/png" }] } }, 0).artifacts).toEqual([]);
  });

  it("does not authorize blobs from ordinary text, tool arguments or image-shaped metadata", () => {
    const data = `blob:sha256:${"f".repeat(64)}`;
    const image = { type: "image", data, mimeType: "image/png" };
    const parsed = parseNativeHistoryRecord({ type: "message", message: { role: "assistant", content: [
      { type: "text", text: data, data },
      { type: "toolCall", id: "untrusted", name: "test", arguments: { text: data, content: [image], images: [image], preserveData: { snapcompact: { frames: [image] } } } },
    ], details: { images: [image] } }, payload: { content: [image] } }, 0);
    expect(parsed.artifacts).toEqual([]);
    expect(parseNativeHistoryRecord({ type: "future-state", content: [image], images: [image], preserveData: { snapcompact: { frames: [image] } } }, 0).artifacts).toEqual([]);
  });

  it.each([
    { toolName: "bash", text: "[Raw output: artifact://25]", reference: "artifact://25" },
    { toolName: "read", text: "[Raw output: artifact://25]", reference: "artifact://25" },
    { toolName: "eval", text: "[Raw output: artifact://25]", reference: "artifact://25" },
    { toolName: "bash", text: "[raw output: artifact://0]", reference: "artifact://0" },
  ])("retains native numeric spill references in $toolName results: $reference", ({ toolName, text, reference }) => {
    const parsed = parseNativeHistoryRecord(numericSpillRecord(toolName, text), 0);
    expect(parsed.artifacts).toEqual([reference]);
  });

  it.each([
    { name: "user message", record: { type: "message", message: { role: "user", content: [{ type: "text", text: "[Raw output: artifact://25]" }] } } },
    { name: "assistant prose", record: { type: "message", message: { role: "assistant", content: [{ type: "text", text: "[Raw output: artifact://25]" }] } } },
    { name: "tool arguments", record: { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { text: "[Raw output: artifact://25]", entry: numericSpillRecord("bash", "[Raw output: artifact://25]") } }] } } },
    { name: "unrelated result metadata", record: { type: "message", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "A short result" }], details: { text: "[Raw output: artifact://25]" } } } },
    { name: "ordinary tool-output prose", record: numericSpillRecord("bash", "The command printed artifact://25 as ordinary text") },
  ])("does not grant native numeric spill authority to $name", ({ record }) => {
    expect(parseNativeHistoryRecord(record, 0).artifacts).toEqual([]);
  });

  it.each([
    "artifact://../.credentials.json",
    "artifact://25/../../.netrc",
    "artifact://25/.mcp.json",
    "artifact://25.bash-original.log",
    "artifact://25 artifact://26",
  ])("rejects nonnumeric or ambiguous native numeric spill footer references: %s", (reference) => {
    expect(parseNativeHistoryRecord(numericSpillRecord("bash", `[Raw output: ${reference}]`), 0).artifacts).toEqual([]);
  });
});
