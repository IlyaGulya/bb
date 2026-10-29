import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  opendir,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { Readable } from "node:stream";
import type { Stats } from "node:fs";
import type {
  GatewayLogEntry,
  GatewayLogList,
  GatewayLogPreview,
  GatewayLogManifest,
} from "@bb/server-contract";
import { ApiError } from "../errors.js";

const MAX_DIRECTORY_ENTRIES = 2048;
const MAX_HEADER_BYTES = 65536;
const SETTLE_MS = 2000;
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,239}\.log$/u;

function unavailable(): ApiError {
  return new ApiError(
    503,
    "gateway_logs_unavailable",
    "CPA request logs are unavailable. Check server log configuration and the read-only log mount.",
  );
}

function notFound(): ApiError {
  return new ApiError(
    404,
    "gateway_log_not_found",
    "CPA request log is unavailable for this thread.",
  );
}

function notReady(): ApiError {
  return new ApiError(
    409,
    "gateway_logs_not_ready",
    "No readable finalized CPA logs are available. Request logging may be off, requests may still be streaming, or log files may still be settling. Refresh after the request finishes.",
  );
}

function sameFile(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

function idForFilename(filename: string): string {
  return Buffer.from(filename, "utf8").toString("base64url");
}

function filenameForId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,326}$/u.test(id)) throw notFound();
  const filename = Buffer.from(id, "base64url").toString("utf8");
  if (!SAFE_FILENAME.test(filename) || idForFilename(filename) !== id)
    throw notFound();
  return filename;
}

function inboundThreadId(prefix: string): string | null {
  const lines = prefix.split("\n");
  if (lines[0]?.replace(/\r$/u, "") !== "=== REQUEST INFO ===") return null;
  let index = 1;
  for (; index < lines.length; index += 1) {
    const line = lines[index]!.replace(/\r$/u, "");
    if (line === "=== HEADERS ===") break;
    if (line.startsWith("=== ")) return null;
    if (
      line !== "" &&
      !/^(Version|URL|Method|Downstream Transport|Upstream Transport|Timestamp): /u.test(
        line,
      )
    )
      return null;
  }
  if (index === lines.length) return null;
  let threadId: string | null = null;
  for (index += 1; index < lines.length - 1; index += 1) {
    const line = lines[index]!.replace(/\r$/u, "");
    if (line === "") return threadId;
    const header = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.*)$/u.exec(line);
    if (!header) return null;
    if (header[1]!.toLowerCase() === "x-bb-thread-id") {
      if (threadId !== null) return null;
      threadId = header[2]!.trim();
    }
  }
  return null;
}

