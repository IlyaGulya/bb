import { describe, expect, it } from "vitest";
import {
  prepareMachineRequestSchema,
  transferWorkspaceRequestSchema,
  workspaceTransferOperationSchema,
} from "../src/api/workspace-transfer.js";

const transfer = {
  sourceEnvironmentId: "source",
  targetHostId: "target",
  targetPath: "/new/repo",
  includePaths: [],
};

describe("workspace portability contract", () => {
  it("requires canonical absolute target paths before any machine writes", () => {
    for (const targetPath of [
      "relative",
      "~/repo",
      "/",
      "/new/repo/",
      "/new/../repo",
      "/new/./repo",
      "/new//repo",
      "/new/\u0000repo",
    ]) {
      expect(
        transferWorkspaceRequestSchema.safeParse({ ...transfer, targetPath })
          .success,
      ).toBe(false);
    }
    expect(transferWorkspaceRequestSchema.parse(transfer)).toEqual(transfer);
  });

  it("defaults preparation to no additional files and rejects unsafe path selections", () => {
    expect(
      prepareMachineRequestSchema.parse({
        hostId: "target",
        targetPath: "/new/repo",
      }),
    ).toMatchObject({ copyPaths: [] });
    for (const entry of [
      "/absolute",
      "../secret",
      "nested/../../secret",
      ".git/config",
      "nested/.git/objects",
      "a\\b",
      "a\u0000b",
      "a\nb",
      "a:b",
    ]) {
      expect(
        transferWorkspaceRequestSchema.safeParse({
          ...transfer,
          includePaths: [entry],
        }).success,
      ).toBe(false);
    }
    expect(
      transferWorkspaceRequestSchema.parse({
        ...transfer,
        includePaths: [".env.explicit", "fixtures/binary.bin"],
      }).includePaths,
    ).toEqual([".env.explicit", "fixtures/binary.bin"]);
  });

  it("never represents an unverified operation as a ready continuation result", () => {
    const operation = {
      operationId: "operation",
      projectId: "project",
      sourceEnvironmentId: "source",
      sourceHostId: "host",
      targetHostId: "target",
      targetPath: "/new/repo",
      createdAt: 1,
      updatedAt: 2,
    };
    expect(
      workspaceTransferOperationSchema.safeParse({
        ...operation,
        status: "ready",
      }).success,
    ).toBe(false);
    expect(
      workspaceTransferOperationSchema.parse({
        ...operation,
        status: "interrupted",
        error: "Inspect the target before retrying",
      }),
    ).toMatchObject({ status: "interrupted" });
    expect(
      workspaceTransferOperationSchema.parse({
        ...operation,
        status: "ready",
        environmentId: "environment",
        hostId: "target",
        rootPath: "/new/repo",
        head: "head",
        branch: null,
        handoff: "Verified checkpoint",
      }),
    ).toMatchObject({ status: "ready", environmentId: "environment" });
  });
});
