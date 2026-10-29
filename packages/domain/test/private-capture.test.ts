import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { captureManifestSchema } from "../src/private-capture.js";

const source = Buffer.from("Authorization: Bearer SYNTHETIC_TOKEN\n");
const sha256 = createHash("sha256").update(source).digest("hex");
const manifest = {
  version: 2, captureId: "00000000-0000-4000-8000-000000000001", artifactId: sha256,
  source: "owner-import", sourceId: "synthetic-fidelity", sourceOffset: 0,
  hostId: null, runId: null, nativeSessionId: null, models: [], indexLimited: false,
  destinations: [], transport: "file", requestId: null, observedAt: null,
  sourceBytes: source.length, sourceSha256: sha256, storedBytes: source.length, storedSha256: sha256,
  representation: "raw", streamState: "unknown", fidelity: "source-bytes",
  redactionPolicy: "source-preserved-v2", redacted: false, payloadSecrets: "not-guaranteed",
  chunks: [{ sequence: 0, bytes: source.length, sha256 }],
};

describe("capture byte-fidelity boundary", () => {
  it.each([
    { sourceBytes: source.length + 1 },
    { sourceSha256: "f".repeat(64) },
    { redacted: true },
    { fidelity: "redacted-source" },
    { redactionPolicy: "headers-json-credentials-v1" },
    { representation: "normalized" },
    { version: 1 },
  ])("rejects a manifest that misrepresents preserved source bytes: %j", patch => {
    expect(captureManifestSchema.safeParse(manifest).success).toBe(true);
    expect(captureManifestSchema.safeParse({ ...manifest, ...patch }).success).toBe(false);
  });
});
