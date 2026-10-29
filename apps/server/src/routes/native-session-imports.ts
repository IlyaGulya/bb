import type { Hono } from "hono";
import { publicApiRoutes, typedRoutes, type PublicApiSchema } from "@bb/server-contract";
import { getThreadPluginMetadata } from "@bb/db";
import { nativeReadSchema } from "@bb/host-daemon-contract";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { requirePublicProject, requirePublicThread } from "../services/lib/entity-lookup.js";
import { callHostRetryableOnlineRpc } from "../services/hosts/online-rpc.js";
import { NativeSessionImports } from "../services/threads/native-session-imports.js";
import { NATIVE_HISTORY_OWNER } from "@bb/domain";
import { admitNativeSessionImport, createNativeSessionHandoff } from "../services/threads/native-session-continuation.js";

export function registerNativeSessionImportRoutes(app: Hono, deps: AppDeps): NativeSessionImports {
  const imports = new NativeSessionImports({ db: deps.db, hub: deps.hub, dataDir: deps.config.dataDir,
    read: (hostId, input, signal) => callHostRetryableOnlineRpc(deps, { hostId, signal, timeoutMs: 30_000, command: { type: "native.sessions.read", ...input } }),
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
