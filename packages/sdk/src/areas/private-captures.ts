import {
  CAPTURE_CHUNK_BYTES, CAPTURE_MAX_ARTIFACT_BYTES, captureAckSchema, captureManifestSchema,
  redactCapturePayload, type CaptureScope, type CaptureManifest, type CaptureChunk, type CaptureAck,
  captureReportedModels,
} from "@bb/domain";
import {
  PRODUCT_ANALYTICS_HEADERS, captureCreateSchema, captureViewSchema, captureArtifactViewSchema,
  capturePreviewSchema, type CapturePreview, type CaptureCreate, type CaptureListQuery,
  type CaptureArtifactQuery, type CaptureView, type CaptureArtifactView,
  type CaptureLinkRequest,
} from "@bb/server-contract";
import {
  experimental_productAnalyticsRequestInit,
  type ExperimentalProductAnalyticsContext,
} from "../product-analytics.js";
import type { CreateSdkAreaArgs } from "./common.js";

export type { CaptureCreate, CaptureLinkRequest, CaptureView, CaptureArtifactView, CaptureListQuery, CaptureArtifactQuery, CapturePreview } from "@bb/server-contract";
export type { CaptureScope, CaptureSession, CapturePolicy, CaptureManifest, CaptureChunk, CaptureAck, CaptureProcessPolicy, CaptureProcessStatus, CaptureProcessEvidence } from "@bb/domain";
type Provenance = { analytics?: ExperimentalProductAnalyticsContext; signal?: AbortSignal };
export interface CaptureIdArgs extends CaptureScope, Provenance { captureId: string }
export interface CaptureArtifactArgs extends CaptureIdArgs { artifactId: string }
export interface CaptureImportArgs extends CaptureIdArgs {
  operationId: string;
  sourceId: string;
  file: Blob;
  representation: "raw" | "transcript" | "binary";
  streamState: CaptureManifest["streamState"];
  binaryReview: "owner-reviewed-no-auth-material";
}
export interface ExperimentalPrivateCapturesArea {
  create(input: CaptureCreate & Provenance): Promise<CaptureView>;
  list(input: CaptureListQuery & Provenance): Promise<CaptureView[]>;
  get(input: CaptureIdArgs): Promise<CaptureView>;
  stop(input: CaptureIdArgs): Promise<CaptureView>;
  sync(input: CaptureIdArgs): Promise<CaptureView>;
  link(input: CaptureIdArgs & CaptureLinkRequest & { operationId: string }): Promise<CaptureView>;
  artifacts(input: CaptureIdArgs & CaptureArtifactQuery): Promise<CaptureArtifactView[]>;
  artifact(input: CaptureArtifactArgs): Promise<CaptureArtifactView>;
  preview(input: CaptureArtifactArgs & { previewBytes: number }): Promise<CapturePreview>;
  stageManifest(input: CaptureIdArgs & { manifest: CaptureManifest; operationId?: string }): Promise<CaptureArtifactView>;
  putChunk(input: CaptureIdArgs & { chunk: CaptureChunk }): Promise<CaptureAck>;
  upload(input: CaptureImportArgs): Promise<CaptureArtifactView>;
  download(input: CaptureArtifactArgs): Promise<Blob>;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}
