import { describe, expect, it } from "vitest";
import {
  hostDaemonOnlineRpcCommandSchema,
  workspaceCheckpointSchema,
  workspaceTransferFileSchema,
  workspaceTransferPathSchema,
  WORKSPACE_TRANSFER_MAX_FILES,
} from "../src/index.js";

const file = {
  path: "binary/file.bin",
  contentBase64: "AP8=",
  mode: "100755",
  permissions: 0o755,
  sha256: "a".repeat(64),
};
const checkpoint = {
  version: 1,
  head: "b".repeat(40),
  branch: null,
  bundleBase64: "AP8=",
  bundleSha256: "c".repeat(64),
  lfsPaths: [],
  index: [
    {
      path: "unchanged.bin",
      mode: "100644",
      oid: "d".repeat(40),
      intentToAdd: false,
    },
  ],
  worktree: [{ path: file.path, file }],
  extraFiles: [],
  filePermissions: [{ path: file.path, permissions: file.permissions }],
};

describe("workspace transfer wire contracts", () => {
  it.each([
    "../outside",
    "/absolute",
    "nested/../../outside",
    "nested//file",
    ".git/config",
    "nested/.GIT/config",
    "C:/outside",
    "nested\\outside",
    "line\nbreak",
  ])("refuses unsafe relative path %j", (relative) => {
    expect(workspaceTransferPathSchema.safeParse(relative).success).toBe(false);
  });

  it("rejects truncated base64, unknown fields, mismatched optional index content, and excessive metadata", () => {
    expect(
      workspaceTransferFileSchema.safeParse({ ...file, contentBase64: "AP8" })
        .success,
    ).toBe(false);
    expect(
      workspaceTransferFileSchema.safeParse({ ...file, unexpected: true })
        .success,
    ).toBe(false);
    expect(
      workspaceTransferFileSchema.safeParse({ ...file, permissions: 0o600 })
        .success,
    ).toBe(false);
    expect(
      workspaceTransferFileSchema.safeParse({ ...file, permissions: 0o1777 })
        .success,
    ).toBe(false);
    expect(
      workspaceCheckpointSchema.safeParse({
        ...checkpoint,
        index: [{ ...checkpoint.index[0], contentBase64: "AP8=" }],
      }).success,
    ).toBe(false);
    expect(
      workspaceCheckpointSchema.safeParse({
        ...checkpoint,
        index: Array.from(
          { length: WORKSPACE_TRANSFER_MAX_FILES + 1 },
          () => checkpoint.index[0],
        ),
      }).success,
    ).toBe(false);
    expect(
      hostDaemonOnlineRpcCommandSchema.safeParse({
        type: "workspace.capture",
        rootPath: "/workspace",
      }).success,
    ).toBe(false);
  });
});
