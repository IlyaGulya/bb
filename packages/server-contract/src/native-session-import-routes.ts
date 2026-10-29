import { defineRoute, jsonRequest, jsonResponse, queryRequest, binaryResponse, type EmptyInput } from "@bb/hono-typed-routes";
import type { NativeDiscovery, NativeChunk } from "@bb/host-daemon-contract";
import {
  nativeImportDiscoverSchema, nativeImportStartSchema, nativeImportIdSchema,
  nativeImportPageSchema, nativeImportBytesSchema, nativeImportContinueSchema, nativeImportHandoffSchema,
  nativeImportPreviewSchema, nativeImportThreadSchema, nativeImportFileSchema, type NativeImportBatch,
  type NativeImportManifest, type NativeImportPageResponse,
} from "./api/native-session-imports.js";

export const nativeSessionImportRoutes = {
  preview: defineRoute({ path: "/native-session-imports/preview", method: "post", request: jsonRequest<EmptyInput, typeof nativeImportPreviewSchema._output>(nativeImportPreviewSchema), response: jsonResponse<NativeChunk>() }),
  forThread: defineRoute({ path: "/native-session-imports/for-thread", method: "post", request: jsonRequest<EmptyInput, typeof nativeImportThreadSchema._output>(nativeImportThreadSchema), response: jsonResponse<NativeImportManifest | null>() }),
  file: defineRoute({ path: "/native-session-imports/file", method: "get", request: queryRequest<EmptyInput, typeof nativeImportFileSchema._output>(nativeImportFileSchema), response: binaryResponse<Uint8Array>() }),
  discover: defineRoute({ path: "/native-session-imports/discover", method: "post", request: jsonRequest<EmptyInput, typeof nativeImportDiscoverSchema._output>(nativeImportDiscoverSchema), response: jsonResponse<NativeDiscovery>() }),
  start: defineRoute({ path: "/native-session-imports/start", method: "post", request: jsonRequest<EmptyInput, typeof nativeImportStartSchema._output>(nativeImportStartSchema), response: jsonResponse<NativeImportBatch>() }),
  get: defineRoute({ path: "/native-session-imports/get", method: "post", request: jsonRequest<EmptyInput, typeof nativeImportIdSchema._output>(nativeImportIdSchema), response: jsonResponse<NativeImportManifest>() }),
  resume: defineRoute({ path: "/native-session-imports/resume", method: "post", request: jsonRequest<EmptyInput, typeof nativeImportIdSchema._output>(nativeImportIdSchema), response: jsonResponse<NativeImportManifest>() }),
  cancel: defineRoute({ path: "/native-session-imports/cancel", method: "post", request: jsonRequest<EmptyInput, typeof nativeImportIdSchema._output>(nativeImportIdSchema), response: jsonResponse<NativeImportManifest>() }),
  records: defineRoute({ path: "/native-session-imports/records", method: "post", request: jsonRequest<EmptyInput, typeof nativeImportPageSchema._output>(nativeImportPageSchema), response: jsonResponse<NativeImportPageResponse>() }),
  bytes: defineRoute({ path: "/native-session-imports/bytes", method: "post", request: jsonRequest<EmptyInput, typeof nativeImportBytesSchema._output>(nativeImportBytesSchema), response: jsonResponse<{ content: string; sizeBytes: number; offset: number; sha256: string }>() }),
  admit: defineRoute({ path: "/native-session-imports/admit", method: "post", request: jsonRequest<EmptyInput, typeof nativeImportContinueSchema._output>(nativeImportContinueSchema), response: jsonResponse<NativeImportManifest>() }),
  handoff: defineRoute({ path: "/native-session-imports/handoff", method: "post", request: jsonRequest<EmptyInput, typeof nativeImportHandoffSchema._output>(nativeImportHandoffSchema), response: jsonResponse<NativeImportManifest>() }),
};
