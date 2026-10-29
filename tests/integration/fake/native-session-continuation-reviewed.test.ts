import { eq } from "drizzle-orm";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { createThread, events, getThread, getThreadExecutionBinding, markThreadDeleted, queuedThreadMessages, saveExecutionContext, saveModelConnection, upsertProjectExecutionDefaults } from "@bb/db";
import { executionContextSchema, modelConnectionSchema, promptInputSchema } from "@bb/domain";
import { createQueuedMessageRequestSchema, sendMessageRequestSchema } from "@bb/server-contract";
import type { TestAppHarness } from "../../../apps/server/test/helpers/test-app.js";
import { createNativeSessionHandoff } from "../../../apps/server/src/services/threads/native-session-continuation.js";
import { resolveExistingThreadExecutionPlan } from "../../../apps/server/src/services/threads/thread-execution-plan.js";
import { assertNativeHistoryWritable } from "../../../apps/server/src/services/threads/native-history-guard.js";
import { createQueuedMessageForThread } from "../../../apps/server/src/services/threads/queued-messages.js";
import { attemptDispatch } from "../../../apps/server/src/services/threads/dispatch-attempt.js";
import { completeNativeAdmission as completeAdmission, createNativeContinuationFixture as fixture, disposeNativeContinuationFixtures } from "./helpers/native-session-continuation.js";

afterEach(disposeNativeContinuationFixtures);
const textInput = (text: string) => [{ type: "text", text, mentions: [] }].map((input) => promptInputSchema.parse(input));
function acceptedHandoffs(harness: TestAppHarness, threadId: string, selectedText: string): string[] {
  const requestInput = z.object({ input: z.array(promptInputSchema) });
  const requested = harness.db.select({ data: events.data }).from(events).where(eq(events.threadId, threadId)).all().flatMap((row) => {
    const parsed = requestInput.safeParse(JSON.parse(row.data));
    return parsed.success ? parsed.data.input : [];
  }).flatMap((input) => input.type === "text" && input.text.includes(selectedText) ? [selectedText] : []);
  if (requested.length) return requested;
  return harness.db.select({ content: queuedThreadMessages.content }).from(queuedThreadMessages).where(eq(queuedThreadMessages.threadId, threadId)).all().flatMap((row) => z.array(promptInputSchema).parse(JSON.parse(row.content))).flatMap((input) => input.type === "text" && input.text.includes(selectedText) ? [selectedText] : []);
}
function allocatedHandoff(saved: Awaited<ReturnType<typeof fixture>>) {
  return createThread(saved.harness.db, saved.harness.hub, { projectId: saved.project.id, environmentId: saved.environment.id, providerId: "codex", title: "Synthetic allocated handoff", status: "pending", originPluginId: "native-history-handoff", pluginMetadata: { pluginId: "native-history-handoff", metadata: { importId: saved.manifest.id, archiveThreadId: saved.manifest.threadId } } });
}

describe("reviewed native admission transitions", () => {
  it("retains explicitly admitted model and permissions instead of project defaults on the next ordinary turn", async () => {
    const saved = await fixture();
    upsertProjectExecutionDefaults(saved.harness.db, { projectId: saved.project.id, providerId: "codex", model: "different-project-model", reasoningLevel: "medium", serviceTier: "default", permissionMode: "full" });
    const admitted = await completeAdmission(saved, saved.request, { admitted: true, providerThreadId: saved.nativeId });
    expect(admitted.mode).toBe("native-admitted");
    const plan = await resolveExistingThreadExecutionPlan(saved.harness.deps, { threadId: admitted.threadId!, input: {}, executionSource: "client/turn/requested" });
    expect(plan.resolvedExecution).toMatchObject({ model: saved.request.model, permissionMode: "accept-edits" });
  });

  it("retains an admitted model even when there is no project fallback model", async () => {
    const saved = await fixture();
    const admitted = await completeAdmission(saved, saved.request, { admitted: true, providerThreadId: saved.nativeId });
    const plan = await resolveExistingThreadExecutionPlan(saved.harness.deps, { threadId: admitted.threadId!, input: {}, executionSource: "client/turn/requested" });
    expect(plan.resolvedExecution).toMatchObject({ model: saved.request.model, permissionMode: "accept-edits" });
  });

  it("permits correcting a context/account after a definitive admission refusal", async () => {
    const saved = await fixture();
    const context = saveExecutionContext(saved.harness.db, executionContextSchema.parse({ id: "synthetic-refused-context", name: "Synthetic refused context", projectIds: [saved.project.id], instructions: "Synthetic context instructions", createdAt: 1, updatedAt: 1 }));
    const attempted = { ...saved.request, executionContextId: context.id };
    const refused = await completeAdmission(saved, attempted, { admitted: false, reason: "Synthetic provider does not support this explicit context" });
    expect(refused.mode).toBe("archive");
    const replacement = saveModelConnection(saved.harness.db, modelConnectionSchema.parse({ ...saved.connection, id: "synthetic-corrected-connection", name: "Corrected explicit account" }));
    const corrected = await completeAdmission(saved, { ...saved.request, modelConnectionId: replacement.id }, { admitted: true, providerThreadId: saved.nativeId });
    expect(corrected.mode).toBe("native-admitted");
    expect(getThreadExecutionBinding(saved.harness.db, corrected.threadId!)).toMatchObject({ executionContext: null, modelConnection: { id: replacement.id } });
  });

  it("reports archive-only and blocks writes after a previously admitted runtime is definitively refused", async () => {
    const saved = await fixture();
    await completeAdmission(saved, saved.request, { admitted: true, providerThreadId: saved.nativeId });
    const refused = await completeAdmission(saved, saved.request, { admitted: false, reason: "Synthetic provider ownership can no longer be established" });
    expect(refused.mode).toBe("archive");
    expect(() => assertNativeHistoryWritable(saved.harness.db, refused.threadId!)).toThrow();
  });
});

