import { createHash } from "node:crypto";
import sharp from "sharp";
import { MAX_ATTACHMENT_SIZE_BYTES } from "../shared/attachments.js";
import { artifactImageSchema, type TaskArtifactImage } from "../shared/artifacts.js";

const MIME_BY_FORMAT = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
} as const;

function hasPngAnimation(bytes: Buffer): boolean {
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) throw new Error("Choose a readable PNG screenshot");
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "acTL") return true;
    if (type === "IEND") return false;
    offset += length + 12;
  }
  return false;
}

export async function inspectArtifactImage(attachmentId: string, bytes: Buffer): Promise<TaskArtifactImage> {
  if (bytes.byteLength > MAX_ATTACHMENT_SIZE_BYTES) throw new Error("Screenshot exceeds the 25 MB limit");
  const decoder = sharp(bytes, { failOn: "warning", limitInputPixels: 64_000_000, animated: true }).timeout({ seconds: 10 });
  try {
    const metadata = await decoder.metadata();
    const format = metadata.format;
    if (format !== "png" && format !== "jpeg" && format !== "webp" && format !== "gif") {
      throw new Error("Choose a readable PNG, JPEG, WebP or GIF screenshot");
    }
    if ((metadata.pages ?? 1) !== 1 || (metadata.delay?.length ?? 0) > 1 || format === "png" && hasPngAnimation(bytes)) {
      throw new Error("Choose a static screenshot; animated images have no single coordinate frame");
    }
    if ((metadata.orientation ?? 1) !== 1) {
      throw new Error("Export a screenshot with its orientation applied before annotating it");
    }
    const image = artifactImageSchema.parse({
      attachmentId,
      width: metadata.width,
      height: metadata.height,
      mime: MIME_BY_FORMAT[format],
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    if (image.width * image.height > 64_000_000) throw new Error("Screenshot exceeds the 64 megapixel limit");
    const { info } = await decoder.raw().toBuffer({ resolveWithObject: true });
    if (info.width !== image.width || info.height !== image.height) throw new Error("Decoded screenshot dimensions are inconsistent");
    return image;
  } finally {
    decoder.destroy();
  }
}
