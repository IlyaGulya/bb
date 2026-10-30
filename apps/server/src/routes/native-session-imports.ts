import type { Hono } from "hono";
import { publicApiRoutes, typedRoutes, type PublicApiSchema } from "@bb/server-contract";
import { executionContexts, getThreadPluginMetadata, modelConnections } from "@bb/db";
import { nativeReadSchema, type NativeSessionRoot } from "@bb/host-daemon-contract";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { requirePublicProject, requirePublicThread } from "../services/lib/entity-lookup.js";
import { callHostOnlineRpc, callHostRetryableOnlineRpc } from "../services/hosts/online-rpc.js";
import { NativeSessionImports } from "../services/threads/native-session-imports.js";
import { NATIVE_HISTORY_OWNER } from "@bb/domain";
import { admitNativeSessionImport, createNativeSessionHandoff } from "../services/threads/native-session-continuation.js";
import { eq } from "drizzle-orm";
import { posix } from "node:path";

function configuredNativeLocations(deps: AppDeps, hostId: string): { roots: NativeSessionRoot[]; warnings: string[] } {
  const candidates: { provider: string; path: string | null; profile: string }[] = deps.db.select({ definition: modelConnections.definition })
    .from(modelConnections).where(eq(modelConnections.hostId, hostId)).all()
    .map(({ definition }) => ({ provider: definition.provider, path: definition.nativeAuth.configDir, profile: "Saved native profile" }));
  for (const entry of deps.db.select({ context: executionContexts.definition, connection: modelConnections.definition })
    .from(executionContexts).innerJoin(modelConnections, eq(executionContexts.defaultModelConnectionId, modelConnections.id))
    .where(eq(modelConnections.hostId, hostId)).all()) {
    if (entry.context.nativeMcpProfile?.configDir) candidates.push({ provider: entry.connection.provider, path: entry.context.nativeMcpProfile.configDir, profile: entry.context.name });
  }
  const roots: NativeSessionRoot[] = [];
  for (const candidate of candidates) {
    if (!candidate.path || !posix.isAbsolute(candidate.path)) continue;
    const engine = candidate.provider === "acp-omp" ? "omp" : candidate.provider === "claude-code" ? "claude" : candidate.provider === "codex" ? "codex" : null;
    if (!engine) continue;
    for (const suffix of engine === "codex" ? ["sessions", "archived_sessions"] : engine === "claude" ? ["projects"] : ["sessions"]) {
      const path = posix.join(candidate.path, suffix);
      if (roots.some((entry) => entry.engine === engine && entry.path === path)) continue;
      roots.push({ engine, path, profile: candidate.profile.slice(0, 256), artifactRoots: engine === "omp" ? [path, posix.join(candidate.path, "blobs")] : [path] });
    }
  }
  return { roots: roots.slice(0, 16), warnings: roots.length > 16 ? ["More than 16 configured history roots are available; use Advanced to select an additional profile."] : [] };
}

