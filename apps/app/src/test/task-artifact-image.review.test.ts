import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  artifactImageSchema,
  taskArtifactSchema,
  type TaskArtifactImage,
} from "../../../../plugins/tasks/shared/artifacts";
import {
  IMAGE_FORMATS,
  IMAGE_MIMES,
  STRICT_IMAGE_INPUT,
  sha256,
  staticReviewImage,
  withTaskArtifactReviewFixture,
  type ReviewImageFormat,
  type TaskArtifactReviewFixture,
} from "./task-artifact-review-fixture";

const toolResult = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
  ])),
});

async function decoded(bytes: Buffer) {
  return sharp(bytes, STRICT_IMAGE_INPUT).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

async function originalRemains(f: TaskArtifactReviewFixture, attachmentId: string, original: Buffer) {
  expect((await f.readImage(attachmentId)).equals(original)).toBe(true);
}

async function assertStaticProof(f: TaskArtifactReviewFixture, image: TaskArtifactImage) {
  const bytes = await f.readImage(image.attachmentId);
  const metadata = await sharp(bytes, STRICT_IMAGE_INPUT).metadata();
  expect(metadata.pages ?? 1).toBe(1);
  expect(metadata.orientation ?? 1).toBe(1);
  const pixels = await decoded(bytes);
  expect(pixels.info.width).toBe(image.width);
  expect(pixels.info.height).toBe(image.height);
  expect(sha256(bytes)).toBe(image.sha256);
  return bytes;
}

function headerOnly(format: ReviewImageFormat, valid: Buffer): Buffer {
  if (format === "png") return Buffer.from(valid.subarray(0, 33));
  if (format === "gif") return Buffer.from(valid.subarray(0, 13));
  if (format === "webp") return Buffer.from(valid.subarray(0, 30));
  const scan = valid.indexOf(Buffer.from([0xff, 0xda]));
  if (scan < 0) throw new Error("Synthetic JPEG has no scan marker");
  return Buffer.from(valid.subarray(0, scan + 2));
}

async function corruptFixture(f: TaskArtifactReviewFixture, format: ReviewImageFormat) {
  const valid = await staticReviewImage(format);
  const control = await decoded(valid.bytes);
  expect(control.info.width).toBe(valid.width);
  expect(control.info.height).toBe(valid.height);
  const bytes = headerOnly(format, valid.bytes);
  expect(bytes.byteLength).toBeLessThan(2048);
  await expect(decoded(bytes)).rejects.toThrow();
  const attachmentId = await f.upload(f.workTask.id, { bytes, mime: valid.mime }, `truncated.${format}`);
  const image = f.imageProof(attachmentId, { ...valid, bytes });
  return { image, bytes, attachmentId };
}

describe.each(IMAGE_FORMATS)("decoded screenshot evidence for %s", format => {
  it("binds a readable static control to inspected coordinates and the actual native image", async () => withTaskArtifactReviewFixture(async f => {
    const original = await staticReviewImage(format);
    const attachmentId = await f.upload(f.workTask.id, original, `static.${format}`);
    const image = artifactImageSchema.parse(await f.harness.callRpc("inspectTaskArtifactImage", { ...f.scope, attachmentId }));
    const proofBytes = await assertStaticProof(f, image);
    const saved = taskArtifactSchema.parse(await f.harness.callRpc("createTaskArtifact", f.request(image)));
    const cli = await f.harness.runCli(["artifact", "show", f.workTask.id, saved.id, "--json"], { threadId: "thr_work_reader" });
    expect(cli.exitCode, cli.stderr).toBe(0);
    const result = toolResult.parse(await f.harness.callAgentTool("bb_task_artifact_read", { artifactId: saved.id }, { threadId: "thr_work_reader" }));
    expect(result.isError).not.toBe(true);
    expect(result.content.filter(part => part.type === "image")).toEqual([{ type: "image", data: proofBytes.toString("base64"), mimeType: image.mime }]);
    const cliInspection = await f.harness.runCli(["artifact", "image", f.workTask.id, attachmentId, "--json"], { threadId: "thr_work_reader" });
    expect(cliInspection.exitCode, cliInspection.stderr).toBe(0);
    const cliImage = artifactImageSchema.parse(JSON.parse(cliInspection.stdout));
    await assertStaticProof(f, cliImage);
    const cliCreation = await f.harness.runCli(["artifact", "create", f.workTask.id, "--data", JSON.stringify(f.request(cliImage)), "--json"], { threadId: "thr_work_reader" });
    expect(cliCreation.exitCode, cliCreation.stderr).toBe(0);
    const cliSaved = taskArtifactSchema.parse(JSON.parse(cliCreation.stdout));
    if (!cliSaved.annotation) throw new Error("Valid CLI screenshot annotation was not retained");
    const cliBytes = await assertStaticProof(f, cliSaved.annotation.image);
    expect((await decoded(cliBytes)).data.equals((await decoded(proofBytes)).data)).toBe(true);
    const cliRead = toolResult.parse(await f.harness.callAgentTool("bb_task_artifact_read", { artifactId: cliSaved.id }, { threadId: "thr_work_reader" }));
    expect(cliRead.isError).not.toBe(true);
    expect(cliRead.content.filter(part => part.type === "image")).toEqual([{ type: "image", data: cliBytes.toString("base64"), mimeType: cliSaved.annotation.image.mime }]);
    await originalRemains(f, attachmentId, original.bytes);
  }));

  it("rejects accepted-looking headers without decoded pixels through RPC inspection", async () => withTaskArtifactReviewFixture(async f => {
    const image = await corruptFixture(f, format);
    await expect(f.harness.callRpc("inspectTaskArtifactImage", { ...f.scope, attachmentId: image.attachmentId })).rejects.toThrow();
    expect(taskArtifactSchema.array().parse(await f.harness.callRpc("listTaskArtifacts", f.scope))).toEqual([]);
    await originalRemains(f, image.attachmentId, image.bytes);
  }));

  it("does not persist header-only pixel proof through direct RPC creation", async () => withTaskArtifactReviewFixture(async f => {
    const image = await corruptFixture(f, format);
    await expect(f.harness.callRpc("createTaskArtifact", f.request(image.image))).rejects.toThrow();
    expect(taskArtifactSchema.array().parse(await f.harness.callRpc("listTaskArtifacts", f.scope))).toEqual([]);
  }));

  it("does not turn a corrupt upload into decoded pixel proof through CLI inspection", async () => withTaskArtifactReviewFixture(async f => {
    const image = await corruptFixture(f, format);
    const result = await f.harness.runCli(["artifact", "image", f.workTask.id, image.attachmentId, "--json"], { threadId: "thr_work_reader" });
    expect(result.exitCode).not.toBe(0);
    await originalRemains(f, image.attachmentId, image.bytes);
  }));

  it("refuses raw header-only annotation claims through CLI creation", async () => withTaskArtifactReviewFixture(async f => {
    const image = await corruptFixture(f, format);
    const result = await f.harness.runCli(["artifact", "create", f.workTask.id, "--data", JSON.stringify(f.request(image.image)), "--json"], { threadId: "thr_work_reader" });
    expect(result.exitCode).not.toBe(0);
    expect(taskArtifactSchema.array().parse(await f.harness.callRpc("listTaskArtifacts", f.scope))).toEqual([]);
  }));

  it("withholds corrupt bytes from an agent even for a prior header-only accepted record with a matching file hash", async () => withTaskArtifactReviewFixture(async f => {
    const image = await corruptFixture(f, format);
    const legacy = await f.seedHeaderOnlyHistory(image.image);
    const result = toolResult.parse(await f.harness.callAgentTool("bb_task_artifact_read", { artifactId: legacy.id }, { threadId: "thr_work_reader" }));
    expect(result.isError).toBe(true);
    expect(result.content.filter(part => part.type === "image")).toEqual([]);
    await originalRemains(f, image.attachmentId, image.bytes);
  }));
});

const AMBIGUOUS = [
  { name: "two genuinely different GIF frames", format: "gif", kind: "animated", orientation: 1 },
  { name: "two genuinely different WebP frames", format: "webp", kind: "animated", orientation: 1 },
  { name: "mirrored JPEG with unchanged width and height", format: "jpeg", kind: "oriented", orientation: 2 },
  { name: "mirrored WebP with unchanged width and height", format: "webp", kind: "oriented", orientation: 2 },
  { name: "rotated WebP with swapped decoded dimensions", format: "webp", kind: "oriented", orientation: 6 },
] as const;
type AmbiguousCase = (typeof AMBIGUOUS)[number];

async function ambiguousImage(example: AmbiguousCase) {
  let bytes: Buffer;
  if (example.kind === "animated") {
    const pixels = Buffer.from([255, 0, 0, 0, 0, 255, 0, 255, 0, 255, 255, 0]);
    const input = sharp(pixels, { raw: { width: 2, height: 2, channels: 3, pageHeight: 1 } });
    bytes = example.format === "gif"
      ? await input.gif({ loop: 0, delay: [40, 40] }).toBuffer()
      : await input.webp({ lossless: true, loop: 0, delay: [40, 40] }).toBuffer();
    const metadata = await sharp(bytes, STRICT_IMAGE_INPUT).metadata();
    expect(metadata.pages).toBe(2);
    expect(metadata.pageHeight).toBe(1);
    const pixelsRead = await decoded(bytes);
    const frameBytes = pixelsRead.info.width * pixelsRead.info.channels;
    expect(pixelsRead.data.subarray(0, frameBytes).equals(pixelsRead.data.subarray(frameBytes, frameBytes * 2))).toBe(false);
  } else {
    const input = sharp(Buffer.from([255, 0, 0, 0, 0, 255]), { raw: { width: 2, height: 1, channels: 3 } }).withMetadata({ orientation: example.orientation });
    bytes = example.format === "jpeg" ? await input.jpeg().toBuffer() : await input.webp({ lossless: true }).toBuffer();
    const metadata = await sharp(bytes, STRICT_IMAGE_INPUT).metadata();
    expect(metadata.orientation).toBe(example.orientation);
    const encodedOrder = await decoded(bytes);
    const oriented = await sharp(bytes, STRICT_IMAGE_INPUT).autoOrient().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (example.orientation === 6) expect([oriented.info.width, oriented.info.height]).toEqual([1, 2]);
    else expect(oriented.data.equals(encodedOrder.data)).toBe(false);
  }
  return { bytes, mime: IMAGE_MIMES[example.format], width: 2, height: 1 };
}

describe.each(AMBIGUOUS)("unambiguous coordinate identity: $name", example => {
  it("never reports the original ambiguous file as selected canonical pixels during RPC inspection", async () => withTaskArtifactReviewFixture(async f => {
    const original = await ambiguousImage(example);
    const attachmentId = await f.upload(f.workTask.id, original, `original.${example.format}`);
    const attempt = await f.harness.callRpc("inspectTaskArtifactImage", { ...f.scope, attachmentId }).then(
      value => ({ accepted: true as const, image: artifactImageSchema.parse(value) }),
      () => ({ accepted: false as const }),
    );
    if (attempt.accepted) await assertStaticProof(f, attempt.image);
    expect(taskArtifactSchema.array().parse(await f.harness.callRpc("listTaskArtifacts", f.scope))).toEqual([]);
    await originalRemains(f, attachmentId, original.bytes);
  }));

  it("does not silently choose a frame or orientation after a raw unqualified selection reaches RPC create", async () => withTaskArtifactReviewFixture(async f => {
    const original = await ambiguousImage(example);
    const attachmentId = await f.upload(f.workTask.id, original, `unqualified.${example.format}`);
    await expect(f.harness.callRpc("createTaskArtifact", f.request(f.imageProof(attachmentId, original)))).rejects.toThrow();
    expect(taskArtifactSchema.array().parse(await f.harness.callRpc("listTaskArtifacts", f.scope))).toEqual([]);
    await originalRemains(f, attachmentId, original.bytes);
  }));

  it("only allows CLI inspection to return a genuine static canonical proof, otherwise it explicitly refuses", async () => withTaskArtifactReviewFixture(async f => {
    const original = await ambiguousImage(example);
    const attachmentId = await f.upload(f.workTask.id, original, `cli-original.${example.format}`);
    const result = await f.harness.runCli(["artifact", "image", f.workTask.id, attachmentId, "--json"], { threadId: "thr_work_reader" });
    if (result.exitCode === 0) await assertStaticProof(f, artifactImageSchema.parse(JSON.parse(result.stdout)));
    await originalRemains(f, attachmentId, original.bytes);
  }));

  it("refuses an unqualified animated/oriented selection through CLI create", async () => withTaskArtifactReviewFixture(async f => {
    const original = await ambiguousImage(example);
    const attachmentId = await f.upload(f.workTask.id, original, `cli-selection.${example.format}`);
    const result = await f.harness.runCli(["artifact", "create", f.workTask.id, "--data", JSON.stringify(f.request(f.imageProof(attachmentId, original))), "--json"], { threadId: "thr_work_reader" });
    expect(result.exitCode).not.toBe(0);
    expect(taskArtifactSchema.array().parse(await f.harness.callRpc("listTaskArtifacts", f.scope))).toEqual([]);
    await originalRemains(f, attachmentId, original.bytes);
  }));

  it("does not give an agent arbitrary current-frame pixels for a historical record without selected canonical identity", async () => withTaskArtifactReviewFixture(async f => {
    const original = await ambiguousImage(example);
    const attachmentId = await f.upload(f.workTask.id, original, `historical.${example.format}`);
    const prior = await f.seedHeaderOnlyHistory(f.imageProof(attachmentId, original));
    const result = toolResult.parse(await f.harness.callAgentTool("bb_task_artifact_read", { artifactId: prior.id }, { threadId: "thr_work_reader" }));
    expect(result.isError).toBe(true);
    expect(result.content.filter(part => part.type === "image")).toEqual([]);
    await originalRemains(f, attachmentId, original.bytes);
  }));
});
