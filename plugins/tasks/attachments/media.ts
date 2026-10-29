import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";
import { parseSingleByteRange } from "../../../apps/server/src/services/hosts/file-byte-range.js";
import { isVideoMime } from "../shared/attachments.js";

const MP4_BRANDS = new Set(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "dash"]);

export function videoMimeFromHeader(bytes: Uint8Array): "video/mp4" | "video/webm" | null {
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (header.length >= 24 && header.toString("ascii", 4, 8) === "ftyp" && header.readUInt32BE(0) >= 16 && MP4_BRANDS.has(header.toString("ascii", 8, 12))) return "video/mp4";
  if (header.length >= 16 && header.readUInt32BE(0) === 0x1a45dfa3) {
    for (let index = 4; index + 7 <= header.length; index++) {
      if (header[index] === 0x42 && header[index + 1] === 0x82 && header[index + 2] === 0x84 && header.toString("ascii", index + 3, index + 7) === "webm") return "video/webm";
    }
  }
  return null;
}

async function readHeader(file: FileHandle): Promise<Buffer> {
  const bytes = Buffer.alloc(64);
  const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
  return bytes.subarray(0, bytesRead);
}

async function hasMp4Video(file: FileHandle, size: number): Promise<boolean> {
  let media = false;
  let video = false;
  async function boxes(start: number, end: number, depth: number): Promise<boolean> {
    if (depth > 4) return false;
    const header = Buffer.alloc(16);
    for (let offset = start; offset < end;) {
      if (end - offset < 8) return false;
      const { bytesRead } = await file.read(header, 0, Math.min(16, end - offset), offset);
      if (bytesRead < 8) return false;
      const smallSize = header.readUInt32BE(0);
      const headerSize = smallSize === 1 ? 16 : 8;
      if (bytesRead < headerSize) return false;
      const largeSize = smallSize === 1 ? header.readBigUInt64BE(8) : BigInt(smallSize || end - offset);
      if (largeSize < BigInt(headerSize) || largeSize > BigInt(end - offset)) return false;
      const boxSize = Number(largeSize);
      const kind = header.toString("ascii", 4, 8);
      if (kind === "mdat" && boxSize > headerSize) media = true;
      if (kind === "hdlr" && depth === 3 && boxSize >= headerSize + 12) {
        const handler = Buffer.alloc(12);
        if ((await file.read(handler, 0, 12, offset + headerSize)).bytesRead !== 12) return false;
        if (handler.toString("ascii", 8, 12) === "vide") video = true;
      }
      if ((kind === "moov" || kind === "trak" || kind === "mdia") && !await boxes(offset + headerSize, offset + boxSize, depth + 1)) return false;
      offset += boxSize;
    }
    return true;
  }
  return await boxes(0, size, 0) && media && video;
}

async function hasWebmVideo(file: FileHandle, size: number): Promise<boolean> {
  let video = false;
  let media = false;
  async function elements(start: number, end: number, parent: number, depth: number): Promise<boolean> {
    if (depth > 4) return false;
    const header = Buffer.alloc(16);
    let context = parent;
    for (let offset = start; offset < end;) {
      const { bytesRead } = await file.read(header, 0, Math.min(16, end - offset), offset);
      const first = header[0] ?? 0;
      const idLength = first >= 0x80 ? 1 : first >= 0x40 ? 2 : first >= 0x20 ? 3 : first >= 0x10 ? 4 : 0;
      if (!idLength || bytesRead <= idLength) return false;
      let sizeLength = 1;
      while (sizeLength <= 8 && !(header[idLength]! & (0x80 >> (sizeLength - 1)))) sizeLength++;
      if (sizeLength > 8 || bytesRead < idLength + sizeLength) return false;
      const id = header.readUIntBE(0, idLength);
      let length = BigInt(header[idLength]! & (0xff >> sizeLength));
      for (let index = 1; index < sizeLength; index++) length = (length << 8n) | BigInt(header[idLength + index]!);
      const payload = offset + idLength + sizeLength;
      const unknown = length === (1n << BigInt(7 * sizeLength)) - 1n;
      if (unknown && id !== 0x18538067 && id !== 0x1f43b675) return false;
      if (unknown) { context = id; offset = payload; continue; }
      if (length > BigInt(end - payload)) return false;
      const next = payload + Number(length);
      if (id === 0x83 && context === 0xae && length === 1n) {
        const type = Buffer.alloc(1);
        if ((await file.read(type, 0, 1, payload)).bytesRead !== 1) return false;
        if (type[0] === 1) video = true;
      }
      if ((id === 0xa3 && context === 0x1f43b675 || id === 0xa1 && context === 0xa0) && length > 4n) media = true;
      if ((id === 0x18538067 || id === 0x1654ae6b || id === 0xae || id === 0x1f43b675 || id === 0xa0) && !await elements(payload, next, id, depth + 1)) return false;
      offset = next;
    }
    return true;
  }
  return await elements(0, size, 0, 0) && video && media;
}

export async function verifyVideoFile(path: string, mime: string, expectedSize: number): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size !== expectedSize || !isVideoMime(mime) || videoMimeFromHeader(await readHeader(file)) !== mime)
      throw new Error("Video artifact is empty, unavailable, changed, or has an unsupported container");
    if (!await (mime === "video/mp4" ? hasMp4Video(file, info.size) : hasWebmVideo(file, info.size)))
      throw new Error("Video artifact is truncated or has no recorded media track");
  } finally { await file.close(); }
}

function mediaError(request: Request, status: 404 | 415, error: string): Response {
  const body = JSON.stringify({ error });
  return new Response(request.method === "HEAD" ? null : body, { status, headers: {
    "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
  } });
}

export async function attachmentMediaResponse(request: Request, path: string, mime: string, headers: Headers, validateVideo: boolean): Promise<Response> {
  let file: FileHandle;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if (error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR", "ELOOP"].includes(String(error.code)))
      return mediaError(request, 404, "attachment not found");
    throw error;
  }
  let streaming = false;
  try {
    const info = await file.stat();
    if (!info.isFile()) return mediaError(request, 404, "attachment not found");
    if (validateVideo && isVideoMime(mime) && videoMimeFromHeader(await readHeader(file)) !== mime)
      return mediaError(request, 415, "Video container is corrupt or unsupported; download the original to inspect it");
    headers.set("Accept-Ranges", "bytes");
    headers.set("Content-Length", String(info.size));
    headers.set("Cache-Control", "private, no-store");
    if (request.method === "HEAD") return new Response(null, { headers });
    const rangeHeader = request.headers.get("range");
    const range = rangeHeader && !request.headers.has("if-range") ? parseSingleByteRange(rangeHeader, info.size) : undefined;
    if (range === "unsatisfiable") {
      headers.set("Content-Range", `bytes */${info.size}`);
      headers.set("Content-Length", "0");
      return new Response(null, { status: 416, headers });
    }
    if (range) {
      headers.set("Content-Range", `bytes ${range.start}-${range.end}/${info.size}`);
      headers.set("Content-Length", String(range.end - range.start + 1));
    }
    if (info.size === 0) return new Response(null, { headers });
    const stream = file.createReadStream({ start: range?.start ?? 0, end: range?.end ?? info.size - 1, autoClose: true });
    const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
    const response = new Response(body, { status: range ? 206 : 200, headers });
    streaming = true;
    return response;
  } finally {
    if (!streaming) await file.close();
  }
}
