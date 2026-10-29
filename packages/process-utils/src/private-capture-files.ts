import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, rename, rm, statfs, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";

export class CaptureStorageError extends Error {
  constructor(readonly code: "storage_unavailable" | "disk_pressure" | "integrity" | "source_limit" | "source_changed") {
    super(code);
  }
}
export function captureSha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}
export function captureObjectDigest(value: object): string {
  return captureSha256(JSON.stringify(canonical(value)));
}
function segment(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value) || value === "." || value === "..") throw new CaptureStorageError("integrity");
  return value;
}
export async function capturePrivateDirectory(dataDir: string, ...parts: string[]): Promise<string> {
  try {
    if (process.platform !== "linux" && process.platform !== "darwin") throw new CaptureStorageError("storage_unavailable");
    let path = await realpath(resolve(dataDir));
    for (const part of ["private-capture", ...parts]) {
      path = join(path, segment(part));
      await mkdir(path, { mode: 0o700 }).catch(error => { if (!hasCode(error, "EEXIST")) throw error; });
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
          (process.getuid !== undefined && stat.uid !== process.getuid()) || await realpath(path) !== path) throw new CaptureStorageError("integrity");
    }
    return path;
  } catch (error) {
    if (error instanceof CaptureStorageError) throw error;
    throw new CaptureStorageError("storage_unavailable");
  }
}
function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
export async function captureDiskHeadroom(directory: string, bytes: number): Promise<void> {
  try {
    const space = await statfs(directory);
    if (space.bavail * space.bsize < bytes + 64 * 1024 * 1024) throw new CaptureStorageError("disk_pressure");
  } catch (error) {
    if (error instanceof CaptureStorageError) throw error;
    throw new CaptureStorageError("storage_unavailable");
  }
}
export async function captureSyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function recoverPrivatePublication(directory: string, handle: FileHandle, before: Stats): Promise<void> {
  if (!before.isFile() || before.nlink !== 2 || (before.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && before.uid !== process.getuid())) throw new CaptureStorageError("integrity");
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && root.uid !== process.getuid()) || await realpath(directory) !== resolve(directory)) throw new CaptureStorageError("integrity");
  let pending: string | null = null;
  let entries = 0;
  for await (const entry of await opendir(directory)) {
    if (++entries > 1024) throw new CaptureStorageError("source_limit");
    if (!entry.isFile() || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.pending$/u.test(entry.name)) continue;
    const path = join(directory, entry.name);
    const candidate = await lstat(path).catch(error => { if (hasCode(error, "ENOENT")) return null; throw error; });
    if (!candidate || candidate.dev !== before.dev || candidate.ino !== before.ino) continue;
    if (!candidate.isFile() || candidate.nlink !== 2 || (candidate.mode & 0o077) !== 0 || candidate.uid !== before.uid || pending !== null) throw new CaptureStorageError("integrity");
    pending = path;
  }
  if (pending === null) return;
  const current = await handle.stat();
  if (current.nlink === 1) return;
  if (current.nlink !== 2 || current.dev !== before.dev || current.ino !== before.ino) throw new CaptureStorageError("integrity");
  await rm(pending, { force: true });
  await captureSyncDirectory(directory);
}
export async function captureReadPrivate(directory: string, name: string, maxBytes: number): Promise<Buffer> {
  let handle;
  try {
    handle = await open(join(directory, segment(name)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let stat = await handle.stat();
    if (stat.nlink === 2) { await recoverPrivatePublication(directory, handle, stat); stat = await handle.stat(); }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes || (stat.mode & 0o077) !== 0 ||
        (process.getuid !== undefined && stat.uid !== process.getuid())) throw new CaptureStorageError("integrity");
    const bytes = Buffer.allocUnsafe(stat.size);
    for (let offset = 0; offset < bytes.length;) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new CaptureStorageError("integrity");
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.nlink !== 1 || bytes.length !== stat.size || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new CaptureStorageError("integrity");
    return bytes;
  } catch (error) {
    if (error instanceof CaptureStorageError) throw error;
    throw new CaptureStorageError("storage_unavailable");
  } finally { await handle?.close(); }
}
export async function captureWritePrivate(directory: string, name: string, bytes: Uint8Array, replace = false): Promise<void> {
  const target = join(directory, segment(name));
  let temporary: string | null = null;
  try {
    await captureDiskHeadroom(directory, bytes.byteLength);
    if (!replace) {
      try {
        const existing = await captureReadPrivate(directory, name, bytes.byteLength);
        if (captureSha256(existing) !== captureSha256(bytes)) throw new CaptureStorageError("integrity");
        return;
      } catch (error) {
        if (error instanceof CaptureStorageError && error.code !== "storage_unavailable") throw error;
      }
    }
    temporary = join(directory, `${randomUUID()}.pending`);
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    if (replace) {
      await rename(temporary, target);
    } else {
      const { link } = await import("node:fs/promises");
      try { await link(temporary, target); }
      catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        const existing = await captureReadPrivate(directory, name, bytes.byteLength);
        if (captureSha256(existing) !== captureSha256(bytes)) throw new CaptureStorageError("integrity");
      }
      await rm(temporary, { force: true });
    }
    temporary = null;
    await captureSyncDirectory(directory);
  } catch (error) {
    if (error instanceof CaptureStorageError) throw error;
    throw new CaptureStorageError("storage_unavailable");
  } finally { if (temporary !== null) await rm(temporary, { force: true }).catch(() => {}); }
}
export function captureDecodeBase64(value: string, maxBytes: number): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length > maxBytes || bytes.toString("base64") !== value) throw new CaptureStorageError("integrity");
  return bytes;
}

export function capturePreparePayload(source: Uint8Array, value: { bytes: Uint8Array; redacted: boolean }, chunkBytes: number) {
  const prepared = { bytes: Buffer.from(value.bytes.buffer, value.bytes.byteOffset, value.bytes.byteLength), redacted: value.redacted };
  const chunks = [];
  for (let offset = 0; offset < prepared.bytes.length; offset += chunkBytes) {
    const bytes = prepared.bytes.subarray(offset, offset + chunkBytes);
    chunks.push({ sequence: chunks.length, bytes: bytes.length, sha256: captureSha256(bytes) });
  }
  return {
    bytes: prepared.bytes,
    fields: {
      sourceBytes: source.byteLength,
      sourceSha256: captureSha256(source),
      storedBytes: prepared.bytes.length,
      storedSha256: captureSha256(prepared.bytes),
      redacted: prepared.redacted,
      chunks,
    },
  };
}
