import { createConnection } from "@bb/db";
import { groupHostDaemonEvents } from "@bb/host-daemon-contract";
import { turnScope } from "@bb/domain";
import { describe, expect, it } from "vitest";
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
