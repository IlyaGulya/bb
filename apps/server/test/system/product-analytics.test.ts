import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { count } from "drizzle-orm";
import { getProject, productAnalyticsEvents } from "@bb/db";
import { createNodeBbSdk } from "@bb/sdk/node";
import { productAnalyticsAckSchema, publicApiRoutes, type ProductAnalyticsBatch, type ProductAnalyticsEvent } from "@bb/server-contract";
import { getPrivateProductAnalytics } from "../../src/services/system/product-analytics.js";
import { privateAnalyticsMiddleware } from "../../src/services/system/product-analytics-http.js";
import { observePluginAnalytics } from "../../src/services/system/product-analytics-plugin.js";
import { withTestHarness } from "../helpers/test-app.js";
import { seedHostSession, seedProjectWithSource } from "../helpers/seed.js";

function input(): ProductAnalyticsEvent {
  return { operationId: randomUUID(), featureId: "ui.compose", action: "open", version: 1, scope: { kind: "instance" }, actorKind: "agent", actorSessionId: null, surface: "sdk", mode: "test", stage: "started", outcome: "none", errorCode: "none", timestamp: Date.now(), durationMs: null };
}

describe("private analytics public contract", () => {
  it.each(["core", "http", "sdk"] as const)("deduplicates the same operation through %s admission and reports actual outcomes", async (surface) => {
    await withTestHarness(async (harness) => {
      const collector = getPrivateProductAnalytics(harness.db);
      const sdk = createNodeBbSdk({ baseUrl: "http://localhost", fetch: (url, init) => harness.app.request(String(url), init) });
      const send = async (batch: ProductAnalyticsBatch) => {
        if (surface === "core") return collector.admitBatch(batch.events);
        if (surface === "sdk") return sdk.experimental_productAnalytics.record(batch);
        const response = await harness.app.request("/api/v1/system/product-analytics/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(batch) });
        expect(response.status).toBe(200);
        return productAnalyticsAckSchema.parse(await response.json());
      };
      const started = input();
      const completed = { ...started, stage: "completed" as const, outcome: "denied" as const, errorCode: "forbidden" as const, durationMs: 600 };
      expect((await send({ events: [started, completed] })).receipts.map((receipt) => receipt.status)).toEqual(["accepted", "accepted"]);
      expect((await send({ events: [completed, started] })).receipts.map((receipt) => receipt.status)).toEqual(["duplicate", "duplicate"]);
      collector.flush();
      const report = await sdk.experimental_productAnalytics.report({ days: 7, mode: "test", surface: "sdk", actorKind: "agent" });
      expect(report.rows.find((row) => row.featureId === "ui.compose" && row.action === "open")).toMatchObject({ attempts: 1, denied: 1, successes: 0, agent: 1, averageDurationMs: 600 });
      expect((await sdk.experimental_productAnalytics.report({ days: 7, mode: "production" })).rows.find((row) => row.featureId === "ui.compose" && row.action === "open")).toMatchObject({ attempts: 0, successes: 0 });
    });
  });

  it("rejects sensitive wire fields and missing scopes without admitting an event", async () => {
    await withTestHarness(async (harness) => {
      const sensitive = "wire-prompt-and-auth-secret";
      const invalid = await harness.app.request("/api/v1/system/product-analytics/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [{ ...input(), properties: { prompt: sensitive, authorization: sensitive } }] }) });
      expect(invalid.status).toBe(400);
      expect(JSON.stringify(await invalid.json())).not.toContain(sensitive);
      const denied = await harness.app.request("/api/v1/system/product-analytics/report?projectId=proj_missing&mode=test");
      expect(denied.status).toBe(403);
      expect(harness.db.select({ value: count() }).from(productAnalyticsEvents).get()!.value).toBe(0);
    });
  });

  it("does not break a real Core update when collector admission fails", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      harness.db.$client.exec("CREATE TRIGGER analytics_admission_failure BEFORE INSERT ON product_analytics_events BEGIN SELECT RAISE(FAIL, 'collector unavailable'); END");
      const change = await harness.app.request(`/api/v1/projects/${project.id}`, { method: "PATCH", headers: { "content-type": "application/json", "x-bb-product-operation": randomUUID(), "x-bb-product-actor": "human", "x-bb-product-surface": "web", "x-bb-product-mode": "test" }, body: JSON.stringify({ name: "Changed while analytics is unavailable" }) });
      expect(change.status).toBe(200);
      expect(getProject(harness.db, project.id)?.name).toBe("Changed while analytics is unavailable");
      const collector = getPrivateProductAnalytics(harness.db);
      expect(collector.report({ days: 7, mode: "test", projectId: project.id }).diagnostics).toMatchObject({ pending: 0, failed: 2, gaps: 2, storage: "unavailable" });
      harness.db.$client.exec("DROP TRIGGER analytics_admission_failure");
      collector.flush();
      const recovered = await harness.app.request(`/api/v1/projects/${project.id}`, { method: "PATCH", headers: { "content-type": "application/json", "x-bb-product-operation": randomUUID(), "x-bb-product-actor": "human", "x-bb-product-surface": "web", "x-bb-product-mode": "test" }, body: JSON.stringify({ name: "Changed after collector recovery" }) });
      expect(recovered.status).toBe(200);
      collector.flush();
      expect(collector.report({ days: 7, mode: "test", projectId: project.id }).rows.find((row) => row.featureId === "core.projects" && row.action === "update")).toMatchObject({ attempts: 1, successes: 1, human: 1 });
    });
  });

  it.each([
    { status: 200, payload: { ok: false, error: "sensitive provider response" }, failures: 1, denied: 0, cancelled: 0, accepted: 0, successes: 0 },
    { status: 403, payload: { ok: true }, failures: 0, denied: 1, cancelled: 0, accepted: 0, successes: 0 },
    { status: 202, payload: { ok: true }, failures: 0, denied: 0, cancelled: 0, accepted: 1, successes: 0 },
    { status: 200, payload: { outcome: "cancelled" }, failures: 0, denied: 0, cancelled: 1, accepted: 0, successes: 0 },
    { status: 200, payload: { status: "failed", name: "An unrelated resource state" }, failures: 0, denied: 0, cancelled: 0, accepted: 0, successes: 1 },
  ] as const)("classifies semantic result $payload at HTTP $status without copying its payload", async (scenario) => {
    await withTestHarness(async (harness) => {
      const collector = getPrivateProductAnalytics(harness.db);
      const app = new Hono();
      app.use("*", privateAnalyticsMiddleware(harness.db, collector));
      app.post(publicApiRoutes.system.testAiService.path, (context) => context.json(scenario.payload, scenario.status));
      await app.request(publicApiRoutes.system.testAiService.path, { method: "POST", headers: { "x-bb-product-mode": "test", "x-bb-product-actor": "agent", "x-bb-product-surface": "sdk" } });
      collector.flush();
      expect(collector.report({ days: 7, mode: "test" }).rows.find((row) => row.featureId === "core.system" && row.action === "testAiService")).toMatchObject({ attempts: 1, failures: scenario.failures, denied: scenario.denied, cancelled: scenario.cancelled, accepted: scenario.accepted, successes: scenario.successes });
      expect(harness.db.$client.serialize().includes(Buffer.from("sensitive provider response"))).toBe(false);
    });
  });
  it("attributes an ordinary SDK mutation through a custom fetch without collecting its product payload", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const sdk = createNodeBbSdk({ baseUrl: "http://localhost", fetch: (url, init) => harness.app.request(url instanceof Request ? url.url : String(url), init) });
      const name = "private-product-name-not-an-analytics-property";
      await sdk.projects.update({ projectId: project.id, name });
      expect(getProject(harness.db, project.id)?.name).toBe(name);
      const collector = getPrivateProductAnalytics(harness.db);
      collector.flush();
      expect(collector.report({ days: 7, mode: "test", projectId: project.id, surface: "sdk" }).rows.find((row) => row.featureId === "core.projects" && row.action === "update")).toMatchObject({ attempts: 1, successes: 1, unknown: 1, human: 0 });
      expect(JSON.stringify(harness.db.select().from(productAnalyticsEvents).all())).not.toContain(name);
    });
  });

  it("does not confuse a plugin-domain project identifier with the Core project context", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const collector = getPrivateProductAnalytics(harness.db);
      const app = new Hono();
      app.use("*", privateAnalyticsMiddleware(harness.db, collector));
      app.post("/plugins/fixture/rpc/publish", async (context) => context.json(await observePluginAnalytics(collector, "fixture", "rpc.publish", async () => ({ ok: true }))));
      const response = await app.request("/plugins/fixture/rpc/publish", { method: "POST", headers: { "content-type": "application/json", "x-bb-product-project": project.id, "x-bb-product-actor": "agent", "x-bb-product-surface": "cli" }, body: JSON.stringify({ projectId: "01TASKDOMAINPROJECT", text: "private-plugin-input" }) });
      expect(response.status).toBe(200);
      collector.flush();
      expect(collector.report({ days: 7, mode: "test", projectId: project.id }).rows.find((row) => row.featureId === "plugin.fixture" && row.action === "rpc.publish")).toMatchObject({ attempts: 1, successes: 1, agent: 1 });
      expect(collector.report({ days: 7, mode: "test" }).rows.find((row) => row.featureId === "plugin.fixture" && row.action === "rpc.publish")?.attempts).toBe(0);
      expect(JSON.stringify(harness.db.select().from(productAnalyticsEvents).all())).not.toContain("private-plugin-input");
    });
  });

  it("keeps a new runtime route visibly uninstrumented instead of fabricating zero popularity", async () => {
    await withTestHarness(async (harness) => {
      const collector = getPrivateProductAnalytics(harness.db);
      const app = new Hono();
      app.use("*", privateAnalyticsMiddleware(harness.db, collector));
      app.post("/new-owned-feature", (context) => context.json({ ok: true }));
      collector.registerRouteGaps(app.routes);
      expect((await app.request("/new-owned-feature", { method: "POST" })).status).toBe(200);
      const row = collector.report({ days: 7, mode: "test" }).rows.find((row) => row.featureId === "core.uncatalogued" && row.entrypoints.includes("POST /new-owned-feature"))!;
      expect(row).toMatchObject({ coverage: "gap", availability: "unknown", attempts: 0 });
      expect(collector.admit({ ...input(), featureId: row.featureId, action: row.action }, "client")).toMatchObject({ status: "rejected", code: "unknown_feature" });
    });
  });
});
