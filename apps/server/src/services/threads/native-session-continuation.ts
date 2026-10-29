import { createHash } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import {
  classifyStoredProviderThreadClaim, getEnvironment, getProjectContextDefaults, getThread, getThreadExecutionBinding, persistThreadExecutionBinding, threadPluginMetadata, updateThread,
} from "@bb/db";
import type { NativeImportContinue, NativeImportHandoff } from "@bb/server-contract";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { assertThreadExecutionBindingAvailable, resolveThreadExecutionBinding, requireModelConnection } from "../execution-contexts.js";
import { callHostOnlineRpcForWork } from "../hosts/online-rpc.js";
import { createThreadFromRequest } from "./thread-create.js";
import { appendThreadEvent } from "./thread-events.js";
import { buildExecutionOptions, buildNativeSessionAdmissionCommand } from "./thread-commands.js";
import { NATIVE_HISTORY_OWNER } from "@bb/domain";
import { NativeSessionImports, nativeWriterNamespace } from "./native-session-imports.js";

const claimSchema = z.object({ importId: z.string(), threadId: z.string(), binding: z.string() }).strict();
function requireTarget(deps: AppDeps, manifest: Awaited<ReturnType<NativeSessionImports["get"]>>, input: NativeImportContinue) {
  const environment = getEnvironment(deps.db, input.environmentId);
  if (!environment || environment.projectId !== manifest.projectId || environment.hostId !== manifest.hostId || environment.status !== "ready") throw new ApiError(409, "invalid_request", "Select a ready workspace in the destination project on the original source machine.");
  if (manifest.status !== "ready" || manifest.threadId === null) throw new ApiError(409, "invalid_request", "Finish the native archive before choosing a continuation action.");
  return environment;
}
export async function admitNativeSessionImport(deps: AppDeps, imports: NativeSessionImports, input: NativeImportContinue) {
  return imports.exclusive(input.importId, async () => {
    const manifest = await imports.get(input.importId);
    const environment = requireTarget(deps, manifest, input);
    const thread = getThread(deps.db, manifest.threadId!);
    if (!thread || thread.deletedAt !== null || thread.originPluginId !== NATIVE_HISTORY_OWNER) throw new ApiError(409, "invalid_request", "The imported archive thread is unavailable.");
    if (manifest.mode === "new-handoff") throw new ApiError(409, "invalid_request", "This archive already has a separate handoff thread; it is not a native continuation.");
    if (manifest.source.cwd === null || environment.path !== manifest.source.cwd) throw new ApiError(409, "invalid_request", "Native admission must preserve the exact original workspace on its source machine.");
    const connection = requireModelConnection(deps.db, input.modelConnectionId);
    const binding = input.executionContextId === null
      ? { executionContext: null, modelConnection: connection, createdAt: Date.now() }
      : resolveThreadExecutionBinding(deps.db, { projectId: manifest.projectId, hostId: manifest.hostId, provider: thread.providerId, executionContextId: input.executionContextId, modelConnectionId: input.modelConnectionId });
    assertThreadExecutionBindingAvailable(deps.db, binding, manifest.hostId, thread.providerId);
    const previous = getThreadExecutionBinding(deps.db, thread.id);
    if (previous && (previous.executionContext?.id !== binding?.executionContext?.id || previous.modelConnection?.id !== binding?.modelConnection?.id)) throw new ApiError(409, "invalid_request", "Native admission cannot change a previously selected context or payer. Use a separate handoff thread.");
    const fingerprint = createHash("sha256").update(JSON.stringify([input.environmentId, binding?.executionContext, binding?.modelConnection, input.model])).digest("hex");
    const claim = { importId: manifest.id, threadId: thread.id, binding: fingerprint };
    const claimsDirectory = join(deps.config.dataDir, "native-session-imports", "writer-claims");
    await mkdir(claimsDirectory, { recursive: true, mode: 0o700 });
    const claimPath = join(claimsDirectory, `${nativeWriterNamespace(manifest)}.json`);
    try {
      const file = await open(claimPath, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(claim)); await file.sync(); } finally { await file.close(); }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
      const owner = claimSchema.parse(JSON.parse(await readFile(claimPath, "utf8")));
      if (owner.importId !== claim.importId || owner.threadId !== claim.threadId || owner.binding !== claim.binding) throw new ApiError(409, "provider_session_unavailable", "Another thread or binding owns this native source namespace. No second writer was started.");
    }
    if (!previous) persistThreadExecutionBinding(deps.db, thread.id, binding);
    const attached = updateThread(deps.db, deps.hub, thread.id, { environmentId: environment.id });
    if (!attached) throw new ApiError(409, "invalid_request", "Imported thread became unavailable.");
    const storedClaim = classifyStoredProviderThreadClaim(deps.db, { threadId: thread.id, providerThreadId: manifest.source.sessionId });
    if (storedClaim === "foreign" || storedClaim === "ambiguous") throw new ApiError(409, "provider_session_unavailable", "An existing Core thread owns this native source; importing history does not authorize taking its writer.");
    const execution = await buildExecutionOptions(deps, { model: input.model, permissionMode: input.permissionMode }, { threadId: thread.id, hostId: manifest.hostId });
    try {
      const command = await buildNativeSessionAdmissionCommand(deps, { thread: attached, environment, execution, source: manifest.source });
      const result = await callHostOnlineRpcForWork(deps, { hostId: manifest.hostId, command, timeoutMs: 60_000 });
      if (!result.admitted) {
        await unlink(claimPath);
        manifest.reason = result.reason;
        return imports.updateMode(manifest);
      }
      if (result.providerThreadId !== manifest.source.sessionId) throw new Error("Native admission returned a different session identity.");
      appendThreadEvent(deps, { threadId: thread.id, environmentId: environment.id, providerThreadId: result.providerThreadId,
        type: "thread/identity", scope: { kind: "thread" }, data: { providerThreadId: result.providerThreadId } });
      manifest.mode = "native-admitted";
      manifest.reason = "Native session admitted with the original identity and provider-owned exclusive writer. History remains separately archived; no model turn was started by admission.";
      manifest.error = null;
      return imports.updateMode(manifest);
    } catch (error) {
      manifest.reason = "Native ownership could not be confirmed. Archive retained; continuation remains blocked and no fresh-session fallback is permitted.";
      manifest.error = error instanceof Error ? error.message : "Native admission failed";
      await imports.updateMode(manifest);
      throw error;
    }
  });
}
export async function createNativeSessionHandoff(deps: AppDeps, imports: NativeSessionImports, input: NativeImportHandoff) {
  return imports.exclusive(input.importId, async () => {
    const manifest = await imports.get(input.importId);
    requireTarget(deps, manifest, input);
    if (manifest.continuationThreadId !== null) return manifest;
    if (manifest.mode === "native-admitted") throw new ApiError(409, "invalid_request", "Native ownership has already been admitted; handoff is a separate new-dialogue action, not a replacement writer.");
    if (input.executionContextId === null && getProjectContextDefaults(deps.db, manifest.projectId).executionContextId !== null) throw new ApiError(409, "invalid_request", "This project has a default execution context. Select the intended context explicitly; the handoff will not silently inherit one.");
    const recovered = deps.db.select({ threadId: threadPluginMetadata.threadId }).from(threadPluginMetadata).where(and(eq(threadPluginMetadata.pluginId, "native-history-handoff"), sql`json_extract(${threadPluginMetadata.metadataJson}, '$.importId') = ${manifest.id}`)).limit(2).all();
    if (recovered.length > 1) throw new ApiError(409, "invalid_request", "More than one handoff thread claims this archive; refusing an ambiguous retry.");
    if (recovered[0]) {
      manifest.mode = "new-handoff"; manifest.continuationThreadId = recovered[0].threadId;
      manifest.reason = "Recovered the separately requested new handoff dialogue. Its native identity is not the original session.";
      return imports.updateMode(manifest);
    }
    const thread = await createThreadFromRequest(deps, { projectId: manifest.projectId, environment: { type: "reuse", environmentId: input.environmentId },
      origin: "plugin", originPluginId: "native-history-handoff", pluginMetadata: { importId: manifest.id, archiveThreadId: manifest.threadId },
      title: `Handoff · ${manifest.source.title}`, providerId: manifest.source.engine === "omp" ? "acp-omp" : manifest.source.engine === "claude" ? "claude-code" : "codex",
      ...(input.executionContextId === null ? {} : { executionContextId: input.executionContextId }), modelConnectionId: input.modelConnectionId,
      model: input.model, permissionMode: input.permissionMode, startedOnBehalfOf: null,
      input: [{ type: "text", text: `This is a NEW dialogue with a handoff, not native resume. [Open the original retained archive](/native-session-imports?importId=${manifest.id}). Original BB thread: ${manifest.threadId}; native session: ${manifest.source.sessionId}; retained boundary: ${manifest.bytes} bytes / ${manifest.sha256}. Native history and state are retained separately, not injected as the next-turn context.\n\n${input.input}` }],
    });
    manifest.mode = "new-handoff";
    manifest.continuationThreadId = thread.id;
    manifest.reason = "A separately requested new BB dialogue was created with a handoff and archive link. Its native identity is not the original session.";
    return imports.updateMode(manifest);
  });
}
