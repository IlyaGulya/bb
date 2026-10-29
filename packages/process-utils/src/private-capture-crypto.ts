import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, realpath, statfs } from "node:fs/promises";
import { resolve } from "node:path";
import { execPortableFile } from "./exec-portable-file.js";
import { CaptureStorageError, captureObjectDigest, captureReadPrivate, captureSha256, captureWritePrivate } from "./private-capture-files.js";

export type CaptureKeyRole = "host" | "core";
export type CaptureKeyProvider = () => Promise<Uint8Array>;
export interface CaptureCipherContext {
  dataDir: string;
  role: CaptureKeyRole;
  scopeDigest: string;
  objectId: string;
}
export function captureCipherContext(dataDir: string, role: CaptureKeyRole, session: { id: string; subject: object }, objectId: string): CaptureCipherContext {
  return { dataDir, role, scopeDigest: captureObjectDigest({ id: session.id, subject: session.subject }), objectId };
}
const magic = Buffer.from("BBPC1\n");
const frameBytes = 65536;
const providers = new Map<string, CaptureKeyProvider>();
const operatorKeys = new Map<string, Promise<Buffer>>();
function providerId(dataDir: string, role: CaptureKeyRole): string { return `${resolve(dataDir)}\0${role}`; }
export function registerCaptureKeyProvider(dataDir: string, role: CaptureKeyRole, provider: CaptureKeyProvider): () => void {
  const id = providerId(dataDir, role);
  if (providers.has(id)) throw new CaptureStorageError("integrity");
  providers.set(id, provider);
  return () => { if (providers.get(id) === provider) providers.delete(id); };
}
export function captureKeyReference(role: CaptureKeyRole): string {
  const value = process.env[role === "host" ? "BB_PRIVATE_CAPTURE_HOST_KEY_REF" : "BB_PRIVATE_CAPTURE_CORE_KEY_REF"];
  if (!value) throw new CaptureStorageError("storage_unavailable");
  return value;
}
export async function captureRequireMemoryFilesystem(path: string): Promise<void> {
  if (process.platform !== "linux") throw new CaptureStorageError("storage_unavailable");
  const filesystem = await statfs(path);
  if (Number(filesystem.type) === 0x858458f6) return;
  if (Number(filesystem.type) !== 0x01021994 || (await readFile("/proc/swaps", "utf8")).trim().split("\n").length !== 1) throw new CaptureStorageError("storage_unavailable");
}
async function operatorKey(reference: string): Promise<Buffer> {
  let value: string;
  if (reference.startsWith("memory-file:")) {
    const path = reference.slice("memory-file:".length);
    if (!path.startsWith("/") || await realpath(path) !== path) throw new CaptureStorageError("storage_unavailable");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > 65 || (before.mode & 0o077) !== 0 || (process.getuid !== undefined && before.uid !== process.getuid())) throw new CaptureStorageError("storage_unavailable");
      await captureRequireMemoryFilesystem(`/proc/self/fd/${handle.fd}`);
      value = (await handle.readFile("utf8")).trim();
      const after = await handle.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new CaptureStorageError("integrity");
    } finally { await handle.close(); }
  } else {
    const match = /^keychain:([a-zA-Z0-9._-]{1,128}):([a-zA-Z0-9._-]{1,128})$/u.exec(reference);
    if (process.platform !== "darwin" || !match) throw new CaptureStorageError("storage_unavailable");
    const result = await execPortableFile("/usr/bin/security", ["find-generic-password", "-w", "-s", match[1]!, "-a", match[2]!], { cwd: "/", env: { PATH: "/usr/bin:/bin" }, maxBuffer: 128, timeout: 30000 });
    value = result.stdout.trim();
  }
  if (!/^[a-fA-F0-9]{64}$/u.test(value)) throw new CaptureStorageError("storage_unavailable");
  return Buffer.from(value, "hex");
}
export async function captureEncryptionKey(dataDir: string, role: CaptureKeyRole, scopeDigest: string): Promise<Buffer> {
  if (!/^[a-f0-9]{64}$/u.test(scopeDigest)) throw new CaptureStorageError("integrity");
  try {
    const provider = providers.get(providerId(dataDir, role));
    let master: Uint8Array;
    if (provider) master = await provider();
    else {
      const reference = captureKeyReference(role);
      let key = operatorKeys.get(reference);
      if (!key) {
        key = operatorKey(reference);
        operatorKeys.set(reference, key);
        void key.catch(() => { if (operatorKeys.get(reference) === key) operatorKeys.delete(reference); });
      }
      master = await key;
    }
    if (master.byteLength !== 32) throw new CaptureStorageError("storage_unavailable");
    return Buffer.from(hkdfSync("sha256", master, Buffer.from(scopeDigest, "hex"), Buffer.from(`bb-private-capture/v1/${role}`), 32));
  } catch (error) {
    if (error instanceof CaptureStorageError) throw error;
    throw new CaptureStorageError("storage_unavailable");
  }
}
function aad(context: Pick<CaptureCipherContext, "role" | "scopeDigest" | "objectId">, sequence: number, size: number): Buffer {
  if (!/^[a-f0-9]{64}$/u.test(context.scopeDigest) || !/^[a-zA-Z0-9:._/-]{1,256}$/u.test(context.objectId)) throw new CaptureStorageError("integrity");
  return Buffer.from(`bb-private-capture/v1\0${context.role}\0${context.scopeDigest}\0${context.objectId}\0${sequence}\0${size}`);
}
export function captureEncryptedSize(bytes: number): number { return magic.length + bytes + (Math.ceil(bytes / frameBytes) + 1) * 32; }
export function encryptCaptureBytes(key: Uint8Array, context: Pick<CaptureCipherContext, "role" | "scopeDigest" | "objectId">, plaintext: Uint8Array): Buffer {
  const output = Buffer.allocUnsafe(captureEncryptedSize(plaintext.byteLength));
  magic.copy(output);
  let position = magic.length;
  let sequence = 0;
  for (let offset = 0;; offset += frameBytes) {
    const part = plaintext.subarray(offset, Math.min(offset + frameBytes, plaintext.byteLength));
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad(context, sequence++, part.byteLength));
    output.writeUInt32BE(part.byteLength, position);
    nonce.copy(output, position + 4);
    const ciphertext = cipher.update(part);
    ciphertext.copy(output, position + 16);
    const final = cipher.final();
    if (final.length !== 0) throw new CaptureStorageError("integrity");
    cipher.getAuthTag().copy(output, position + 16 + part.byteLength);
    position += 32 + part.byteLength;
    if (part.byteLength === 0) break;
  }
  return output;
}
export function decryptCaptureBytes(key: Uint8Array, context: Pick<CaptureCipherContext, "role" | "scopeDigest" | "objectId">, ciphertext: Buffer, maxBytes: number): Buffer {
  try {
    if (!ciphertext.subarray(0, magic.length).equals(magic)) throw new CaptureStorageError("integrity");
    const pieces: Buffer[] = [];
    let position = magic.length;
    let total = 0;
    let sequence = 0;
    while (position < ciphertext.length) {
      if (ciphertext.length - position < 32) break;
      const size = ciphertext.readUInt32BE(position);
      if (size > frameBytes || total + size > maxBytes) throw new CaptureStorageError("integrity");
      if (ciphertext.length - position < 32 + size) break;
      const decipher = createDecipheriv("aes-256-gcm", key, ciphertext.subarray(position + 4, position + 16));
      decipher.setAAD(aad(context, sequence++, size));
      decipher.setAuthTag(ciphertext.subarray(position + 16 + size, position + 32 + size));
      const pending = decipher.update(ciphertext.subarray(position + 16, position + 16 + size));
      const final = decipher.final();
      if (final.length !== 0) throw new CaptureStorageError("integrity");
      position += 32 + size;
      if (size === 0) {
        if (position !== ciphertext.length) throw new CaptureStorageError("integrity");
        return Buffer.concat(pieces, total);
      }
      pieces.push(pending);
      total += size;
    }
    throw new CaptureStorageError("integrity");
  } catch (error) {
    if (error instanceof CaptureStorageError) throw error;
    throw new CaptureStorageError("integrity");
  }
}
export async function captureReadEncrypted(directory: string, name: string, maxBytes: number, context: CaptureCipherContext): Promise<Buffer> {
  const ciphertext = await captureReadPrivate(directory, name, captureEncryptedSize(maxBytes));
  return decryptCaptureBytes(await captureEncryptionKey(context.dataDir, context.role, context.scopeDigest), context, ciphertext, maxBytes);
}
export async function captureWriteEncrypted(directory: string, name: string, bytes: Uint8Array, context: CaptureCipherContext): Promise<void> {
  const key = await captureEncryptionKey(context.dataDir, context.role, context.scopeDigest);
  try {
    const existing = await captureReadPrivate(directory, name, captureEncryptedSize(bytes.byteLength));
    if (captureSha256(decryptCaptureBytes(key, context, existing, bytes.byteLength)) !== captureSha256(bytes)) throw new CaptureStorageError("integrity");
    return;
  } catch (error) {
    if (!(error instanceof CaptureStorageError) || error.code !== "storage_unavailable") throw error;
  }
  const encrypted = encryptCaptureBytes(key, context, bytes);
  try { await captureWritePrivate(directory, name, encrypted); }
  catch (error) {
    if (!(error instanceof CaptureStorageError) || error.code !== "integrity") throw error;
    const existing = await captureReadEncrypted(directory, name, bytes.byteLength, context);
    if (captureSha256(existing) !== captureSha256(bytes)) throw error;
  }
}
