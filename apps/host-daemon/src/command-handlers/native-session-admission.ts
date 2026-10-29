import type { NativeSessionSource } from "@bb/host-daemon-contract";
import type { AgentRuntime } from "@bb/agent-runtime";
import type { RuntimeThreadExecutionOptions } from "@bb/domain";
import { requireResolvedWorkspaceForCommand } from "../workspace-resolution.js";
import { resolveRuntimeBridgeLaunch, type CommandDispatchOptions, type CommandOf } from "../command-dispatch-support.js";
import { readNativeSession } from "./native-sessions.js";

export function nativeImportResumeOptions(options: RuntimeThreadExecutionOptions, source: NativeSessionSource): RuntimeThreadExecutionOptions {
  return { ...options, providerOptions: { ...options.providerOptions, nativeSessionImport: {
    path: source.path, rootPath: source.rootPath, sessionId: source.sessionId, cwd: source.cwd,
  } } };
}
export async function assertImportedNativeIdentity(runtime: AgentRuntime, threadId: string, expectedId: string): Promise<void> {
  const identity = runtime.getProviderSession(threadId);
  if (identity?.providerThreadId !== expectedId) {
    if (runtime.hasThread(threadId)) await runtime.stopThread({ threadId });
    throw new Error("Native import resume returned a different session identity. No prompt was submitted; a fresh session was not accepted.");
  }
}
export async function admitNativeSession(command: CommandOf<"native.sessions.admit">, options: CommandDispatchOptions, signal?: AbortSignal) {
  if (command.source.engine === "omp") return { admitted: false as const, reason: "OMP ACP session/load is available, but external native ownership and scoped source-receipt adoption are not supported by this adapter. No original receipt was fabricated and no agent was started. Full history remains archived." };
  if (command.source.engine === "claude") return { admitted: false as const, reason: "Claude native resume is available, but this adapter cannot establish exclusive ownership against an external CLI writer. No second writer was started. Full history remains archived; create a separate handoff thread explicitly." };
  if (command.providerId !== "codex" || command.options.providerOptions?.executionContext) return { admitted: false as const, reason: "The selected provider/context cannot admit this native source. No runtime was started." };
  if (command.options.providerOptions?.modelConnection && typeof command.options.providerOptions.modelConnection === "object" && "gateway" in command.options.providerOptions.modelConnection && command.options.providerOptions.modelConnection.gateway) return { admitted: false as const, reason: "A foreign native session has no original gateway receipt. Import cannot invent one or switch its account binding; use a separate handoff thread." };
  if (command.source.cwd === null || command.workspaceContext.workspacePath !== command.source.cwd) return { admitted: false as const, reason: "Native admission requires the original source workspace, explicitly attached on its original host. No runtime was started." };
  signal?.throwIfAborted();
  const bridgeLaunch = await resolveRuntimeBridgeLaunch(command.bridgeLaunch, options);
  const entry = await requireResolvedWorkspaceForCommand({ environmentId: command.environmentId, injectedSkillSources: command.injectedSkillSources,
    runtimeManager: options.runtimeManager, targetThreadId: command.threadId, workspaceContext: command.workspaceContext });
  if (entry.runtime.hasThread(command.threadId)) {
    await assertImportedNativeIdentity(entry.runtime, command.threadId, command.source.sessionId);
    return { admitted: true as const, providerThreadId: command.source.sessionId };
  }
  try {
    await readNativeSession({ source: command.source, offset: Math.max(0, command.source.sizeBytes - 1), length: 1, artifact: null }, signal);
    signal?.throwIfAborted();
    await entry.runtime.resumeThread({ bridgeLaunch, skillRoots: entry.skillRoots, environmentId: command.environmentId,
      threadId: command.threadId, projectId: command.projectId, providerId: command.providerId, providerThreadId: command.source.sessionId,
      contributedEnv: command.contributedEnv, options: nativeImportResumeOptions(command.options, command.source), instructions: command.instructions,
      dynamicTools: command.dynamicTools, instructionMode: command.instructionMode });
    await assertImportedNativeIdentity(entry.runtime, command.threadId, command.source.sessionId);
    await options.eventSink.flush();
    return { admitted: true as const, providerThreadId: command.source.sessionId };
  } catch (error) {
    if (entry.runtime.hasThread(command.threadId)) await entry.runtime.stopThread({ threadId: command.threadId });
    return { admitted: false as const, reason: `Native admission refused and the BB runtime was released without submitting a prompt: ${error instanceof Error ? error.message : "provider ownership could not be confirmed"}` };
  }
}
