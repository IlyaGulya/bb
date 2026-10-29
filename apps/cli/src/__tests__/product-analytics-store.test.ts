import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ExperimentalProductAnalyticsOperation, ExperimentalProductAnalyticsOutbox, experimental_productAnalyticsQueueKey } from "@bb/sdk/node";
import type { ProductAnalyticsEvent } from "@bb/server-contract";
import { LocalProductAnalyticsStore } from "../product-analytics-store.js";

function event(projectId: string): ProductAnalyticsEvent {
  return { operationId: randomUUID(), featureId: "cli.local", action: "guide", version: 1, scope: { kind: "project", projectId }, actorKind: "agent", actorSessionId: null, surface: "cli", mode: "smoke", stage: "started", outcome: "none", errorCode: "none", timestamp: Date.now(), durationMs: null };
}

describe("local analytics durable consumer", () => {
  it("retains the initiating project and QA plane when a caller mutates its input before completion", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-private-analytics-"));
    try {
      const identity = event("proj_work");
      const store = new LocalProductAnalyticsStore(directory);
      const outbox = new ExperimentalProductAnalyticsOutbox(store, async () => { throw new Error("offline"); });
      const operation = new ExperimentalProductAnalyticsOperation(outbox, identity);
      identity.mode = "production";
      if (identity.scope.kind === "project") identity.scope.projectId = "proj_personal";
      await operation.complete();
      expect(await operation.complete("failed", "internal")).toBe(false);
      await outbox.flush();
      const persisted = await new LocalProductAnalyticsStore(directory).batch();
      expect(persisted.map(({ event }) => ({ stage: event.stage, scope: event.scope, mode: event.mode, outcome: event.outcome })).sort((a, b) => a.stage.localeCompare(b.stage))).toEqual([
        { stage: "completed", scope: { kind: "project", projectId: "proj_work" }, mode: "smoke", outcome: "succeeded" },
        { stage: "started", scope: { kind: "project", projectId: "proj_work" }, mode: "smoke", outcome: "none" },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("keeps offline QA envelopes across store restart and rejects payload extensions before disk admission", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-private-analytics-"));
    try {
      const pending = event("proj_work");
      const outbox = new ExperimentalProductAnalyticsOutbox(new LocalProductAnalyticsStore(directory), async () => { throw new Error("offline"); });
      expect(await outbox.record(pending)).toBe(true);
      await outbox.flush();
      const invalid = { ...event("proj_personal"), payload: "must-not-be-collected" };
      expect(await outbox.record(invalid)).toBe(false);
      const restarted = new LocalProductAnalyticsStore(directory);
      expect((await restarted.batch()).map(({ event }) => ({ operationId: event.operationId, scope: event.scope, mode: event.mode, actorKind: event.actorKind }))).toEqual([{ operationId: pending.operationId, scope: { kind: "project", projectId: "proj_work" }, mode: "smoke", actorKind: "agent" }]);
      expect(await restarted.health()).toMatchObject({ pending: 1, failed: 1, storage: "healthy" });
      await restarted.settle([{ id: experimental_productAnalyticsQueueKey(pending), status: "duplicate" }]);
      expect(await restarted.batch()).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("does not remove another scope or a later action when an old committed receipt is replayed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-private-analytics-"));
    try {
      const store = new LocalProductAnalyticsStore(directory);
      const first = event("proj_work");
      const second = event("proj_personal");
      const firstId = experimental_productAnalyticsQueueKey(first);
      const secondId = experimental_productAnalyticsQueueKey(second);
      await store.enqueue({ id: firstId, event: first });
      await store.enqueue({ id: secondId, event: second });
      await store.settle([{ id: firstId, status: "accepted" }]);
      const third = event("proj_work");
      await store.enqueue({ id: experimental_productAnalyticsQueueKey(third), event: third });
      await store.settle([{ id: firstId, status: "accepted" }]);
      expect(new Set((await new LocalProductAnalyticsStore(directory).batch()).map(({ event }) => event.operationId))).toEqual(new Set([second.operationId, third.operationId]));
      await store.settle([{ id: secondId, status: "rejected" }]);
      expect((await store.batch()).map(({ event }) => event.operationId)).toEqual([third.operationId]);
      expect(await store.health()).toMatchObject({ pending: 1, gaps: 1 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
