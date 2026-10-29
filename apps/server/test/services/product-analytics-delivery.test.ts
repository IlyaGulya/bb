import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createConnection, type DbConnection } from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import { productAnalyticsEventSchema, type ProductAnalyticsAck, type ProductAnalyticsEvent } from "@bb/server-contract";
import { ExperimentalProductAnalyticsOutbox, type ExperimentalAnalyticsQueueEntry, type ExperimentalAnalyticsQueueHealth, type ExperimentalAnalyticsQueueStore } from "@bb/sdk/node";
import { PrivateProductAnalytics } from "../../src/services/system/product-analytics.js";

const databases: DbConnection[] = [];
function database(): DbConnection { const db = createMigratedConnection(); databases.push(db); return db; }
afterEach(() => { for (const db of databases.splice(0)) db.$client.close(); });

class SqliteQueueStore implements ExperimentalAnalyticsQueueStore {
  constructor(private readonly db: DbConnection) {
    db.$client.exec("CREATE TABLE IF NOT EXISTS analytics_client_queue (id TEXT PRIMARY KEY, event TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS analytics_client_health (id INTEGER PRIMARY KEY, gaps INTEGER NOT NULL); INSERT OR IGNORE INTO analytics_client_health VALUES (1, 0)");
  }
  async enqueue(entry: ExperimentalAnalyticsQueueEntry): Promise<boolean> {
    this.db.$client.prepare("INSERT OR IGNORE INTO analytics_client_queue(id, event) VALUES (?, ?)").run(entry.id, JSON.stringify(entry.event));
    return true;
  }
  async batch(): Promise<ExperimentalAnalyticsQueueEntry[]> {
    const rows = this.db.$client.prepare<[], { id: string; event: string }>("SELECT id, event FROM analytics_client_queue ORDER BY rowid LIMIT 50").all();
    return rows.map((row) => ({ id: row.id, event: productAnalyticsEventSchema.parse(JSON.parse(row.event)) }));
  }
  async settle(entries: { id: string; status: "accepted" | "duplicate" | "retry" | "rejected" }[]): Promise<void> {
    this.db.transaction(() => {
      for (const entry of entries) {
        if (entry.status === "retry") this.db.$client.prepare("UPDATE analytics_client_queue SET attempts = attempts + 1 WHERE id = ?").run(entry.id);
        else this.db.$client.prepare("DELETE FROM analytics_client_queue WHERE id = ?").run(entry.id);
        if (entry.status === "rejected") this.db.$client.prepare("UPDATE analytics_client_health SET gaps = gaps + 1 WHERE id = 1").run();
      }
    });
  }
  async health(): Promise<ExperimentalAnalyticsQueueHealth> {
    const rows = this.db.$client.prepare<[], { pending: number; failed: number }>("SELECT count(*) AS pending, coalesce(sum(attempts > 0), 0) AS failed FROM analytics_client_queue").get()!;
    const health = this.db.$client.prepare<[], { gaps: number }>("SELECT gaps FROM analytics_client_health WHERE id = 1").get()!;
    return { ...rows, gaps: health.gaps, expired: 0, storage: "healthy" };
  }
}
function input(): ProductAnalyticsEvent { return { operationId: randomUUID(), featureId: "ui.compose", action: "open", version: 1, scope: { kind: "instance" }, actorKind: "agent", actorSessionId: null, surface: "sdk", mode: "smoke", stage: "started", outcome: "none", errorCode: "none", timestamp: Date.now(), durationMs: null }; }
function collector(db: DbConnection): PrivateProductAnalytics { return new PrivateProductAnalytics(db, "delivery-contract", "production", { debug() {}, info() {}, warn() {}, error() {} }); }

