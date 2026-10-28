import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { count } from "drizzle-orm";
import { createConnection, createProject, ensurePersonalProject, getProject, noopNotifier, productAnalyticsEvents, upsertHost, type DbConnection } from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import { productAnalyticsEventSchema, type ProductAnalyticsEvent, type ProductAnalyticsReportQuery } from "@bb/server-contract";
import { ANALYTICS_MAX_PENDING, ANALYTICS_RETENTION_MS, PrivateProductAnalytics, runWithProductAnalytics } from "../../src/services/system/product-analytics.js";
import { observePluginAnalytics } from "../../src/services/system/product-analytics-plugin.js";
import { declarePluginAnalyticsAction } from "../../src/services/system/product-analytics-declaration.js";

const NOW = Date.UTC(2026, 9, 28, 12);
const databases: DbConnection[] = [];
function database(): DbConnection {
  const db = createMigratedConnection();
  ensurePersonalProject(db);
  databases.push(db);
  return db;
}
function logger() { return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }; }
function service(db: DbConnection, mode: "production" | "preview" = "production") { return new PrivateProductAnalytics(db, "analytics-contract-release", mode, logger()); }
function event(overrides: Partial<ProductAnalyticsEvent> = {}): ProductAnalyticsEvent {
  return { operationId: randomUUID(), featureId: "core.projects", action: "update", version: 1, scope: { kind: "instance" }, actorKind: "human", actorSessionId: "11111111-1111-4111-a111-111111111111", surface: "web", mode: "production", stage: "started", outcome: "none", errorCode: "none", timestamp: NOW, durationMs: null, ...overrides };
}
function report(overrides: Partial<ProductAnalyticsReportQuery> = {}): ProductAnalyticsReportQuery { return { days: 7, mode: "production", ...overrides }; }
function row(collector: PrivateProductAnalytics, query = report()) { return collector.report(query, NOW).rows.find((row) => row.featureId === "core.projects" && row.action === "update")!; }
function project(db: DbConnection, name: string) {
  const host = upsertHost(db, noopNotifier, { name: "Analytics fixture host" });
  return createProject(db, noopNotifier, { name, source: { type: "local_path", hostId: host.id, path: `/fixture/${name}` } }).project;
}
afterEach(() => { for (const db of databases.splice(0)) db.$client.close(); });

