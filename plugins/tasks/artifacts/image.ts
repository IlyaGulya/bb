import { createHash } from "node:crypto";
import { artifactImageSchema, type TaskArtifactImage } from "../shared/artifacts.js";

function jpegOrientation(bytes: Buffer, start: number, end: number): number {
  if (bytes.toString("ascii", start, start + 6) !== "Exif\0\0") return 1;
  const tiff = start + 6;
  if (tiff + 8 > end) throw new Error("Invalid JPEG orientation metadata");
  const little = bytes.toString("ascii", tiff, tiff + 2) === "II";
  const short = (offset: number) => little ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
  const long = (offset: number) => little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  if (short(tiff + 2) !== 42) throw new Error("Invalid JPEG orientation metadata");
  const directory = tiff + long(tiff + 4);
  if (directory < tiff || directory + 2 > end) throw new Error("Invalid JPEG orientation metadata");
  const count = short(directory);
  for (let index = 0; index < count; index++) {
    const entry = directory + 2 + index * 12;
    if (entry + 12 > end) throw new Error("Invalid JPEG orientation metadata");
    if (short(entry) !== 0x0112) continue;
    if (short(entry + 2) !== 3 || long(entry + 4) !== 1) throw new Error("Invalid JPEG orientation metadata");
    const orientation = short(entry + 8);
    if (orientation < 1 || orientation > 8) throw new Error("Invalid JPEG orientation metadata");
    return orientation;
  }
  return 1;
}

function dimensions(bytes: Buffer): { width: number; height: number; mime: TaskArtifactImage["mime"] } {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes.readUInt32BE(8) === 13 && bytes.toString("ascii", 12, 16) === "IHDR") {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), mime: "image/png" };
  }
  if (bytes.length >= 13 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8), mime: "image/gif" };
  }
  if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    const chunk = bytes.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3), mime: "image/webp" };
    if (chunk === "VP8 " && bytes.subarray(23, 26).equals(Buffer.from([0x9d, 1, 0x2a]))) {
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff, mime: "image/webp" };
    }
    if (chunk === "VP8L" && bytes[20] === 0x2f) {
      const packed = bytes.readUInt32LE(21);
      return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1, mime: "image/webp" };
    }
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    let width = 0;
    let height = 0;
    let orientation = 1;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === undefined || marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      const end = offset + length;
      if (length < 2 || end > bytes.length) break;
      if (marker === 0xe1) orientation = jpegOrientation(bytes, offset + 2, end);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        height = bytes.readUInt16BE(offset + 3);
        width = bytes.readUInt16BE(offset + 5);
      }
      offset = end;
    }
    if (width && height) return orientation >= 5
      ? { width: height, height: width, mime: "image/jpeg" }
      : { width, height, mime: "image/jpeg" };
  }
  throw new Error("Choose a readable PNG, JPEG, WebP or GIF screenshot");
}

export function inspectArtifactImage(attachmentId: string, bytes: Buffer): TaskArtifactImage {
  const image = artifactImageSchema.parse({
    attachmentId,
    ...dimensions(bytes),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  if (image.width * image.height > 64_000_000) throw new Error("Screenshot exceeds the 64 megapixel limit");
  return image;
}
