import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  captureCipherContext, captureEncryptionKey, capturePrivateDirectory,
  captureReadEncrypted, captureWriteEncrypted, decryptCaptureBytes,
  encryptCaptureBytes, registerCaptureKeyProvider,
} from "../src/index.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const context = { role: "host" as const, scopeDigest: digest("synthetic-project-context-capture"), objectId: "synthetic-artifact/0.chunk" };

describe("authenticated capture ciphertext", () => {
  it("binds frames to the key, role, scope and object, and rejects tampering or missing completion", () => {
    const key = randomBytes(32);
    const body = Buffer.from("SYNTHETIC_PRIVATE_BODY_".repeat(4100));
    const ciphertext = encryptCaptureBytes(key, context, body);
    expect(ciphertext.includes(body.subarray(0, 128))).toBe(false);
    expect(decryptCaptureBytes(key, context, ciphertext, body.length)).toEqual(body);
    for (const altered of [{ ...context, role: "core" as const }, { ...context, scopeDigest: digest("different-context") }, { ...context, objectId: "other-artifact/0.chunk" }]) {
      expect(() => decryptCaptureBytes(key, altered, ciphertext, body.length)).toThrow("integrity");
    }
    expect(() => decryptCaptureBytes(randomBytes(32), context, ciphertext, body.length)).toThrow("integrity");
    const changed = Buffer.from(ciphertext);
    changed[37] = changed[37]! ^ 1;
    expect(() => decryptCaptureBytes(key, context, changed, body.length)).toThrow("integrity");
    expect(() => decryptCaptureBytes(key, context, ciphertext.subarray(0, -32), body.length)).toThrow("integrity");
    expect(() => decryptCaptureBytes(key, context, Buffer.concat([ciphertext, Buffer.from([0])]), body.length)).toThrow("integrity");
  });


  it.skipIf(process.platform !== "linux" && process.platform !== "darwin")("persists ciphertext through atomic private writes without a plaintext fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "bb-capture-encryption-"));
    const master = randomBytes(32);
    const release = registerCaptureKeyProvider(root, "core", async () => master);
    try {
      const directory = await capturePrivateDirectory(root, "core", "synthetic");
      const binding = captureCipherContext(root, "core", { id: "synthetic", subject: { projectId: "A", executionContextId: "B" } }, "artifact/0.chunk");
      const body = Buffer.from("SYNTHETIC_CORE_BODY_".repeat(20000));
      await captureWriteEncrypted(directory, "0.chunk", body, binding);
      const disk = await readFile(join(directory, "0.chunk"));
      expect(disk.includes(body.subarray(0, 128))).toBe(false);
      expect(await captureReadEncrypted(directory, "0.chunk", body.length, binding)).toEqual(body);
      const derived = await captureEncryptionKey(root, "core", binding.scopeDigest);
      expect(decryptCaptureBytes(derived, binding, disk, body.length)).toEqual(body);
      await writeFile(join(directory, "legacy.chunk"), body, { mode: 0o600 });
      await expect(captureReadEncrypted(directory, "legacy.chunk", body.length, { ...binding, objectId: "artifact/legacy.chunk" })).rejects.toMatchObject({ code: "integrity" });
      await expect(captureWriteEncrypted(directory, "legacy.chunk", body, { ...binding, objectId: "artifact/legacy.chunk" })).rejects.toMatchObject({ code: "integrity" });
      expect(await readFile(join(directory, "legacy.chunk"))).toEqual(body);
    } finally {
      release();
      master.fill(0);
      await rm(root, { recursive: true, force: true });
    }
  });
});
