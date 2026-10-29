import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { TaskArtifactStore } from "./store.js";
import type { TaskArtifact } from "../shared/artifacts.js";

type ImageScope = { executionContextId: string; bbProjectId: string };
type ContextPermission = { id: string; enabled: boolean; projectIds: readonly string[] };

function matchesReaderScope(pinned: ImageScope, reader: ImageScope | null): boolean {
  return reader === null || reader.executionContextId === pinned.executionContextId && reader.bbProjectId === pinned.bbProjectId;
}

function contextPermits(pinned: ImageScope, context: ContextPermission | undefined): boolean {
  return context !== undefined && context.id === pinned.executionContextId && context.enabled && context.projectIds.includes(pinned.bbProjectId);
}

async function threadImageScope(bb: BbPluginApi, threadId: string): Promise<ImageScope | null> {
  const [thread, binding] = await Promise.all([
    bb.sdk.threads.get({ threadId }),
    bb.sdk.experimental_executionContexts.getThreadBinding({ threadId }),
  ]);
  if (thread.deletedAt !== null || !binding?.executionContext) return null;
  return { executionContextId: binding.executionContext.id, bbProjectId: thread.projectId };
}

async function authorizeArtifacts(
  bb: BbPluginApi,
  artifacts: readonly TaskArtifact[],
  scope: ImageScope | null,
): Promise<void> {
  for (const artifact of artifacts) {
    if (!matchesReaderScope(artifact, scope)) {
      throw new Error("Retained screenshot is unavailable in this execution context");
    }
    const context = await bb.sdk.experimental_executionContexts.get({ id: artifact.executionContextId });
    if (!contextPermits(artifact, context)) {
      throw new Error("Retained screenshot is unavailable in this execution context");
    }
  }
}

export async function authorizeRetainedImage(
  bb: BbPluginApi,
  attachmentId: string,
  scope: ImageScope | null,
): Promise<void> {
  const artifacts = new TaskArtifactStore({ database: bb.storage.database() }).forImage(attachmentId);
  return authorizeArtifacts(bb, artifacts, scope);
}

export async function authorizeAttachmentForThread(
  bb: BbPluginApi,
  attachmentId: string,
  threadId: string | null,
): Promise<void> {
  const retained = new TaskArtifactStore({ database: bb.storage.database() }).forImage(attachmentId);
  if (retained.length === 0) return;
  if (!threadId) return authorizeArtifacts(bb, retained, null);
  const scope = await threadImageScope(bb, threadId);
  if (scope === null) throw new Error("Retained screenshot is unavailable in this execution context");
  return authorizeArtifacts(bb, retained, scope);
}

export async function filterReadableAttachments<T extends { id: string }>(
  bb: BbPluginApi,
  attachments: T[],
  threadId: string | null,
): Promise<T[]> {
  const scopes = new TaskArtifactStore({ database: bb.storage.database() }).imageScopes(attachments.map(attachment => attachment.id));
  if (scopes.length === 0) return attachments;
  let reader: ImageScope | null = null;
  if (threadId) {
    reader = await threadImageScope(bb, threadId);
    if (reader === null) {
      const retainedIds = new Set<string>();
      for (const scope of scopes) retainedIds.add(scope.attachmentId);
      return attachments.filter(attachment => !retainedIds.has(attachment.id));
    }
  }
  const contexts = new Map<string, ContextPermission>();
  for (const context of await bb.sdk.experimental_executionContexts.list()) contexts.set(context.id, context);
  const denied = new Set<string>();
  for (const scope of scopes) {
    if (!matchesReaderScope(scope, reader) || !contextPermits(scope, contexts.get(scope.executionContextId))) denied.add(scope.attachmentId);
  }
  return attachments.filter(attachment => !denied.has(attachment.id));
}
