import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { productAnalyticsEventSchema } from "@bb/server-contract";
import { productAnalyticsEvents } from "@bb/db";
import { and, eq } from "drizzle-orm";
import { clientCompletion, consumerReport, consumerSdk, installConsumerPlugin, withAnalyticsConsumer } from "../helpers/product-analytics-consumer.js";

function source(generation: string, authority: "client" | "server", body = "") {
  return `import { defineRpcContract, defineCli, cliCommand } from "@get-bb/plugin-sdk";
import { z } from "zod";
export default async function plugin(bb) {
  bb.experimental_productAnalytics.declareAction({ action: "local.finish", surfaces: ["web"], completionSource: ${JSON.stringify(authority)} });
  bb.rpc.register(defineRpcContract({ old: { input: z.object({}), output: z.object({ generation: z.string() }) } }), { old: () => ({ generation: ${JSON.stringify(generation)} }) });
  bb.http.route("POST", "/old", (context) => context.json({ generation: ${JSON.stringify(generation)} }), { auth: "none" });
  bb.cli.register(defineCli({ name: "consumer", summary: "Owned consumer", commands: { old: cliCommand({ summary: "Read live generation", run: async () => ({ exitCode: 0, stdout: ${JSON.stringify(generation)} }) }) } }));
  ${body}
}`;
}

afterEach(() => vi.unstubAllGlobals());

describe("analytics framework retirement", () => {
  it.each(["disable", "remove", "reload"] as const)("retires removed RPC HTTP and CLI identities after %s without losing committed history", async (transition) => {
    await withAnalyticsConsumer(async ({ harness, collector, work }) => {
      const { root, pluginId } = await installConsumerPlugin(harness, source("old", "client"));
      const operationId = randomUUID();
      const sdk = consumerSdk(harness, { actorKind: "human", surface: "web", mode: "production", intentional: true, projectId: work.id, operationId });
      expect(await sdk.plugins.callRpc({ pluginId, method: "old", input: {}, outputSchema: z.object({ generation: z.string() }) })).toEqual({ generation: "old" });
      const headers = { "content-type": "application/json", "x-bb-product-project": work.id, "x-bb-product-intent": "use", "x-bb-product-actor": "human", "x-bb-product-surface": "web" };
      const http = await harness.app.request(`/api/v1/plugins/${pluginId}/http/old`, { method: "POST", headers, body: "{}" });
      expect(await http.json()).toEqual({ generation: "old" });
      const cli = await harness.app.request(`/api/v1/plugins/${pluginId}/cli`, { method: "POST", headers, body: JSON.stringify({ argv: ["old"], projectId: work.id }) });
      expect(await cli.json()).toMatchObject({ exitCode: 0, stdout: "old" });
      const initial = consumerReport(collector, work.id).rows.filter((row) => row.featureId === `plugin.${pluginId}` && row.attempts > 0);
      for (const prefix of ["rpc.", "http.", "cli."]) expect(initial.find((row) => row.action.startsWith(prefix))).toMatchObject({ availability: "available", attempts: 1, successes: 1 });
      const committed = harness.db.select().from(productAnalyticsEvents).where(and(eq(productAnalyticsEvents.operationId, operationId), eq(productAnalyticsEvents.featureId, `plugin.${pluginId}`), eq(productAnalyticsEvents.action, "rpc.old"), eq(productAnalyticsEvents.stage, "completed"))).get();
      if (!committed) throw new Error("Actual RPC did not commit its lifecycle envelope");
      const { id: _id, release: _release, admittedAt: _admittedAt, projectedAt: _projectedAt, ...wire } = committed;
      const replay = productAnalyticsEventSchema.parse({ ...wire, scope: { kind: "project", projectId: work.id } });
      if (transition === "disable") await harness.pluginService.setEnabled(pluginId, false);
      else if (transition === "remove") expect(await harness.pluginService.remove(pluginId)).toBe(true);
      else {
        await writeFile(join(root, "server.ts"), "export default function plugin() {}\n");
        expect(await harness.pluginService.reload(pluginId)).toMatchObject({ ok: true });
      }
      const missing = await harness.app.request(`/api/v1/plugins/${pluginId}/http/old`, { method: "POST", headers, body: "{}" });
      expect(missing.status).toBeGreaterThanOrEqual(400);
      const retired = consumerReport(collector, work.id);
      for (const previous of initial) expect(retired.rows.find((row) => row.featureId === previous.featureId && row.action === previous.action)).toMatchObject({ availability: "unavailable", attempts: 1, successes: 1 });
      expect((await sdk.experimental_productAnalytics.record({ events: [replay] })).receipts[0]).toMatchObject({ status: "duplicate", code: "none" });
      expect(collector.admit({ ...replay, operationId: randomUUID() }, "server")).toMatchObject({ status: "rejected", code: "unknown_feature" });
      expect(consumerReport(collector, work.id).rows.find((row) => row.featureId === replay.featureId && row.action === replay.action)).toMatchObject({ attempts: 1, successes: 1 });
    });
  });
});