async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function identity(value: object): Promise<string> { return digest(new TextEncoder().encode(JSON.stringify(canonical(value)))); }
function encodeBase64(bytes: Uint8Array): string {
  let value = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) value += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(value);
}
function scope(input: CaptureScope): CaptureScope { return { projectId: input.projectId, executionContextId: input.executionContextId }; }
function request(input: Provenance & CaptureScope, overrides: { intentional?: boolean; operationId?: string } = {}) {
  const headers = new Headers();
  if (overrides.intentional !== undefined) headers.set(PRODUCT_ANALYTICS_HEADERS.intent, overrides.intentional ? "use" : "observe");
  if (overrides.operationId !== undefined) headers.set(PRODUCT_ANALYTICS_HEADERS.operation, captureCreateSchema.shape.id.parse(overrides.operationId));
  const init = { signal: input.signal, headers };
  return { init: input.analytics === undefined ? init : experimental_productAnalyticsRequestInit({ ...input.analytics, projectId: input.projectId, ...overrides }, init) };
}
export function createPrivateCapturesArea({ transport }: CreateSdkAreaArgs): ExperimentalPrivateCapturesArea {
  const api = transport.api.v1["private-captures"];
  const readArtifact = async (input: CaptureArtifactArgs, observe = false): Promise<CaptureArtifactView> => captureArtifactViewSchema.parse(await transport.readJson(
    api[":captureId"].artifacts[":artifactId"].$get({ param: { captureId: input.captureId, artifactId: input.artifactId }, query: scope(input) }, request(input, observe ? { intentional: false } : {})),
  ));
  const area: ExperimentalPrivateCapturesArea = {
    async create(input) {
      const { analytics, signal, ...json } = input;
      return captureViewSchema.parse(await transport.readJson(api.$post({ json: captureCreateSchema.parse(json) }, request(input, { operationId: input.id, intentional: true }))));
    },
    async list(input) {
      const { signal, analytics, ...query } = input;
      return captureViewSchema.array().parse(await transport.readJson(api.$get({ query }, request(input))));
    },
    async get(input) {
      return captureViewSchema.parse(await transport.readJson(api[":captureId"].$get({ param: { captureId: input.captureId }, query: scope(input) }, request(input))));
    },
    async stop(input) {
      return captureViewSchema.parse(await transport.readJson(api[":captureId"].stop.$post({ param: { captureId: input.captureId }, json: scope(input) }, request(input, { operationId: input.captureId, intentional: true }))));
    },
    async sync(input) {
      return captureViewSchema.parse(await transport.readJson(api[":captureId"].sync.$post({ param: { captureId: input.captureId }, json: scope(input) }, request(input))));
    },
    async link(input) {
      return captureViewSchema.parse(await transport.readJson(api[":captureId"].links.$post({ param: { captureId: input.captureId }, json: { ...scope(input), threadId: input.threadId, runId: input.runId } }, request(input, { operationId: input.operationId, intentional: true }))));
    },
    async artifacts(input) {
      const { captureId, signal, analytics, ...query } = input;
      return captureArtifactViewSchema.array().parse(await transport.readJson(api[":captureId"].artifacts.$get({ param: { captureId }, query }, request(input))));
    },
    artifact: input => readArtifact(input),
    async preview(input) {
      return capturePreviewSchema.parse(await transport.readJson(api[":captureId"].artifacts[":artifactId"].preview.$get({ param: { captureId: input.captureId, artifactId: input.artifactId }, query: { ...scope(input), previewBytes: input.previewBytes } }, request(input))));
    },
    async stageManifest(input) {
      return captureArtifactViewSchema.parse(await transport.readJson(api[":captureId"].manifests.$post({ param: { captureId: input.captureId }, json: { ...scope(input), manifest: input.manifest } }, request(input, { intentional: input.operationId !== undefined, ...(input.operationId === undefined ? {} : { operationId: input.operationId }) }))));
    },
    async putChunk(input) {
      return captureAckSchema.parse(await transport.readJson(api[":captureId"].chunks.$post({ param: { captureId: input.captureId }, json: { ...scope(input), chunk: input.chunk } }, request(input, { intentional: false }))));
    },
    async upload(input) {
      captureCreateSchema.shape.id.parse(input.operationId);
      if (input.file.size < 1 || input.file.size > CAPTURE_MAX_ARTIFACT_BYTES || input.binaryReview !== "owner-reviewed-no-auth-material") throw new Error("capture_source_limit_or_review_missing");
      const original = new Uint8Array(await input.file.arrayBuffer());
      const transformed = input.representation === "binary" ? { bytes: original, redacted: false } : redactCapturePayload(original);
      const prepared = transformed.bytes;
      const chunks = [];
      for (let offset = 0; offset < prepared.length; offset += CAPTURE_CHUNK_BYTES) {
        const bytes = prepared.subarray(offset, offset + CAPTURE_CHUNK_BYTES);
        chunks.push({ sequence: chunks.length, bytes: bytes.length, sha256: await digest(bytes) });
      }
      const fields = {
        version: 1 as const, captureId: input.captureId, source: "owner-import" as const, sourceId: input.sourceId,
        hostId: null, runId: null, nativeSessionId: null, ...(input.representation === "binary" ? { models: [], indexLimited: false } : captureReportedModels(prepared)),
        destinations: [], transport: "file" as const, requestId: null, observedAt: null, sourceOffset: 0,
        sourceBytes: original.length, sourceSha256: await digest(original), storedBytes: prepared.length,
        storedSha256: await digest(prepared), representation: input.representation, streamState: input.streamState,
        fidelity: transformed.redacted ? "redacted-source" as const : "source-bytes" as const,
        redactionPolicy: input.representation === "binary" ? "owner-reviewed-binary-v1" as const : "headers-json-credentials-v1" as const,
        redacted: transformed.redacted, payloadSecrets: "not-guaranteed" as const, chunks,
      };
      const manifest = captureManifestSchema.parse({ ...fields, artifactId: await identity(fields) });
      const initial = await area.stageManifest({ ...input, manifest });
      if (initial.rejectedAt !== null) throw new Error("capture_privacy_rejected");
      const committed = new Set(initial.committedSequences);
      for (const chunk of chunks) {
        if (input.signal?.aborted) throw new Error("capture_cancelled");
        if (committed.has(chunk.sequence) && (initial.completedAt !== null || chunk.sequence !== chunks.length - 1)) continue;
        const value = { captureId: input.captureId, artifactId: manifest.artifactId, sequence: chunk.sequence, sha256: chunk.sha256 };
        const receipt = await area.putChunk({ ...input, chunk: { ...value, base64: encodeBase64(prepared.subarray(chunk.sequence * CAPTURE_CHUNK_BYTES, chunk.sequence * CAPTURE_CHUNK_BYTES + chunk.bytes)) } });
        if (receipt.captureId !== value.captureId || receipt.artifactId !== value.artifactId || receipt.sequence !== value.sequence || receipt.sha256 !== value.sha256 || receipt.receiptId !== await identity(value)) throw new Error("capture_ack_mismatch");
      }
      return readArtifact({ ...input, artifactId: manifest.artifactId }, true);
    },
    async download(input) {
      const artifact = await readArtifact(input, true);
      if (artifact.completedAt === null) throw new Error("capture_artifact_incomplete");
      const response = await transport.resolve(api[":captureId"].artifacts[":artifactId"].download.$get({ param: { captureId: input.captureId, artifactId: input.artifactId }, query: scope(input) }, request(input)));
      const file = await response.blob();
      if (file.size !== artifact.manifest.storedBytes || await digest(new Uint8Array(await file.arrayBuffer())) !== artifact.manifest.storedSha256) throw new Error("capture_download_integrity");
      return file;
    },
  };
  return area;
}