describe("private product analytics admission", () => {
  it("rejects sensitive properties and unknown actions without persisting them", () => {
    const db = database();
    const collector = service(db);
    const sensitive = "never-store-this-prompt-or-credential";
    const unsafe = { ...event(), properties: { prompt: sensitive, headers: { authorization: sensitive }, path: sensitive } };
    expect(collector.admit(unsafe, "client", NOW)).toMatchObject({ status: "rejected", code: "invalid" });
    expect(collector.admit(event({ action: "undeclared-secret" }), "client", NOW)).toMatchObject({ status: "rejected", code: "unknown_feature" });
    expect(productAnalyticsEventSchema.safeParse({ ...event(), version: 2 }).success).toBe(false);
    expect(productAnalyticsEventSchema.safeParse({ ...event(), errorCode: sensitive }).success).toBe(false);
    expect(db.select({ value: count() }).from(productAnalyticsEvents).get()!.value).toBe(0);
    expect(db.$client.serialize().includes(Buffer.from(sensitive))).toBe(false);
  });

  it("ACKs committed admission, survives a database reopen and counts a replay once", () => {
    const db = database();
    const first = service(db);
    const input = event();
    expect(first.admit(input, "server", NOW).status).toBe("accepted");
    expect(first.report(report(), NOW).diagnostics.pending).toBe(1);
    expect(row(first).attempts).toBe(0);
    const reopened = createConnection(db.$client.serialize());
    databases.push(reopened);
    const restarted = service(reopened);
    expect(restarted.admit(input, "server", NOW).status).toBe("duplicate");
    restarted.flush(NOW);
    expect(row(restarted)).toMatchObject({ attempts: 1, human: 1, agent: 0, successes: 0 });
    expect(restarted.report(report(), NOW).diagnostics.pending).toBe(0);
    expect(restarted.report(report(), NOW).instanceId).toBe(first.report(report(), NOW).instanceId);
  });

  it("never ACKs a caller's uncommitted transaction", () => {
    const db = database();
    const collector = service(db);
    db.transaction(() => {
      expect(collector.admit(event(), "server", NOW)).toMatchObject({ status: "retry", code: "storage_unavailable" });
    });
    expect(row(collector).attempts).toBe(0);
    expect(collector.report(report(), NOW).diagnostics.gaps).toBe(1);
  });

  it("keeps QA attribution immutable across a promotion and late completion", () => {
    const db = database();
    const preview = service(db, "preview");
    const input = event();
    expect(preview.admit(input, "server", NOW).status).toBe("accepted");
    const production = service(db);
    expect(production.admit(input, "server", NOW).status).toBe("duplicate");
    expect(production.admit({ ...input, stage: "completed", outcome: "succeeded", durationMs: 400 }, "server", NOW).status).toBe("accepted");
    production.flush(NOW);
    expect(row(production)).toMatchObject({ attempts: 0, successes: 0 });
    expect(row(production, report({ mode: "preview" }))).toMatchObject({ attempts: 1, successes: 1, human: 1, averageDurationMs: 400 });
  });

  it("does not accept a fabricated client execution success", () => {
    const collector = service(database());
    expect(collector.admit(event({ featureId: "core.execution", action: "turn", stage: "completed", outcome: "succeeded" }), "client", NOW)).toMatchObject({ status: "rejected", code: "server_authoritative" });
    expect(collector.admit(event({ stage: "completed", outcome: "succeeded" }), "client", NOW)).toMatchObject({ status: "rejected", code: "server_authoritative" });
  });

  it("isolates logical projects and filters actor, QA, surface and release", () => {
    const db = database();
    const work = project(db, "Work");
    const personal = project(db, "Personal");
    const collector = service(db);
    for (const input of [
      event({ scope: { kind: "project", projectId: work.id } }),
      event({ scope: { kind: "project", projectId: personal.id }, actorKind: "agent", surface: "cli" }),
      event({ scope: { kind: "project", projectId: work.id }, actorKind: "agent", surface: "sdk", mode: "smoke" }),
    ]) expect(collector.admit(input, "server", NOW).status).toBe("accepted");
    collector.flush(NOW);
    expect(row(collector).attempts).toBe(0);
    expect(row(collector, report({ projectId: work.id }))).toMatchObject({ attempts: 1, human: 1, agent: 0 });
    expect(row(collector, report({ projectId: personal.id, actorKind: "agent", surface: "cli" }))).toMatchObject({ attempts: 1, human: 0, agent: 1 });
    expect(row(collector, report({ projectId: work.id, mode: "smoke", surface: "sdk" }))).toMatchObject({ attempts: 1, agent: 1 });
    expect(row(collector, report({ projectId: work.id, release: "other-release" })).attempts).toBe(0);
    expect(collector.admit(event({ scope: { kind: "project", projectId: "proj_missing" } }), "server", NOW)).toMatchObject({ status: "rejected", code: "scope_denied" });
    expect(() => collector.report(report({ projectId: "proj_missing" }), NOW)).toThrow("Analytics scope is not available");
    const sessions = db.select({ scope: productAnalyticsEvents.scope, session: productAnalyticsEvents.actorSessionId }).from(productAnalyticsEvents).all();
    expect(new Set(sessions.map((entry) => entry.session)).size).toBe(2);
    expect(sessions.every((entry) => entry.session !== "11111111-1111-4111-a111-111111111111")).toBe(true);
  });

  it("preserves terminal failure, distinguishes accepted work and measures reuse", () => {
    const collector = service(database());
    const first = event();
    const second = event();
    for (const input of [first, second]) collector.admit(input, "server", NOW);
    collector.admit({ ...first, stage: "completed", outcome: "denied", errorCode: "forbidden", durationMs: 200 }, "server", NOW);
    expect(collector.admit({ ...first, stage: "completed", outcome: "succeeded", errorCode: "none" }, "server", NOW).status).toBe("duplicate");
    collector.admit({ ...second, stage: "completed", outcome: "accepted", durationMs: 400 }, "server", NOW);
    collector.flush(NOW);
    expect(row(collector)).toMatchObject({ attempts: 2, successes: 0, denied: 1, accepted: 1, repeatActors: 1, averageDurationMs: 300, lastUsedAt: NOW });
  });

  it("retains pending admission through a failed projection and retries without inflation", () => {
    const db = database();
    const collector = service(db);
    const input = event();
    collector.admit(input, "server", NOW);
    db.$client.exec("CREATE TRIGGER analytics_projection_failure BEFORE UPDATE OF projected_at ON product_analytics_events BEGIN SELECT RAISE(FAIL, 'private diagnostic must not escape'); END");
    collector.flush(NOW);
    expect(collector.report(report(), NOW).diagnostics).toMatchObject({ pending: 1, storage: "unavailable" });
    expect(row(collector).attempts).toBe(0);
    db.$client.exec("DROP TRIGGER analytics_projection_failure");
    collector.flush(NOW);
    collector.flush(NOW);
    expect(row(collector).attempts).toBe(1);
    expect(collector.admit(input, "server", NOW).status).toBe("duplicate");
  });

  it("bounds admission, retains duplicates at capacity and exposes delivery gaps", () => {
    const db = database();
    const collector = service(db);
    const input = event();
    collector.admit(input, "server", NOW);
    const template = db.select().from(productAnalyticsEvents).get()!;
    db.transaction(() => {
      for (let index = 1; index < ANALYTICS_MAX_PENDING; index++) {
        db.insert(productAnalyticsEvents).values({ ...template, id: createHash("sha256").update(`capacity-${index}`).digest("hex"), operationId: `00000000-0000-4000-a000-${String(index).padStart(12, "0")}` }).run();
      }
    });
    expect(collector.admit(event(), "server", NOW)).toMatchObject({ status: "retry", code: "queue_full" });
    expect(collector.admit(input, "server", NOW).status).toBe("duplicate");
    expect(collector.report(report(), NOW).diagnostics).toMatchObject({ pending: ANALYTICS_MAX_PENDING, gaps: 1 });
    collector.flush(NOW);
    expect(collector.admit(event(), "server", NOW).status).toBe("accepted");
  });

  it("expires retained events, rejects expired replay and retains honest health diagnostics", () => {
    const db = database();
    const collector = service(db);
    const input = event();
    collector.admit(input, "server", NOW);
    collector.flush(NOW + ANALYTICS_RETENTION_MS + 1);
    expect(db.select({ value: count() }).from(productAnalyticsEvents).get()!.value).toBe(0);
    expect(collector.admit(input, "server", NOW + ANALYTICS_RETENTION_MS + 1)).toMatchObject({ status: "rejected", code: "expired" });
    expect(collector.report(report(), NOW + ANALYTICS_RETENTION_MS + 1).diagnostics.expired).toBe(1);
  });


  it("observes plugin semantic failure without capturing its result or exception payload", async () => {
    const db = database();
    const logs = logger();
    const collector = new PrivateProductAnalytics(db, "fixture", "production", logs);
    const secret = "business-result-and-provider-secret";
    await runWithProductAnalytics({ operationId: randomUUID(), scope: { kind: "instance" }, scopeKnown: true, actorKind: "agent", actorSessionId: null, surface: "agent", mode: "production", intent: true }, () => observePluginAnalytics(collector, "fixture", "rpc.publish", async () => ({ ok: true, result: { success: false, message: secret } })));
    collector.flush();
    const result = collector.report(report());
    expect(result.rows.find((entry) => entry.featureId === "plugin.fixture" && entry.action === "rpc.publish")).toMatchObject({ attempts: 1, failures: 1, successes: 0, agent: 1 });
    expect(db.$client.serialize().includes(Buffer.from(secret))).toBe(false);
    expect(JSON.stringify(logs.error.mock.calls)).not.toContain(secret);
  });

  it("does not attribute an unassigned plugin operation to Work or Personal, or stop its primary action", async () => {
    const db = database();
    const collector = service(db);
    const created = await observePluginAnalytics(collector, "fixture", "rpc.create", async () => project(db, "Primary action still works"));
    expect(getProject(db, created.id)?.name).toBe("Primary action still works");
    collector.flush();
    const instance = collector.report(report());
    expect(instance.rows.find((entry) => entry.featureId === "plugin.fixture" && entry.action === "rpc.create")).toMatchObject({ attempts: 0, successes: 0 });
    expect(instance.diagnostics).toMatchObject({ gaps: 2, storage: "healthy" });
    expect(collector.report(report({ projectId: created.id })).diagnostics.instanceGaps).toBe(2);
  });

  it("keeps meaningful absent actor identity immutable across completion", () => {
    const db = database();
    const collector = service(db);
    const started = event({ actorSessionId: null, actorKind: "unknown" });
    collector.admit(started, "server", NOW);
    collector.admit({ ...started, stage: "completed", outcome: "succeeded", actorKind: "human", actorSessionId: randomUUID() }, "server", NOW);
    collector.flush(NOW);
    expect(row(collector)).toMatchObject({ attempts: 1, unknown: 1, human: 0, successes: 1 });
    expect(db.select({ actor: productAnalyticsEvents.actorSessionId }).from(productAnalyticsEvents).all()).toEqual([{ actor: null }, { actor: null }]);
  });

  it("requires declarations for custom plugin completions and retires their availability", () => {
    const collector = service(database());
    const action = declarePluginAnalyticsAction(collector, "fixture", { action: "board.open", surfaces: ["web"], completionSource: "client" });
    const input = event({ ...action.identity, stage: "completed", outcome: "succeeded" });
    expect(collector.admit(input, "client", NOW).status).toBe("accepted");
    action.dispose();
    expect(collector.admit(input, "client", NOW)).toMatchObject({ status: "duplicate", code: "none" });
    expect(collector.admit({ ...input, operationId: randomUUID() }, "client", NOW)).toMatchObject({ status: "rejected", code: "unknown_feature" });
    collector.flush(NOW);
    expect(collector.report(report(), NOW).rows.find((entry) => entry.featureId === action.identity.featureId && entry.action === action.identity.action)).toMatchObject({ availability: "unavailable", successes: 1 });
    expect(() => declarePluginAnalyticsAction(collector, "fixture", { action: "rpc.overwrite", surfaces: ["sdk"], completionSource: "client" })).toThrow("Framework analytics actions cannot be redeclared");
  });

  it.each([
    { result: { ok: true, value: { outcome: "queued" } }, accepted: 1, denied: 0, cancelled: 0 },
    { result: { ok: true, value: { outcome: "denied" } }, accepted: 0, denied: 1, cancelled: 0 },
    { result: { ok: true, result: { outcome: "cancelled" } }, accepted: 0, denied: 0, cancelled: 1 },
  ])("does not turn a plugin result $result into an invented success", async (scenario) => {
    const collector = service(database());
    await observePluginAnalytics(collector, "fixture", "rpc.publish", async () => scenario.result, { scope: { kind: "instance" }, actorKind: "agent", surface: "mcp" });
    collector.flush();
    expect(collector.report(report()).rows.find((entry) => entry.featureId === "plugin.fixture" && entry.action === "rpc.publish")).toMatchObject({ attempts: 1, successes: 0, failures: 0, accepted: scenario.accepted, denied: scenario.denied, cancelled: scenario.cancelled });
  });

  it("classifies HTTP refusal without consuming or storing the response body", async () => {
    const db = database();
    const collector = service(db);
    const response = new Response("private-provider-body", { status: 403 });
    await observePluginAnalytics(collector, "fixture", "http.publish", async () => response, { scope: { kind: "instance" }, actorKind: "agent", surface: "mcp" });
    collector.flush();
    expect(response.bodyUsed).toBe(false);
    expect(collector.report(report()).rows.find((entry) => entry.featureId === "plugin.fixture" && entry.action === "http.publish")).toMatchObject({ attempts: 1, successes: 0, failures: 0, denied: 1 });
    expect(db.$client.serialize().includes(Buffer.from("private-provider-body"))).toBe(false);
  });

  it("recovers collection after identity persistence was temporarily unavailable", () => {
    const db = database();
    db.$client.exec("CREATE TRIGGER analytics_identity_failure BEFORE INSERT ON product_analytics_health WHEN NEW.scope_mode = 'identity' BEGIN SELECT RAISE(FAIL, 'identity unavailable'); END");
    const collector = service(db);
    const input = event();
    expect(collector.admit(input, "server", NOW)).toMatchObject({ status: "retry", code: "storage_unavailable" });
    db.$client.exec("DROP TRIGGER analytics_identity_failure");
    collector.flush(NOW);
    expect(collector.admit(input, "server", NOW)).toMatchObject({ status: "accepted", code: "none" });
    collector.flush(NOW);
    expect(row(collector)).toMatchObject({ attempts: 1, successes: 0 });
    expect(collector.report(report(), NOW).diagnostics.storage).toBe("healthy");
  });
});
