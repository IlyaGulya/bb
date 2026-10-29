import type { DbConnection } from "@bb/db";
import { productAnalyticsEventSchema } from "@bb/server-contract";
import type { ExperimentalAnalyticsQueueEntry, ExperimentalAnalyticsQueueHealth, ExperimentalAnalyticsQueueStore } from "@bb/sdk/node";

export class SqliteQueueStore implements ExperimentalAnalyticsQueueStore {
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