export function registerNativeSessionImportRoutes(app: Hono, deps: AppDeps): NativeSessionImports {
  const imports = new NativeSessionImports({ db: deps.db, hub: deps.hub, dataDir: deps.config.dataDir,
    read: (hostId, input, signal) => callHostRetryableOnlineRpc(deps, { hostId, signal, timeoutMs: 30_000, command: { type: "native.sessions.read", ...input } }),
    snapshot: (hostId, source, resolveOriginal, signal) => callHostOnlineRpc(deps, { hostId, signal, timeoutMs: 300_000, command: { type: "native.sessions.snapshot", source, resolveOriginal, roots: configuredNativeLocations(deps, hostId).roots } }),
  });
  const { get, post } = typedRoutes<PublicApiSchema>(app, { onValidationError: (message) => new ApiError(400, "invalid_request", message) });
  const routes = publicApiRoutes.nativeSessionImports;
  async function authorize(importId: string) {
    const manifest = await imports.get(importId);
    requirePublicProject(deps.db, manifest.projectId);
    if (manifest.threadId) requirePublicThread(deps.db, manifest.threadId);
    return manifest;
  }
  get(routes.file, async (_context, input) => { await authorize(input.importId); return imports.download(input.importId, input.file); });
  post(routes.locations, async (context, input) => {
    context.header("cache-control", "private, no-store");
    const configured = configuredNativeLocations(deps, input.hostId);
    const found = await callHostRetryableOnlineRpc(deps, { hostId: input.hostId, timeoutMs: 30_000, signal: context.req.raw.signal,
      command: { type: "native.sessions.locations", roots: configured.roots } });
    return context.json({ roots: found.roots, warnings: [...found.warnings, ...configured.warnings] });
  });
  post(routes.list, async (context, input) => {
    if (input.projectId) requirePublicProject(deps.db, input.projectId);
    context.header("cache-control", "private, no-store");
    const visible = [];
    for (const manifest of await imports.list({ hostId: input.hostId, projectId: input.projectId })) {
      try { await authorize(manifest.id); visible.push(manifest); }
      catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
      if (visible.length >= (input.limit ?? 30)) break;
    }
    return context.json(visible);
  });
  post(routes.refresh, async (context, input) => {
    await authorize(input.importId);
    context.header("cache-control", "private, no-store");
    const manifest = await imports.refresh(input.importId, context.req.raw.signal);
    return context.json(manifest, manifest.status === "importing" ? 202 : 200);
  });
  post(routes.discover, async (context, input) => {
    context.header("cache-control", "private, no-store");
    return context.json(await callHostRetryableOnlineRpc(deps, { hostId: input.hostId, timeoutMs: 30_000, signal: context.req.raw.signal,
      command: { type: "native.sessions.discover", roots: input.roots, cursor: input.cursor, limit: input.limit } }));
  });
  post(routes.preview, async (context, input) => {
    context.header("cache-control", "private, no-store");
    return context.json(await callHostRetryableOnlineRpc(deps, { hostId: input.hostId, timeoutMs: 30_000, signal: context.req.raw.signal,
      command: { type: "native.sessions.read", ...nativeReadSchema.parse({ source: input.source, offset: input.offset, length: input.length, artifact: null }) } }));
  });
  post(routes.start, async (context, input) => {
    for (const selection of input.selections) requirePublicProject(deps.db, selection.projectId);
    context.header("cache-control", "private, no-store");
    const results = [];
    const failures: { index: number; message: string }[] = [];
    for (const [index, selection] of input.selections.entries()) {
      try { results.push(await imports.start(selection)); }
      catch (error) { failures.push({ index, message: error instanceof Error ? error.message : "Import could not be started" }); }
    }
    return context.json({ imports: results, failures });
  });
  post(routes.get, async (context, input) => {
    context.header("cache-control", "private, no-store");
    return context.json(await authorize(input.importId));
  });
  post(routes.forThread, async (context, input) => {
    const thread = requirePublicThread(deps.db, input.threadId);
    context.header("cache-control", "private, no-store");
    const metadata = getThreadPluginMetadata(deps.db, thread.id, NATIVE_HISTORY_OWNER);
    const handoff = thread.originPluginId === "native-history-handoff" ? getThreadPluginMetadata(deps.db, thread.id, "native-history-handoff") : null;
    const importId = typeof metadata.metadata.importId === "string" ? metadata.metadata.importId : handoff?.metadata.importId;
    return context.json(typeof importId === "string" ? await authorize(importId) : null);
  });
  post(routes.resume, async (context, input) => { await authorize(input.importId); return context.json(await imports.resume(input.importId)); });
  post(routes.cancel, async (context, input) => { await authorize(input.importId); return context.json(await imports.cancel(input.importId)); });
  post(routes.records, async (context, input) => {
    await authorize(input.importId); context.header("cache-control", "private, no-store");
    return context.json(await imports.records(input));
  });
  post(routes.bytes, async (context, input) => {
    await authorize(input.importId); context.header("cache-control", "private, no-store");
    return context.json(await imports.bytes(input));
  });
  post(routes.admit, async (context, input) => { await authorize(input.importId); return context.json(await admitNativeSessionImport(deps, imports, input)); });
  post(routes.handoff, async (context, input) => { await authorize(input.importId); return context.json(await createNativeSessionHandoff(deps, imports, input)); });
  return imports;
}
