import { createHash } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  classifyStoredProviderThreadClaim, events, getEnvironment, getLatestThreadSequence, getProjectContextDefaults, getThread,
  getThreadExecutionBinding, getThreadPluginMetadata, patchThreadPluginMetadata, persistThreadExecutionBinding,
  queuedThreadMessages, threadExecutionBindings, threadPluginMetadata, threads, updateThread,
} from "@bb/db";
import { NATIVE_HISTORY_OWNER, recordedThreadExecutionOptionsSchema } from "@bb/domain";
import type { NativeImportContinue, NativeImportHandoff } from "@bb/server-contract";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { assertThreadExecutionBindingAvailable, resolveThreadExecutionBinding, requireModelConnection } from "../execution-contexts.js";
import { callHostOnlineRpcForWork } from "../hosts/online-rpc.js";
import { createThreadFromRequest } from "./thread-create.js";
import { appendThreadEvent } from "./thread-events.js";
import { buildExecutionOptions, buildNativeSessionAdmissionCommand } from "./thread-commands.js";
import { NativeSessionImports, nativeWriterNamespace } from "./native-session-imports.js";

const claimSchema = z.object({ importId: z.string(), threadId: z.string(), binding: z.string() }).strict();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
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
    const selected = input.executionContextId === null
      ? { executionContext: null, modelConnection: connection, createdAt: Date.now() }
      : resolveThreadExecutionBinding(deps.db, { projectId: manifest.projectId, hostId: manifest.hostId, provider: thread.providerId, executionContextId: input.executionContextId, modelConnectionId: input.modelConnectionId });
    if (selected === null) throw new ApiError(409, "invalid_request", "The explicit native execution binding could not be resolved.");
    const metadata = getThreadPluginMetadata(deps.db, thread.id, NATIVE_HISTORY_OWNER);
    if (metadata.corrupt) throw new ApiError(409, "provider_session_unavailable", "Native import ownership metadata is corrupt.");
    const hadAcceptedBinding = metadata.metadata.admittedExecution !== undefined || manifest.mode === "native-admitted";
    const previous = getThreadExecutionBinding(deps.db, thread.id);
    if (hadAcceptedBinding && (!previous || previous.executionContext?.id !== selected.executionContext?.id || previous.modelConnection?.id !== selected.modelConnection?.id)) throw new ApiError(409, "invalid_request", "Native admission cannot change an accepted context or payer. Use a separate handoff thread.");
    const binding = hadAcceptedBinding && previous !== null ? previous : selected;
    assertThreadExecutionBindingAvailable(deps.db, binding, manifest.hostId, thread.providerId);
    const fingerprint = digest(JSON.stringify([input.environmentId, binding.executionContext, binding.modelConnection, input.model, input.permissionMode]));
    const claim = { importId: manifest.id, threadId: thread.id, binding: fingerprint };
    const claimsDirectory = join(deps.config.dataDir, "native-session-imports", "writer-claims");
    await mkdir(claimsDirectory, { recursive: true, mode: 0o700 });
    const claimPath = join(claimsDirectory, `${nativeWriterNamespace(manifest)}.json`);
    let claimed = false;
    let submitted = false;
    const clearUnacceptedBinding = () => {
      if (hadAcceptedBinding) return;
      deps.db.transaction((tx) => {
        tx.delete(threadExecutionBindings).where(eq(threadExecutionBindings.threadId, thread.id)).run();
        updateThread(tx, deps.hub, thread.id, { environmentId: thread.environmentId });
      }, { behavior: "immediate" });
    };
    manifest.mode = "archive";
    manifest.reason = "Native ownership is being checked. Ordinary live writes remain blocked until the provider acknowledges admission.";
    manifest.error = null;
    await imports.updateMode(manifest);
    try {
      try {
        const file = await open(claimPath, "wx", 0o600);
        try { await file.writeFile(JSON.stringify(claim)); await file.sync(); } finally { await file.close(); }
        const directory = await open(claimsDirectory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
        const owner = claimSchema.parse(JSON.parse(await readFile(claimPath, "utf8")));
        if (owner.importId !== claim.importId || owner.threadId !== claim.threadId || owner.binding !== claim.binding) throw new ApiError(409, "provider_session_unavailable", "Another thread or binding owns this native source namespace. No second writer was started.");
      }
      claimed = true;
      const storedClaim = classifyStoredProviderThreadClaim(deps.db, { threadId: thread.id, providerThreadId: manifest.source.sessionId });
      if (storedClaim === "foreign" || storedClaim === "ambiguous") throw new ApiError(409, "provider_session_unavailable", "An existing Core thread owns this native source; importing history does not authorize taking its writer.");
      const attached = deps.db.transaction((tx) => {
        if (!hadAcceptedBinding) {
          tx.delete(threadExecutionBindings).where(eq(threadExecutionBindings.threadId, thread.id)).run();
          persistThreadExecutionBinding(tx, thread.id, binding);
        }
        return updateThread(tx, deps.hub, thread.id, { environmentId: environment.id });
      }, { behavior: "immediate" });
      if (!attached) throw new ApiError(409, "invalid_request", "Imported thread became unavailable.");
      const execution = await buildExecutionOptions(deps, { model: input.model, permissionMode: input.permissionMode }, { threadId: thread.id, hostId: manifest.hostId });
      const command = await buildNativeSessionAdmissionCommand(deps, { thread: attached, environment, execution, source: manifest.source });
      submitted = true;
      const result = await callHostOnlineRpcForWork(deps, { hostId: manifest.hostId, command, timeoutMs: 60_000 });
      if (!result.admitted) {
        if (result.ownership === "unclaimed") { await unlink(claimPath); claimed = false; clearUnacceptedBinding(); }
        manifest.reason = result.reason;
        return imports.updateMode(manifest);
      }
      if (result.providerThreadId !== manifest.source.sessionId) throw new Error("Native admission returned a different session identity.");
      deps.db.transaction(() => {
        const identity = deps.db.select({ id: events.id }).from(events).where(and(eq(events.threadId, thread.id), eq(events.type, "thread/identity"), eq(events.providerThreadId, result.providerThreadId))).limit(1).get();
        if (!identity) appendThreadEvent(deps, { threadId: thread.id, environmentId: environment.id, providerThreadId: result.providerThreadId, type: "thread/identity", scope: { kind: "thread" }, data: { providerThreadId: result.providerThreadId } });
        const admittedExecution = { model: execution.model, reasoningLevel: execution.reasoningLevel, permissionMode: execution.permissionMode, serviceTier: execution.serviceTier, source: "native/session/admitted", seq: getLatestThreadSequence(deps.db, { threadId: thread.id }) };
        recordedThreadExecutionOptionsSchema.parse(admittedExecution);
        patchThreadPluginMetadata(deps.db, { threadId: thread.id, pluginId: NATIVE_HISTORY_OWNER, remove: [], set: { admittedExecution } });
      }, { behavior: "immediate" });
      manifest.mode = "native-admitted";
      manifest.reason = "Native session acknowledged with the original identity and provider-owned writer. Its selected execution is persisted separately from native history; no model turn was started by admission.";
      return imports.updateMode(manifest);
    } catch (error) {
      if (!submitted && claimed) { await unlink(claimPath); clearUnacceptedBinding(); }
      manifest.mode = "archive";
      manifest.reason = "Native ownership could not be confirmed. Archive retained; continuation remains blocked and no fresh-session fallback is permitted.";
      manifest.error = error instanceof Error ? error.message : "Native admission failed";
      await imports.updateMode(manifest);
      throw error;
    }
  });
}
function hasAcceptedHandoffInput(deps: AppDeps, threadId: string, text: string): boolean {
  const queued = deps.db.select({ id: queuedThreadMessages.id }).from(queuedThreadMessages).where(and(eq(queuedThreadMessages.threadId, threadId), sql`EXISTS (SELECT 1 FROM json_each(${queuedThreadMessages.content}) AS native_handoff_part WHERE json_extract(native_handoff_part.value, '$.type') = 'text' AND json_extract(native_handoff_part.value, '$.text') = ${text})`)).limit(1).get();
  if (queued) return true;
  return deps.db.select({ id: events.id }).from(events).where(and(eq(events.threadId, threadId), eq(events.type, "client/turn/requested"), sql`EXISTS (SELECT 1 FROM json_each(${events.data}, '$.input') AS native_handoff_part WHERE json_extract(native_handoff_part.value, '$.type') = 'text' AND json_extract(native_handoff_part.value, '$.text') = ${text})`)).limit(1).get() !== undefined;
}
export async function createNativeSessionHandoff(deps: AppDeps, imports: NativeSessionImports, input: NativeImportHandoff) {
  return imports.exclusive(input.importId, async () => {
    const manifest = await imports.get(input.importId);
    requireTarget(deps, manifest, input);
    if (manifest.mode === "native-admitted") throw new ApiError(409, "invalid_request", "Native ownership has already been admitted; handoff is a separate new-dialogue action, not a replacement writer.");
    if (input.executionContextId === null && getProjectContextDefaults(deps.db, manifest.projectId).executionContextId !== null) throw new ApiError(409, "invalid_request", "This project has a default execution context. Select the intended context explicitly; the handoff will not silently inherit one.");
    const handoffKey = digest(JSON.stringify([input.importId, input.environmentId, input.executionContextId, input.modelConnectionId, input.model, input.permissionMode, input.input]));
    const text = `This is a NEW dialogue with a handoff, not native resume. [Open the original retained archive](/native-session-imports?importId=${manifest.id}). Original BB thread: ${manifest.threadId}; native session: ${manifest.source.sessionId}; retained boundary: ${manifest.bytes} bytes / ${manifest.sha256}. Native history and state are retained separately, not injected as the next-turn context.\n\n${input.input}`;
    const recovered = deps.db.select({ threadId: threadPluginMetadata.threadId }).from(threadPluginMetadata).innerJoin(threads, eq(threads.id, threadPluginMetadata.threadId)).where(and(eq(threadPluginMetadata.pluginId, "native-history-handoff"), isNull(threads.deletedAt), sql`json_extract(${threadPluginMetadata.metadataJson}, '$.importId') = ${manifest.id}`)).limit(2).all();
    if (recovered.length > 1) throw new ApiError(409, "invalid_request", "More than one live handoff thread claims this archive; refusing an ambiguous retry.");
    const allocated = recovered[0];
    if (allocated) {
      const metadata = getThreadPluginMetadata(deps.db, allocated.threadId, "native-history-handoff");
      if (metadata.corrupt || (metadata.metadata.handoffKey !== undefined && metadata.metadata.handoffKey !== handoffKey)) throw new ApiError(409, "invalid_request", "This handoff allocation belongs to a different input or execution selection.");
      if (hasAcceptedHandoffInput(deps, allocated.threadId, text)) {
        if (metadata.metadata.handoffKey === undefined) throw new ApiError(409, "invalid_request", "Accepted handoff input lacks its execution-selection receipt; refusing to invent one.");
        manifest.mode = "new-handoff"; manifest.continuationThreadId = allocated.threadId;
        manifest.reason = "Recovered the durably accepted separate handoff dialogue without submitting its input again. Its native identity is not the original session.";
        return imports.updateMode(manifest);
      }
      patchThreadPluginMetadata(deps.db, { threadId: allocated.threadId, pluginId: "native-history-handoff", remove: [], set: { handoffKey } });
    }
    manifest.mode = "archive"; manifest.continuationThreadId = null;
    await imports.updateMode(manifest);
    const request: Parameters<typeof createThreadFromRequest>[1] = { projectId: manifest.projectId, environment: { type: "reuse", environmentId: input.environmentId },
      origin: "plugin", originPluginId: "native-history-handoff", pluginMetadata: { importId: manifest.id, archiveThreadId: manifest.threadId, handoffKey },
      title: `Handoff · ${manifest.source.title}`, providerId: manifest.source.engine === "omp" ? "acp-omp" : manifest.source.engine === "claude" ? "claude-code" : "codex",
      ...(input.executionContextId === null ? {} : { executionContextId: input.executionContextId }), modelConnectionId: input.modelConnectionId,
      model: input.model, permissionMode: input.permissionMode, startedOnBehalfOf: null,
      input: [{ type: "text", mentions: [], text }],
    };
    const thread = await createThreadFromRequest(deps, request, allocated === undefined ? {} : { recoverPendingThreadId: allocated.threadId });
    if (!hasAcceptedHandoffInput(deps, thread.id, text)) throw new ApiError(409, "invalid_request", "The handoff thread exists but its selected input has not been durably accepted.");
    manifest.mode = "new-handoff";
    manifest.continuationThreadId = thread.id;
    manifest.reason = "A separately requested new dialogue durably accepted its selected handoff input and archive link. Its native identity is not the original session.";
    return imports.updateMode(manifest);
  });
}
