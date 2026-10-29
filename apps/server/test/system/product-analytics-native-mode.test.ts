import { createConnection, getThread, listEvents, listQueuedThreadMessages, productAnalyticsEvents } from "@bb/db";
import { groupHostDaemonEvents } from "@bb/host-daemon-contract";
import { turnScope } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/server.js";
import { createLifecycleDedupers } from "../../src/lifecycle-dedupers.js";
import { applyLoggedThreadLifecycleEvent } from "../../src/services/threads/lifecycle-outcome.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { initializePrivateProductAnalytics } from "../../src/services/system/product-analytics.js";
import { observeAnalyticsTurn } from "../../src/services/system/product-analytics-turns.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import { consumerReport, consumerSdk, withAnalyticsConsumer } from "../helpers/product-analytics-consumer.js";
import { seedThread, seedThreadRuntimeState } from "../helpers/seed.js";

describe("analytics native explicit smoke mode", () => {
  it("keeps a smoke request and its native turn out of production across collector restart", async () => {
    await withAnalyticsConsumer(async ({ harness, collector, session, work, environment }) => {
      const thread = seedThread(harness.deps, { projectId: work.id, environmentId: environment.id, status: "idle" });
      const providerThreadId = "owned-mode-provider-thread";
      seedThreadRuntimeState(harness.deps, { threadId: thread.id, environmentId: environment.id, providerThreadId });
      const sdk = consumerSdk(harness, { actorKind: "agent", surface: "sdk", mode: "smoke", intentional: true, projectId: work.id });
      expect(await sdk.threads.send({ threadId: thread.id, input: [{ type: "text", text: "owned mode regression", mentions: [] }], mode: "start", model: "gpt-5", permissionMode: "full", reasoningLevel: "medium", serviceTier: "default" })).toMatchObject({ delivery: "sent" });
      const started = await harness.app.request("/internal/session/events", { method: "POST", headers: internalAuthHeaders(harness), body: JSON.stringify({ sessionId: session.id, eventGroups: groupHostDaemonEvents([{ threadId: thread.id, event: { type: "turn/started", threadId: thread.id, providerThreadId, scope: turnScope("owned-mode-turn") } }]) }) });
      expect(started.status).toBe(200);
      expect(await sdk.threads.get({ threadId: thread.id })).toMatchObject({ id: thread.id, status: "active" });
      collector.flush();
      collector.stop();
      const reopened = createConnection(harness.db.$client.serialize());
      const afterRestart = initializePrivateProductAnalytics({ db: reopened, release: harness.config.appVersion, mode: "production", logger: harness.deps.logger });
      try {
        observeAnalyticsTurn({ ...harness.deps, db: reopened }, thread.id, "owned-mode-turn", { stage: "completed", status: "completed" });
        const smoke = consumerReport(afterRestart, work.id, "smoke");
        expect(smoke.rows.find((row) => row.featureId === "core.execution" && row.action === "turn")).toMatchObject({ attempts: 1, successes: 1, failures: 0, system: 1 });
        expect(consumerReport(afterRestart, work.id, "production").rows.find((row) => row.featureId === "core.execution" && row.action === "turn")).toMatchObject({ attempts: 0, successes: 0, lastUsedAt: null });
      } finally {
        afterRestart.stop();
        reopened.$client.close();
      }
    });
  });
});

