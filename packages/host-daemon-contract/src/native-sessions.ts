import { z } from "zod";

export const NATIVE_SESSION_CHUNK_BYTES = 256 * 1024;
export const nativeEngineSchema = z.enum(["omp", "claude", "codex"]);
export const nativeSessionRootSchema = z.object({
  engine: nativeEngineSchema,
  path: z.string().min(1).max(16_384),
  profile: z.string().min(1).max(256),
  artifactRoots: z.array(z.string().min(1).max(16_384)).max(16),
}).strict();
export const nativeSessionSourceSchema = nativeSessionRootSchema.extend({
  path: z.string().min(1).max(16_384),
  rootPath: z.string().min(1).max(16_384),
  sessionId: z.string().min(1).max(1024),
  title: z.string().max(1024),
  cwd: z.string().max(16_384).nullable(),
  sizeBytes: z.number().int().nonnegative(),
  revision: z.string().min(1),
  modifiedAt: z.number(),
}).strict();
export type NativeEngine = z.infer<typeof nativeEngineSchema>;
export type NativeSessionRoot = z.infer<typeof nativeSessionRootSchema>;
export type NativeSessionSource = z.infer<typeof nativeSessionSourceSchema>;

export const nativeDiscoverSchema = z.object({
  roots: z.array(nativeSessionRootSchema).min(1).max(16),
  cursor: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(100),
}).strict();
export const nativeDiscoverySchema = z.object({
  sessions: z.array(nativeSessionSourceSchema),
  nextCursor: z.number().int().nonnegative().nullable(),
  warnings: z.array(z.string()),
  incomplete: z.boolean(),
}).strict();
export const nativeReadSchema = z.object({
  source: nativeSessionSourceSchema,
  offset: z.number().int().nonnegative(),
  length: z.number().int().min(1).max(NATIVE_SESSION_CHUNK_BYTES),
  artifact: z.object({
    reference: z.string().min(1),
    recordOffset: z.number().int().nonnegative(),
    recordLength: z.number().int().positive(),
    recordSha256: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z.string().nullable(),
  }).strict().nullable(),
}).strict();
export const nativeChunkSchema = z.object({
  content: z.string(),
  offset: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
  revision: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type NativeDiscovery = z.infer<typeof nativeDiscoverySchema>;
export type NativeDiscover = z.infer<typeof nativeDiscoverSchema>;
export type NativeRead = z.infer<typeof nativeReadSchema>;
export type NativeChunk = z.infer<typeof nativeChunkSchema>;

export const nativeSessionCommandSchemas = {
  "native.sessions.discover": nativeDiscoverSchema.extend({ type: z.literal("native.sessions.discover") }).strict(),
  "native.sessions.read": nativeReadSchema.extend({ type: z.literal("native.sessions.read") }).strict(),
};
export const nativeSessionResultSchemas = {
  "native.sessions.discover": nativeDiscoverySchema,
  "native.sessions.read": nativeChunkSchema,
};