async function openRoot(
  configuredRoot: string | undefined,
): Promise<FileHandle> {
  if (!configuredRoot || !isAbsolute(configuredRoot)) throw unavailable();
  if (process.platform !== "linux") {
    throw new ApiError(
      503,
      "gateway_logs_unsupported",
      "CPA request log access requires the Linux read-only server log mount.",
    );
  }
  let handle: FileHandle | undefined;
  try {
    const root = resolve(configuredRoot);
    if ((await realpath(root)) !== root || !(await lstat(root)).isDirectory())
      throw unavailable();
    handle = await open(
      root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    if ((await realpath(`/proc/self/fd/${handle.fd}`)) !== root)
      throw unavailable();
    return handle;
  } catch {
    await handle?.close();
    throw unavailable();
  }
}

async function openLog(
  root: FileHandle,
  filename: string,
): Promise<FileHandle> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      `/proc/self/fd/${root.fd}/${filename}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw notFound();
    return handle;
  } catch {
    await handle?.close();
    throw notFound();
  }
}

async function inspectLog(
  handle: FileHandle,
  threadId: string,
): Promise<Stats | null> {
  const before = await handle.stat();
  const prefix = Buffer.alloc(Math.min(before.size, MAX_HEADER_BYTES));
  const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
  if (inboundThreadId(prefix.toString("utf8", 0, bytesRead)) !== threadId)
    return null;
  if (
    Date.now() - before.mtimeMs < SETTLE_MS ||
    before.size === 0 ||
    !sameFile(before, await handle.stat())
  )
    throw notReady();
  return before;
}

export async function listGatewayLogs(
  configuredRoot: string | undefined,
  threadId: string,
): Promise<GatewayLogList> {
  const root = await openRoot(configuredRoot);
  const entries: GatewayLogEntry[] = [];
  let scanTruncated = false;
  let unavailableFiles = 0;
  try {
    const directory = await opendir(`/proc/self/fd/${root.fd}`);
    let scanned = 0;
    for await (const entry of directory) {
      scanned += 1;
      if (scanned > MAX_DIRECTORY_ENTRIES) {
        scanTruncated = true;
        break;
      }
      if (!entry.isFile() || !SAFE_FILENAME.test(entry.name)) continue;
      let handle: FileHandle | undefined;
      try {
        handle = await openLog(root, entry.name);
        const stat = await inspectLog(handle, threadId);
        if (stat)
          entries.push({
            id: idForFilename(entry.name),
            createdAt: stat.birthtime.toISOString(),
            sizeBytes: stat.size,
          });
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.body.code === "gateway_logs_not_ready"
        )
          unavailableFiles += 1;
        else if (!(error instanceof ApiError)) throw unavailable();
      } finally {
        await handle?.close();
      }
    }
    if (entries.length === 0 && scanTruncated) {
      throw new ApiError(
        503,
        "gateway_logs_scan_limit",
        "The bounded CPA log scan did not find a readable log for this thread. The directory scan limit was reached; retained files may contain additional logs.",
      );
    }
    if (entries.length === 0) throw notReady();
    entries.sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
    );
    return { entries, scanTruncated, unavailableFiles };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw unavailable();
  } finally {
    await root.close();
  }
}

async function ownedLog(
  configuredRoot: string | undefined,
  threadId: string,
  logId: string,
): Promise<{ handle: FileHandle; stat: Stats }> {
  const filename = filenameForId(logId);
  const root = await openRoot(configuredRoot);
  let handle: FileHandle | undefined;
  try {
    handle = await openLog(root, filename);
    const stat = await inspectLog(handle, threadId);
    if (!stat) throw notFound();
    return { handle, stat };
  } catch (error) {
    await handle?.close();
    if (error instanceof ApiError) throw error;
    throw unavailable();
  } finally {
    await root.close();
  }
}

export async function captureGatewayLogSource(
  configuredRoot: string | undefined,
  threadId: string,
  logId: string,
  knownStamps: ReadonlySet<string>,
  maxBytes: number,
): Promise<{ sourceId: string; stamp: string; bytes: Buffer } | null> {
  const { handle, stat } = await ownedLog(configuredRoot, threadId, logId);
  try {
    const stamp = createHash("sha256").update(JSON.stringify([logId, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs])).digest("hex");
    const sourceId = `cpa:${logId}`;
    if (knownStamps.has(`${sourceId}:${stamp}`)) return null;
    if (stat.size > maxBytes) throw new ApiError(413, "capture_source_limit", "Private capture source exceeds its artifact limit.");
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size || !sameFile(stat, await handle.stat())) throw notReady();
    return { sourceId, stamp, bytes };
  } finally {
    await handle.close();
  }
}

export async function readGatewayLog(
  configuredRoot: string | undefined,
  threadId: string,
  logId: string,
  previewBytes: number,
): Promise<GatewayLogPreview> {
  if (
    !Number.isSafeInteger(previewBytes) ||
    previewBytes < 1 ||
    previewBytes > 262144
  ) {
    throw new ApiError(
      400,
      "invalid_request",
      "Preview size must be between 1 and 262144 bytes.",
    );
  }
  const { handle, stat } = await ownedLog(configuredRoot, threadId, logId);
  try {
    const preview = Buffer.alloc(Math.min(stat.size, previewBytes));
    const { bytesRead } = await handle.read(preview, 0, preview.length, 0);
    if (!sameFile(stat, await handle.stat()) || bytesRead !== preview.length)
      throw notReady();
    return {
      id: logId,
      raw: preview.toString("utf8", 0, bytesRead),
      truncated: bytesRead < stat.size,
      sizeBytes: stat.size,
      previewBytes: bytesRead,
    };
  } finally {
    await handle.close();
  }
}

export async function gatewayLogManifest(
  configuredRoot: string | undefined,
  threadId: string,
  logId: string,
): Promise<GatewayLogManifest> {
  const { handle, stat } = await ownedLog(configuredRoot, threadId, logId);
  try {
    const hash = createHash("sha256");
    let bytes = 0;
    const buffer = Buffer.alloc(65536);
    while (bytes < stat.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - bytes), bytes);
      if (bytesRead === 0) throw notReady();
      hash.update(buffer.subarray(0, bytesRead));
      bytes += bytesRead;
    }
    if (!sameFile(stat, await handle.stat())) throw notReady();
    return {
      id: logId,
      threadId,
      source: "cpa-request-log",
      representation: "raw",
      sizeBytes: bytes,
      sha256: hash.digest("hex"),
      integrity: "retained-file-only",
      completeness: "unverified",
      redaction: "unverified",
      deliveryAck: null,
    };
  } finally {
    await handle.close();
  }
}

export async function downloadGatewayLog(
  configuredRoot: string | undefined,
  threadId: string,
  logId: string,
): Promise<Response> {
  const { handle, stat } = await ownedLog(configuredRoot, threadId, logId);
  const stream = handle.createReadStream({
    start: 0,
    end: stat.size - 1,
    autoClose: true,
  });
  const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": 'attachment; filename="cpa-request.log"',
      "content-length": String(stat.size),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
