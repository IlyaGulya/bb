import type { NativeSessionSource } from "@bb/host-daemon-contract";
import type { AgentRuntime } from "@bb/agent-runtime";
import type { RuntimeThreadExecutionOptions } from "@bb/domain";
import { requireResolvedWorkspaceForCommand } from "../workspace-resolution.js";
import { resolveRuntimeBridgeLaunch, type CommandDispatchOptions, type CommandOf } from "../command-dispatch-support.js";
import { readNativeSession, readNativeSessionIdentity } from "./native-sessions.js";

type ResumeThreadArgs = Parameters<AgentRuntime["resumeThread"]>[0];
type NativeOwner = { key: string; state: "pending" | "owned" | "uncertain"; promise: Promise<void> };
const owners = new WeakMap<AgentRuntime, Map<string, NativeOwner>>();
class NativeOwnershipUncertainError extends Error {}
function nativeImportResumeOptions(options: RuntimeThreadExecutionOptions, source: NativeSessionSource): RuntimeThreadExecutionOptions {
  return { ...options, providerOptions: { ...options.providerOptions, nativeSessionImport: {
    path: source.path, rootPath: source.rootPath, sessionId: source.sessionId, cwd: source.cwd,
  } } };
}
async function assertImportedNativeIdentity(runtime: AgentRuntime, threadId: string, expectedId: string): Promise<void> {
  if (runtime.getProviderSession(threadId)?.providerThreadId !== expectedId) throw new Error("Native import resume returned a different session identity. No prompt was submitted; a fresh session was not accepted.");
}
function nativeOwnerKey(args: ResumeThreadArgs, source: NativeSessionSource): string {
  return JSON.stringify([args.providerId, source.path, source.sessionId, source.cwd, args.options.providerOptions?.executionContext, args.options.providerOptions?.modelConnection]);
}
export async function resumeImportedNativeSession(runtime: AgentRuntime, args: ResumeThreadArgs, source: NativeSessionSource, purpose: "archive-admission" | "admitted-resume", signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (source.cwd === null || args.providerThreadId !== source.sessionId) throw new Error("Native import requires the exact original identity and recorded workspace.");
  let entries = owners.get(runtime);
  if (!entries) { entries = new Map(); owners.set(runtime, entries); }
  const registry = entries;
  const key = nativeOwnerKey(args, source);
  const existing = registry.get(args.threadId);
  if (existing && (existing.state !== "owned" || runtime.hasThread(args.threadId))) {
    if (existing.key !== key) throw new NativeOwnershipUncertainError("A different native source or execution binding is already constructing or owns this runtime.");
    if (existing.state === "uncertain") throw new NativeOwnershipUncertainError("Native runtime release could not be confirmed; another admission cannot start.");
    await existing.promise;
    signal?.throwIfAborted();
    await assertImportedNativeIdentity(runtime, args.threadId, source.sessionId);
    return;
  }
  if (runtime.hasThread(args.threadId)) throw new NativeOwnershipUncertainError("A registered native identity is not proof of acknowledged import ownership. Existing construction or ownership must settle first.");
  const owner: NativeOwner = { key, state: "pending", promise: Promise.resolve() };
  registry.set(args.threadId, owner);
  owner.promise = Promise.resolve().then(async () => {
    let started = false;
    try {
      if (purpose === "archive-admission") await readNativeSession({ source, offset: 0, length: 1, artifact: null }, signal);
      else await readNativeSessionIdentity(source);
      signal?.throwIfAborted();
      if (runtime.hasThread(args.threadId)) throw new Error("A competing native runtime appeared before import construction.");
      started = true;
      await runtime.resumeThread({ ...args, options: nativeImportResumeOptions(args.options, source) });
      signal?.throwIfAborted();
      await assertImportedNativeIdentity(runtime, args.threadId, source.sessionId);
      owner.state = "owned";
    } catch (error) {
      if (started && runtime.hasThread(args.threadId)) {
        try { await runtime.stopThread({ threadId: args.threadId }); }
        catch { owner.state = "uncertain"; throw new NativeOwnershipUncertainError("Native admission failed and its runtime release could not be confirmed."); }
      }
      if (registry.get(args.threadId) === owner) registry.delete(args.threadId);
      throw error;
    }
  });
  await owner.promise;
}
export async function admitNativeSession(command: CommandOf<"native.sessions.admit">, options: CommandDispatchOptions, signal?: AbortSignal) {
  if (command.source.engine === "omp") return { admitted: false as const, ownership: "unclaimed" as const, reason: "OMP ACP session/load is available, but external native ownership and scoped source-receipt adoption are not supported by this adapter. No original receipt was fabricated and no agent was started. Full history remains archived." };
  if (command.source.engine === "claude") return { admitted: false as const, ownership: "unclaimed" as const, reason: "Claude native resume is available, but this adapter cannot establish exclusive ownership against an external CLI writer. No second writer was started. Full history remains archived; create a separate handoff thread explicitly." };
  if (command.providerId !== "codex" || command.options.providerOptions?.executionContext) return { admitted: false as const, ownership: "unclaimed" as const, reason: "The selected provider/context cannot admit this native source. No runtime was started." };
  if (command.options.providerOptions?.modelConnection && typeof command.options.providerOptions.modelConnection === "object" && "gateway" in command.options.providerOptions.modelConnection && command.options.providerOptions.modelConnection.gateway) return { admitted: false as const, ownership: "unclaimed" as const, reason: "A foreign native session has no original gateway receipt. Import cannot invent one or switch its account binding; use a separate handoff thread." };
  if (command.source.cwd === null || command.workspaceContext.workspacePath !== command.source.cwd) return { admitted: false as const, ownership: "unclaimed" as const, reason: "Native admission requires the original source workspace, explicitly attached on its original host. No runtime was started." };
  signal?.throwIfAborted();
  const bridgeLaunch = await resolveRuntimeBridgeLaunch(command.bridgeLaunch, options);
  const entry = await requireResolvedWorkspaceForCommand({ environmentId: command.environmentId, injectedSkillSources: command.injectedSkillSources,
    runtimeManager: options.runtimeManager, targetThreadId: command.threadId, workspaceContext: command.workspaceContext });
  const resume: ResumeThreadArgs = { bridgeLaunch, skillRoots: entry.skillRoots, environmentId: command.environmentId,
    threadId: command.threadId, projectId: command.projectId, providerId: command.providerId, providerThreadId: command.source.sessionId,
    contributedEnv: command.contributedEnv, options: command.options, instructions: command.instructions,
    dynamicTools: command.dynamicTools, instructionMode: command.instructionMode };
  try {
    await resumeImportedNativeSession(entry.runtime, resume, command.source, "archive-admission", signal);
    signal?.throwIfAborted();
    await options.eventSink.flush();
    signal?.throwIfAborted();
    return { admitted: true as const, providerThreadId: command.source.sessionId };
  } catch (error) {
    if (error instanceof NativeOwnershipUncertainError) return { admitted: false as const, ownership: "uncertain" as const, reason: error.message };
    const registry = owners.get(entry.runtime);
    const owner = registry?.get(command.threadId);
    if (owner?.state === "owned" && owner.key === nativeOwnerKey(resume, command.source)) {
      try { await entry.runtime.stopThread({ threadId: command.threadId }); registry?.delete(command.threadId); }
      catch { owner.state = "uncertain"; return { admitted: false as const, ownership: "uncertain" as const, reason: "Native acknowledgement failed and its writer release could not be confirmed." }; }
    }
    return { admitted: false as const, ownership: "unclaimed" as const, reason: `Native admission was not acknowledged; no prompt was submitted: ${error instanceof Error ? error.message : "provider ownership could not be confirmed"}` };
  }
}
