import { describe, expect, it } from "vitest";
import { nativeArtifactReferences, parseNativeHistoryRecord, type NativeRecordObject } from "../src/native-session-record.js";

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
});