describe("reviewed handoff acceptance recovery", () => {
  it("does not treat allocation before first-input acceptance as a completed handoff", async () => {
    const saved = await fixture();
    const allocated = allocatedHandoff(saved);
    const input = "User-selected handoff context that must be durably accepted";
    const recovered = await createNativeSessionHandoff(saved.harness.deps, saved.imports, { ...saved.request, input });
    expect(recovered.continuationThreadId).toBe(allocated.id);
    expect(acceptedHandoffs(saved.harness, allocated.id, input)).toEqual([input]);
  });

  it("does not recover a deleted handoff allocation as completed", async () => {
    const saved = await fixture();
    const deleted = allocatedHandoff(saved);
    markThreadDeleted(saved.harness.db, saved.harness.hub, { threadId: deleted.id });
    const result = await createNativeSessionHandoff(saved.harness.deps, saved.imports, { ...saved.request, input: "Recover only a live accepted dialogue" });
    const thread = result.continuationThreadId === null ? null : getThread(saved.harness.db, result.continuationThreadId);
    expect(thread).toMatchObject({ deletedAt: null });
  });

  it("recovers a durably accepted handoff after a lost acknowledgement exactly once", async () => {
    const saved = await fixture();
    const input = "Selected handoff context across a lost acknowledgement";
    const accepted = await createNativeSessionHandoff(saved.harness.deps, saved.imports, { ...saved.request, input });
    expect(accepted.continuationThreadId).not.toBeNull();
    expect(acceptedHandoffs(saved.harness, accepted.continuationThreadId!, input)).toEqual([input]);
    await saved.imports.updateMode({ ...saved.manifest, mode: "archive", continuationThreadId: null });
    const recovered = await createNativeSessionHandoff(saved.harness.deps, saved.imports, { ...saved.request, input });
    expect(recovered.continuationThreadId).toBe(accepted.continuationThreadId);
    expect(acceptedHandoffs(saved.harness, recovered.continuationThreadId!, input)).toEqual([input]);
  });
});

describe("reviewed archive-only write acceptance", () => {
  it.each(["explicit queue", "future schedule"] as const)("rejects %s before any pending input is persisted", async (surface) => {
    const saved = await fixture();
    const thread = getThread(saved.harness.db, saved.manifest.threadId!);
    if (!thread) throw new Error("Synthetic archive thread missing");
    const input = textInput("Must not become live input on a historical archive");
    const payload = { input, model: saved.request.model, permissionMode: saved.request.permissionMode };
    const pending = surface === "explicit queue"
      ? createQueuedMessageForThread(saved.harness.deps, { thread, payload: createQueuedMessageRequestSchema.parse(payload) })
      : attemptDispatch(saved.harness.deps, { thread, payload: sendMessageRequestSchema.parse({ ...payload, mode: "auto", sendAt: Date.now() + 60_000 }), source: { kind: "inline" }, queuePayload: { kind: "inline" }, pluginSubmission: null, origin: null, originPluginId: null, startedOnBehalfOf: null, trigger: "user" });
    await expect(pending).rejects.toMatchObject({ status: 409 });
    expect(saved.harness.db.select().from(queuedThreadMessages).where(eq(queuedThreadMessages.threadId, thread.id)).all()).toEqual([]);
  });
});
