import { describe, expect, it } from "vitest";
import { nativeLocationsSchema, nativeSessionSourceSchema, nativeSnapshotSchema } from "../src/index.js";

const root = { engine: "omp", path: "/fixture/native/sessions", profile: "Fixture profile", artifactRoots: ["/fixture/native/blobs"] };
const source = { ...root, path: "/fixture/native/sessions/source.jsonl", rootPath: root.path, sessionId: "fixture-session", title: "Fixture", cwd: "/fixture/workspace", sizeBytes: 100, revision: "fixture-revision", modifiedAt: 1 };

describe("native location and managed snapshot wire boundaries", () => {
  it("rejects credential selectors and excessive native location roots", () => {
    expect(nativeLocationsSchema.safeParse({ credentials: "/fixture/auth.json" }).success).toBe(false);
    expect(nativeLocationsSchema.safeParse({ roots: Array.from({ length: 17 }, () => root) }).success).toBe(false);
  });

  it("rejects invalid capture intent and caller-selected snapshot destinations", () => {
    expect(nativeSnapshotSchema.safeParse({ source, resolveOriginal: "true" }).success).toBe(false);
    expect(nativeSnapshotSchema.safeParse({ source, resolveOriginal: false, destinationPath: "/fixture/checkpoint" }).success).toBe(false);
  });

  it("rejects empty snapshot IDs and caller-provided managed paths", () => {
    const snapshot = { ...source, snapshotId: "fixture-managed-snapshot" };
    expect(nativeSessionSourceSchema.safeParse({ ...source, snapshotId: "" }).success).toBe(false);
    expect(nativeSessionSourceSchema.safeParse({ ...snapshot, managedPath: "/fixture/private-copy" }).success).toBe(false);
  });
});
