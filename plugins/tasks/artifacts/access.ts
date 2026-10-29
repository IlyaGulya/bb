import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { TaskArtifactStore } from "./store.js";
import type { TaskArtifact } from "../shared/artifacts.js";

type ImageScope = { executionContextId: string; bbProjectId: string };

async function authorizeArtifacts(
  bb: BbPluginApi,
  artifacts: readonly TaskArtifact[],
  scope: ImageScope | null,
): Promise<void> {
  for (const artifact of artifacts) {
    if (scope && (scope.executionContextId !== artifact.executionContextId || scope.bbProjectId !== artifact.bbProjectId)) {
      throw new Error("Retained screenshot is unavailable in this execution context");
    }
    const context = await bb.sdk.experimental_executionContexts.get({ id: artifact.executionContextId });
    if (!context.enabled || !context.projectIds.includes(artifact.bbProjectId)) {
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
  const [thread, binding] = await Promise.all([
    bb.sdk.threads.get({ threadId }),
    bb.sdk.experimental_executionContexts.getThreadBinding({ threadId }),
  ]);
  if (thread.deletedAt !== null || !binding?.executionContext) {
    throw new Error("Retained screenshot is unavailable in this execution context");
  }
  return authorizeArtifacts(bb, retained, { executionContextId: binding.executionContext.id, bbProjectId: thread.projectId });
}
