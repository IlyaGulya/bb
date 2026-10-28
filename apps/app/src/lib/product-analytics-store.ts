import { z } from "zod";
import { productAnalyticsEventSchema } from "@bb/server-contract";
import type { ExperimentalAnalyticsQueueEntry, ExperimentalAnalyticsQueueHealth, ExperimentalAnalyticsQueueStore } from "@bb/sdk/browser";

const entrySchema = z.object({ id: z.string(), event: productAnalyticsEventSchema, queuedAt: z.number(), attempts: z.number() }).strict();
const metricsSchema = z.object({ id: z.literal("health"), gaps: z.number(), expired: z.number() }).strict();
const EMPTY_METRICS = { id: "health" as const, gaps: 0, expired: 0 };
export const BROWSER_ANALYTICS_LIMIT = 500;
export const BROWSER_ANALYTICS_RETENTION_MS = 7 * 86_400_000;
export class BrowserAnalyticsStore implements ExperimentalAnalyticsQueueStore {
  private opening: Promise<IDBDatabase> | null = null;
  private open(): Promise<IDBDatabase> {
    if (this.opening !== null) return this.opening;
    this.opening = new Promise((resolve, reject) => {
      const request = indexedDB.open("bb.private-product-analytics.v1", 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        database.createObjectStore("events", { keyPath: "id" }).createIndex("queuedAt", "queuedAt");
        database.createObjectStore("health", { keyPath: "id" });
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => { database.close(); this.opening = null; };
        resolve(database);
      };
      request.onerror = () => { this.opening = null; reject(new Error("analytics_storage_unavailable")); };
      request.onblocked = () => { this.opening = null; reject(new Error("analytics_storage_blocked")); };
    });
    return this.opening;
  }
  private async transaction<T>(mode: IDBTransactionMode, work: (events: IDBObjectStore, metrics: IDBObjectStore, result: (value: T) => void) => void): Promise<T> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(["events", "health"], mode);
      let result: T;
      let hasResult = false;
      transaction.oncomplete = () => hasResult ? resolve(result) : reject(new Error("analytics_storage_incomplete"));
      transaction.onerror = () => reject(new Error("analytics_storage_unavailable"));
      transaction.onabort = () => reject(new Error("analytics_storage_unavailable"));
      try { work(transaction.objectStore("events"), transaction.objectStore("health"), (value) => { result = value; hasResult = true; }); }
      catch { transaction.abort(); }
    });
  }
  enqueue(entry: ExperimentalAnalyticsQueueEntry): Promise<boolean> {
    return this.transaction("readwrite", (events, metrics, done) => {
      const existing = events.get(entry.id);
      existing.onsuccess = () => {
        if (existing.result !== undefined) { done(true); return; }
        const count = events.count();
        count.onsuccess = () => {
          if (count.result < BROWSER_ANALYTICS_LIMIT) {
            events.add({ ...entry, queuedAt: Date.now(), attempts: 0 });
            done(true);
          } else {
            const request = metrics.get("health");
            request.onsuccess = () => {
              const state = metricsSchema.parse(request.result ?? EMPTY_METRICS);
              metrics.put({ ...state, gaps: state.gaps + 1 });
              done(false);
            };
          }
        };
      };
    });
  }
  batch(): Promise<ExperimentalAnalyticsQueueEntry[]> {
    return this.transaction("readwrite", (events, metrics, done) => {
      const request = events.index("queuedAt").getAll(undefined, 50);
      request.onsuccess = () => {
        const entries = z.array(entrySchema).parse(request.result);
        const expired = entries.filter((entry) => entry.event.timestamp < Date.now() - BROWSER_ANALYTICS_RETENTION_MS);
        for (const entry of expired) events.delete(entry.id);
        if (expired.length > 0) {
          const health = metrics.get("health");
          health.onsuccess = () => {
            const state = metricsSchema.parse(health.result ?? EMPTY_METRICS);
            metrics.put({ ...state, gaps: state.gaps + expired.length, expired: state.expired + expired.length });
          };
        }
        done(entries.filter((entry) => !expired.includes(entry)).map(({ id, event }) => ({ id, event })));
      };
    });
  }
  settle(entries: { id: string; status: "accepted" | "duplicate" | "retry" | "rejected" }[]): Promise<void> {
    return this.transaction("readwrite", (events, metrics, done) => {
      for (const entry of entries) {
        if (entry.status === "retry") {
          const request = events.get(entry.id);
          request.onsuccess = () => {
            if (request.result === undefined) return;
            const saved = entrySchema.parse(request.result);
            events.put({ ...saved, attempts: Math.min(saved.attempts + 1, 1_000_000) });
          };
        } else events.delete(entry.id);
      }
      const rejected = entries.filter((entry) => entry.status === "rejected").length;
      if (rejected > 0) {
        const request = metrics.get("health");
        request.onsuccess = () => {
          const state = metricsSchema.parse(request.result ?? EMPTY_METRICS);
          metrics.put({ ...state, gaps: state.gaps + rejected });
        };
      }
      done(undefined);
    });
  }
  health(): Promise<ExperimentalAnalyticsQueueHealth> {
    return this.transaction("readonly", (events, metrics, done) => {
      const entries = events.getAll();
      entries.onsuccess = () => {
        const rows = z.array(entrySchema).parse(entries.result);
        const request = metrics.get("health");
        request.onsuccess = () => {
          const state = metricsSchema.parse(request.result ?? EMPTY_METRICS);
          done({ pending: rows.length, failed: rows.filter((entry) => entry.attempts > 0).length, gaps: state.gaps, expired: state.expired, storage: "healthy" });
        };
      };
    });
  }
}