describe("acknowledged analytics outbox", () => {
  it("retains an offline event, survives client/server reopen and retries a lost ACK without extra use", async () => {
    const clientDb = database();
    const serverDb = database();
    let server = collector(serverDb);
    let online = false;
    let loseAck = true;
    const send = async (batch: { events: ProductAnalyticsEvent[] }): Promise<ProductAnalyticsAck> => {
      if (!online) throw new Error("network unavailable");
      const ack = server.admitBatch(batch.events);
      if (loseAck) { loseAck = false; throw new Error("ACK lost after commit"); }
      return ack;
    };
    const original = new ExperimentalProductAnalyticsOutbox(new SqliteQueueStore(clientDb), send);
    await original.record(input());
    await original.flush();
    expect(original.getSnapshot()).toMatchObject({ pending: 1, failed: 1 });
    online = true;
    await original.flush();
    expect(original.getSnapshot()).toMatchObject({ pending: 1, failed: 1 });
    expect(server.report({ days: 7, mode: "smoke" }).diagnostics.pending).toBe(1);
    const reopenedClient = createConnection(clientDb.$client.serialize());
    const reopenedServer = createConnection(serverDb.$client.serialize());
    databases.push(reopenedClient, reopenedServer);
    server = collector(reopenedServer);
    const restarted = new ExperimentalProductAnalyticsOutbox(new SqliteQueueStore(reopenedClient), send);
    await restarted.flush();
    expect(restarted.getSnapshot()).toMatchObject({ pending: 0, failed: 0, gaps: 0 });
    server.flush();
    expect(server.report({ days: 7, mode: "smoke" }).rows.find((row) => row.featureId === "ui.compose" && row.action === "open")).toMatchObject({ attempts: 1, agent: 1, human: 0 });
    expect(server.report({ days: 7, mode: "production" }).rows.find((row) => row.featureId === "ui.compose" && row.action === "open")).toMatchObject({ attempts: 0 });
  });

  it("does not consume a receipt for another scope even with the same operation identity", async () => {
    const store = new SqliteQueueStore(database());
    const server = collector(database());
    let wrongScope = true;
    const outbox = new ExperimentalProductAnalyticsOutbox(store, async (batch) => {
      const ack = server.admitBatch(batch.events);
      return wrongScope ? { receipts: ack.receipts.map((receipt) => ({ ...receipt, scope: { kind: "project", projectId: "proj_unrelated" } })) } : ack;
    });
    await outbox.record(input());
    await outbox.flush();
    expect(outbox.getSnapshot()).toMatchObject({ pending: 1, failed: 1 });
    wrongScope = false;
    await outbox.flush();
    expect(outbox.getSnapshot()).toMatchObject({ pending: 0, failed: 0 });
    server.flush();
    expect(server.report({ days: 7, mode: "smoke" }).rows.find((row) => row.featureId === "ui.compose" && row.action === "open")?.attempts).toBe(1);
  });

  it("keeps missing receipts pending and accepts a reordered partial batch", async () => {
    const store = new SqliteQueueStore(database());
    const server = collector(database());
    const first = input();
    const second = input();
    await store.enqueue({ id: "first", event: first });
    await store.enqueue({ id: "second", event: second });
    let partial = true;
    const outbox = new ExperimentalProductAnalyticsOutbox(store, async (batch) => {
      const ack = server.admitBatch(batch.events);
      return partial ? { receipts: ack.receipts.slice(1).reverse() } : ack;
    });
    await outbox.flush();
    expect(outbox.getSnapshot()).toMatchObject({ pending: 1, failed: 1 });
    expect((await store.batch()).map((entry) => entry.event.operationId)).toEqual([first.operationId]);
    partial = false;
    await outbox.flush();
    expect(outbox.getSnapshot().pending).toBe(0);
    server.flush();
    expect(server.report({ days: 7, mode: "smoke" }).rows.find((row) => row.featureId === "ui.compose" && row.action === "open")?.attempts).toBe(2);
  });

  it("retains a contradictory ACK and exposes permanent rejection as a gap", async () => {
    const store = new SqliteQueueStore(database());
    const server = collector(database());
    let contradictory = true;
    const outbox = new ExperimentalProductAnalyticsOutbox(store, async (batch) => {
      const ack = server.admitBatch(batch.events);
      return contradictory ? { receipts: ack.receipts.map((receipt) => ({ ...receipt, code: "queue_full" })) } : ack;
    });
    await outbox.record(input());
    await outbox.flush();
    expect(outbox.getSnapshot()).toMatchObject({ pending: 1, failed: 1 });
    contradictory = false;
    await outbox.flush();
    await outbox.record({ ...input(), action: "unknown-action" });
    await outbox.flush();
    expect(outbox.getSnapshot()).toMatchObject({ pending: 0, failed: 0, gaps: 1 });
  });

  it("rejects unsafe client input before durable admission and keeps its gap visible", async () => {
    const store = new SqliteQueueStore(database());
    const server = collector(database());
    const outbox = new ExperimentalProductAnalyticsOutbox(store, async (batch) => server.admitBatch(batch.events));
    const unsafe = { ...input(), prompt: "must not be persisted" };
    expect(await outbox.record(unsafe)).toBe(false);
    await outbox.refreshHealth();
    expect(outbox.getSnapshot()).toMatchObject({ pending: 0, failed: 1, gaps: 1, storage: "healthy" });
    expect(await store.batch()).toEqual([]);
  });
});
