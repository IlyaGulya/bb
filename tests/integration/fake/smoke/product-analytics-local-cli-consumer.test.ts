import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { productAnalyticsEvents } from "@bb/db";
import { experimental_productAnalyticsQueueKey } from "@bb/sdk/node";
import type { ProductAnalyticsEvent } from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { LocalProductAnalyticsStore } from "../../../../apps/cli/src/product-analytics-store.js";
import { consumerReport, installConsumerPlugin, withAnalyticsConsumer } from "../../../../apps/server/test/helpers/product-analytics-consumer.js";
import { analyticsCliEnvironment, withListeningAnalyticsCli } from "../../helpers/analytics-cli-process.js";

function backlog(projectId: string, operations: number): ProductAnalyticsEvent[] {
  return Array.from({ length: operations }, () => {
    const started: ProductAnalyticsEvent = { operationId: randomUUID(), featureId: "cli.local", action: "diagnostics.cli-errors", version: 1, scope: { kind: "project", projectId }, actorKind: "agent", actorSessionId: null, surface: "cli", mode: "smoke", stage: "started", outcome: "none", errorCode: "none", timestamp: Date.now(), durationMs: null };
    const completed: ProductAnalyticsEvent = { ...started, stage: "completed", outcome: "succeeded", durationMs: 10 };
    return [started, completed];
  }).flat();
}

describe("analytics actual local CLI reconnect", () => {
  it.each([{ label: "non-full reconnect control", operations: 1 }, { label: "full 500-envelope spool reconnect", operations: 250 }])("$label delivers old QA backlog through bb guide", async ({ operations }) => {
    await withAnalyticsConsumer(async ({ harness, collector, work, personal }) => withListeningAnalyticsCli(harness, async ({ baseUrl, start }) => {
      const dataDir = join(harness.config.dataDir, "owned-cli");
      const partition = createHash("sha256").update(baseUrl).digest("hex");
      const store = new LocalProductAnalyticsStore(join(dataDir, "private-product-analytics", partition));
      const events = backlog(work.id, operations);
      for (const event of events) expect(await store.enqueue({ id: experimental_productAnalyticsQueueKey(event), event })).toBe(true);
      await store.settle(events.map((event) => ({ id: experimental_productAnalyticsQueueKey(event), status: "retry" })));
      expect(await store.health()).toMatchObject({ pending: operations * 2, failed: operations * 2 });
      expect(consumerReport(collector, work.id, "smoke").rows.find((row) => row.featureId === "cli.local" && row.action === "diagnostics.cli-errors")).toMatchObject({ attempts: 0, successes: 0 });
      const env = analyticsCliEnvironment(baseUrl, dataDir);
      env.BB_PROJECT_ID = work.id;
      env.BB_PRODUCT_ANALYTICS_MODE = "smoke";
      const result = await start(["guide", "threads", "--json"], env).closed;
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ chapter: "threads" });
      const operationIds = events.map((event) => event.operationId);
      const committed = harness.db.select({ operationId: productAnalyticsEvents.operationId, stage: productAnalyticsEvents.stage, mode: productAnalyticsEvents.mode, actorKind: productAnalyticsEvents.actorKind, surface: productAnalyticsEvents.surface }).from(productAnalyticsEvents).where(and(eq(productAnalyticsEvents.featureId, "cli.local"), eq(productAnalyticsEvents.action, "diagnostics.cli-errors"), inArray(productAnalyticsEvents.operationId, operationIds))).all();
      expect(new Set(committed.map((event) => `${event.operationId}:${event.stage}:${event.mode}:${event.actorKind}:${event.surface}`))).toEqual(new Set(events.map((event) => `${event.operationId}:${event.stage}:smoke:agent:cli`)));
      expect(consumerReport(collector, work.id, "smoke").rows.find((row) => row.featureId === "cli.local" && row.action === "diagnostics.cli-errors")).toMatchObject({ attempts: operations, successes: operations, failures: 0, agent: operations });
      for (const [projectId, mode] of [[personal.id, "smoke"], [work.id, "production"]] as const) expect(consumerReport(collector, projectId, mode).rows.find((row) => row.featureId === "cli.local" && row.action === "diagnostics.cli-errors")).toMatchObject({ attempts: 0, successes: 0, lastUsedAt: null });
      const old = new Set(operationIds);
      expect((await store.batch()).some(({ event }) => old.has(event.operationId))).toBe(false);
    }));
  });
});

describe("analytics actual plugin dev admission", () => {
  it.each([{ admitted: false, label: "uninstalled startup failure", expected: "failed" }, { admitted: true, label: "admitted watcher stopped normally", expected: "cancelled" }] as const)("$label is $expected, not a successful build", async ({ admitted }) => {
    await withAnalyticsConsumer(async ({ harness, collector, work }) => withListeningAnalyticsCli(harness, async ({ baseUrl, start }) => {
      const installed = await installConsumerPlugin(harness, 'export default function plugin(bb) { bb.log.info("Owned watcher fixture loaded"); }');
      const uninstalled = join(harness.config.dataDir, "owned-uninstalled-plugin");
      await mkdir(uninstalled);
      for (const file of ["package.json", "server.ts"]) await writeFile(join(uninstalled, file), await readFile(join(installed.root, file)));
      const dataDir = join(harness.config.dataDir, "owned-cli");
      const env = analyticsCliEnvironment(baseUrl, dataDir);
      env.BB_PROJECT_ID = work.id;
      env.BB_PRODUCT_ANALYTICS_MODE = "smoke";
      const command = start(["plugin", "dev", admitted ? installed.root : uninstalled], env);
      if (admitted) {
        await command.waitForWatcher();
        expect(command.child.kill("SIGTERM")).toBe(true);
      }
      const result = await command.closed;
      expect(result.exitCode, result.stderr).toBe(admitted ? 0 : 1);
      const replay = await start(["guide", "threads", "--json"], env).closed;
      expect(replay.exitCode, replay.stderr).toBe(0);
      expect(JSON.parse(replay.stdout)).toMatchObject({ chapter: "threads" });
      expect(consumerReport(collector, work.id, "smoke").rows.find((row) => row.featureId === "cli.local" && row.action === "plugin.dev")).toMatchObject({ attempts: 1, successes: 0, failures: admitted ? 0 : 1, cancelled: admitted ? 1 : 0 });
      expect(consumerReport(collector, work.id, "production").rows.find((row) => row.featureId === "cli.local" && row.action === "plugin.dev")).toMatchObject({ attempts: 0, successes: 0, failures: 0, cancelled: 0, lastUsedAt: null });
    }));
  });
});