describe("analytics declaration generation ownership", () => {
  it("does not let an unactivated replacement grant client completion authority", async () => {
    await withAnalyticsConsumer(async ({ harness, collector, work }) => {
      const { root, pluginId } = await installConsumerPlugin(harness, source("old", "server"));
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      vi.stubGlobal("__ownedAnalyticsCandidateGate", gate);
      vi.stubGlobal("__ownedAnalyticsCandidateEntered", entered);
      await writeFile(join(root, "server.ts"), source("new", "client", "globalThis.__ownedAnalyticsCandidateEntered(); await globalThis.__ownedAnalyticsCandidateGate;"));
      const reloading = harness.pluginService.reload(pluginId);
      try {
        await ready;
        expect(collector.admit({ ...clientCompletion("local.finish", randomUUID(), work.id), featureId: `plugin.${pluginId}` }, "client")).toMatchObject({ status: "rejected", code: "server_authoritative" });
      } finally {
        release();
        await reloading;
      }
    });
  });

  it("keeps successful replacement authority live after the old generation is disposed", async () => {
    await withAnalyticsConsumer(async ({ harness, collector, work }) => {
      const { root, pluginId } = await installConsumerPlugin(harness, source("old", "client"));
      const first = { ...clientCompletion("local.finish", randomUUID(), work.id), featureId: `plugin.${pluginId}` };
      expect(collector.admit(first, "client")).toMatchObject({ status: "accepted" });
      await writeFile(join(root, "server.ts"), source("new", "client"));
      expect(await harness.pluginService.reload(pluginId)).toMatchObject({ ok: true });
      const sdk = consumerSdk(harness, { actorKind: "agent", surface: "sdk", projectId: work.id });
      expect(await sdk.plugins.callRpc({ pluginId, method: "old", input: {}, outputSchema: z.object({ generation: z.string() }) })).toEqual({ generation: "new" });
      expect(collector.admit({ ...first, operationId: randomUUID() }, "client")).toMatchObject({ status: "accepted" });
      expect(consumerReport(collector, work.id).rows.find((row) => row.featureId === first.featureId && row.action === first.action)).toMatchObject({ availability: "available", successes: 2 });
    });
  });

  it("does not leave failed-candidate authority or new identities behind", async () => {
    await withAnalyticsConsumer(async ({ harness, collector, work }) => {
      const { root, pluginId } = await installConsumerPlugin(harness, source("old", "server"));
      await writeFile(join(root, "server.ts"), source("failed", "client", 'bb.experimental_productAnalytics.declareAction({ action: "local.failed-only", surfaces: ["web"], completionSource: "client" }); throw new Error("owned candidate rejected");'));
      expect(await harness.pluginService.reload(pluginId)).toMatchObject({ ok: false });
      const sdk = consumerSdk(harness, { actorKind: "agent", surface: "sdk", projectId: work.id });
      expect(await sdk.plugins.callRpc({ pluginId, method: "old", input: {}, outputSchema: z.object({ generation: z.string() }) })).toEqual({ generation: "old" });
      expect(collector.admit({ ...clientCompletion("local.finish", randomUUID(), work.id), featureId: `plugin.${pluginId}` }, "client")).toMatchObject({ status: "rejected", code: "server_authoritative" });
      expect(collector.admit({ ...clientCompletion("local.failed-only", randomUUID(), work.id), featureId: `plugin.${pluginId}` }, "client")).toMatchObject({ status: "rejected", code: "unknown_feature" });
    });
  });
});