describe("analytics queued native restart provenance", () => {
  it("retains smoke mode through queued admission and restart before automatic dispatch, while production work remains production", async () => {
    await withAnalyticsConsumer(async ({ harness, collector, session, work, personal, environment }) => {
      const scenarios = (["production", "smoke"] as const).map((mode) => {
        const thread = seedThread(harness.deps, { projectId: work.id, environmentId: environment.id, status: "active" });
        const providerThreadId = `owned-queued-${mode}-provider`;
        seedThreadRuntimeState(harness.deps, { threadId: thread.id, environmentId: environment.id, providerThreadId });
        return { mode, thread, providerThreadId, privatePrompt: `owned queued ${mode} prompt excluded from analytics` };
      });
      for (const { mode, thread, privatePrompt } of scenarios) {
        const sdk = consumerSdk(harness, { actorKind: "agent", surface: "sdk", mode, intentional: true, projectId: work.id });
        expect(await sdk.threads.send({ threadId: thread.id, input: [{ type: "text", text: privatePrompt, mentions: [] }], mode: "queue-if-active", model: "gpt-5", permissionMode: "full", reasoningLevel: "medium", serviceTier: "default" })).toMatchObject({ delivery: "queued" });
        expect(listQueuedThreadMessages(harness.db, thread.id).map((row) => row.threadId)).toEqual([thread.id]);
        expect(listEvents(harness.db, { threadId: thread.id }).filter((event) => event.type === "client/turn/requested")).toEqual([]);
        const admission = consumerReport(collector, work.id, mode);
        expect(admission.rows.find((row) => row.featureId === "core.threads" && row.action === "send")).toMatchObject({ attempts: 1, accepted: 1, successes: 0, agent: 1 });
        expect(admission.rows.find((row) => row.featureId === "core.execution" && row.action === "turn")).toMatchObject({ attempts: 0, successes: 0, lastUsedAt: null });
      }
      const queuedIds = scenarios.map(({ thread }) => listQueuedThreadMessages(harness.db, thread.id).map((row) => row.id));
      collector.flush();
      collector.stop();
      await harness.pluginService.stop();
      const reopened = createConnection(harness.db.$client.serialize());
      const restartedDeps = { ...harness.deps, db: reopened, lifecycleDedupers: createLifecycleDedupers() };
      const afterRestart = initializePrivateProductAnalytics({ db: reopened, release: harness.config.appVersion, mode: "production", logger: harness.deps.logger });
      const restarted = createApp(restartedDeps);
      try {
        expect(scenarios.map(({ thread }) => listQueuedThreadMessages(reopened, thread.id).map((row) => row.id))).toEqual(queuedIds);
        for (const { thread } of scenarios) applyLoggedThreadLifecycleEvent(restartedDeps, { event: { type: "run.succeeded" }, threadId: thread.id });
        await runQueuedMessageDispatch(restartedDeps, { kind: "idle-recovery", now: Date.now() });
        for (const { mode, thread, providerThreadId, privatePrompt } of scenarios) {
          expect(listQueuedThreadMessages(reopened, thread.id)).toEqual([]);
          expect(listEvents(reopened, { threadId: thread.id }).filter((event) => event.type === "client/turn/requested").map((event) => event.data)).toEqual([expect.stringContaining(privatePrompt)]);
          const scope = turnScope(`owned-queued-${mode}-turn`);
          const completed = await restarted.app.request("/internal/session/events", {
            method: "POST", headers: internalAuthHeaders(harness),
            body: JSON.stringify({ sessionId: session.id, eventGroups: groupHostDaemonEvents([
              { threadId: thread.id, event: { type: "turn/started", threadId: thread.id, providerThreadId, scope } },
              { threadId: thread.id, event: { type: "turn/completed", threadId: thread.id, providerThreadId, scope, status: "completed" } },
            ]) }),
          });
          expect(completed.status).toBe(200);
          await completed.arrayBuffer();
          expect(getThread(reopened, thread.id)).toMatchObject({ status: "idle" });
          expect(consumerReport(afterRestart, work.id, mode).rows.find((row) => row.featureId === "core.execution" && row.action === "turn")).toMatchObject({ attempts: 1, successes: 1, failures: 0, system: 1, agent: 0, human: 0 });
        }
        for (const mode of ["production", "smoke"] as const) {
          expect(consumerReport(afterRestart, work.id, mode).rows.find((row) => row.featureId === "core.execution" && row.action === "turn")).toMatchObject({ attempts: 1, successes: 1, system: 1 });
          expect(afterRestart.report({ days: 7, mode, projectId: work.id, surface: "system" }).rows.find((row) => row.featureId === "core.execution" && row.action === "turn")).toMatchObject({ attempts: 1, successes: 1 });
          for (const projectId of [personal.id, undefined]) expect(consumerReport(afterRestart, projectId, mode).rows.find((row) => row.featureId === "core.execution" && row.action === "turn")).toMatchObject({ attempts: 0, successes: 0, lastUsedAt: null });
        }
        const events = JSON.stringify(reopened.select().from(productAnalyticsEvents).all());
        for (const { privatePrompt } of scenarios) expect(events).not.toContain(privatePrompt);
      } finally {
        afterRestart.stop();
        await restarted.pluginService.stop();
        await restarted.closeWebSockets();
        reopened.$client.close();
      }
    });
  });
});
