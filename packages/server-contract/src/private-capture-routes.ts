import { defineRoute, jsonRequest, jsonResponse, queryRequest, binaryResponse, type EmptyInput } from "@bb/hono-typed-routes";
import type { CaptureScope, CaptureManifest, CaptureChunk, CaptureAck } from "@bb/domain";
import {
  captureCreateSchema, captureListQuerySchema, captureQuerySchema, captureArtifactQuerySchema,
  captureManifestRequestSchema, captureChunkRequestSchema,
  captureLinkRequestSchema, type CaptureLinkRequest,
  capturePreviewQuerySchema, type CapturePreviewQuery, type CapturePreview,
  type CaptureCreate, type CaptureListQuery, type CaptureArtifactQuery, type CaptureView, type CaptureArtifactView,
} from "./api/private-captures.js";

type Id = { param: { captureId: string } };
type Artifact = { param: { captureId: string; artifactId: string } };
export const privateCaptureRoutes = {
  privateCaptures: {
    create: defineRoute({ path: "/private-captures", method: "post", request: jsonRequest<EmptyInput, CaptureCreate>(captureCreateSchema), response: jsonResponse<CaptureView>({ status: 201 }) }),
    list: defineRoute({ path: "/private-captures", method: "get", request: queryRequest<EmptyInput, CaptureListQuery>(captureListQuerySchema), response: jsonResponse<CaptureView[]>() }),
    get: defineRoute({ path: "/private-captures/:captureId", method: "get", request: queryRequest<Id, CaptureScope>(captureQuerySchema), response: jsonResponse<CaptureView>() }),
    stop: defineRoute({ path: "/private-captures/:captureId/stop", method: "post", request: jsonRequest<Id, CaptureScope>(captureQuerySchema), response: jsonResponse<CaptureView>() }),
    sync: defineRoute({ path: "/private-captures/:captureId/sync", method: "post", request: jsonRequest<Id, CaptureScope>(captureQuerySchema), response: jsonResponse<CaptureView>() }),
    link: defineRoute({ path: "/private-captures/:captureId/links", method: "post", request: jsonRequest<Id, CaptureLinkRequest>(captureLinkRequestSchema), response: jsonResponse<CaptureView>() }),
    stageManifest: defineRoute({ path: "/private-captures/:captureId/manifests", method: "post", request: jsonRequest<Id, CaptureScope & { manifest: CaptureManifest }>(captureManifestRequestSchema), response: jsonResponse<CaptureArtifactView>() }),
    putChunk: defineRoute({ path: "/private-captures/:captureId/chunks", method: "post", request: jsonRequest<Id, CaptureScope & { chunk: CaptureChunk }>(captureChunkRequestSchema), response: jsonResponse<CaptureAck>() }),
    artifacts: defineRoute({ path: "/private-captures/:captureId/artifacts", method: "get", request: queryRequest<Id, CaptureArtifactQuery>(captureArtifactQuerySchema), response: jsonResponse<CaptureArtifactView[]>() }),
    artifact: defineRoute({ path: "/private-captures/:captureId/artifacts/:artifactId", method: "get", request: queryRequest<Artifact, CaptureScope>(captureQuerySchema), response: jsonResponse<CaptureArtifactView>() }),
    preview: defineRoute({ path: "/private-captures/:captureId/artifacts/:artifactId/preview", method: "get", request: queryRequest<Artifact, CapturePreviewQuery>(capturePreviewQuerySchema), response: jsonResponse<CapturePreview>() }),
    download: defineRoute({ path: "/private-captures/:captureId/artifacts/:artifactId/download", method: "get", request: queryRequest<Artifact, CaptureScope>(captureQuerySchema), response: binaryResponse<Uint8Array>() }),
  },
};
