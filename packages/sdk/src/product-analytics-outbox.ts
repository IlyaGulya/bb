import { productAnalyticsEventSchema, productAnalyticsAckSchema, type ProductAnalyticsAck, type ProductAnalyticsBatch, type ProductAnalyticsEvent } from "@bb/server-contract";

export interface ExperimentalAnalyticsQueueEntry { id: string; event: ProductAnalyticsEvent }
export interface ExperimentalAnalyticsQueueHealth { pending: number; failed: number; gaps: number; expired: number; storage: "healthy" | "unavailable" }
export interface ExperimentalAnalyticsQueueStore {
  enqueue(entry: ExperimentalAnalyticsQueueEntry): Promise<boolean>;
  batch(): Promise<ExperimentalAnalyticsQueueEntry[]>;
  settle(entries: { id: string; status: "accepted" | "duplicate" | "retry" | "rejected" }[]): Promise<void>;
  health(): Promise<ExperimentalAnalyticsQueueHealth>;
}
export function experimental_productAnalyticsQueueKey(event: ProductAnalyticsEvent): string {
  return JSON.stringify([event.scope, event.mode, event.operationId, event.featureId, event.action, event.version, event.stage]);
}
export class ExperimentalProductAnalyticsOutbox {
  private inFlight: Promise<void> | null = null;
  private snapshot: ExperimentalAnalyticsQueueHealth = { pending: 0, failed: 0, gaps: 0, expired: 0, storage: "healthy" };
  private readonly listeners = new Set<() => void>();
  private baseHealth: ExperimentalAnalyticsQueueHealth = { pending: 0, failed: 0, gaps: 0, expired: 0, storage: "healthy" };
  private volatileFailures = 0;
  private volatileGaps = 0;
  constructor(private readonly store: ExperimentalAnalyticsQueueStore, private readonly send: (batch: ProductAnalyticsBatch) => Promise<ProductAnalyticsAck>) {}
  getSnapshot = (): ExperimentalAnalyticsQueueHealth => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private publish(next: ExperimentalAnalyticsQueueHealth): void {
    this.baseHealth = next;
    this.snapshot = { ...next, failed: next.failed + this.volatileFailures, gaps: next.gaps + this.volatileGaps };
    for (const listener of this.listeners) listener();
  }
  private unavailable(): void {
    this.volatileFailures++;
    this.volatileGaps++;
    this.publish({ ...this.baseHealth, storage: "unavailable" });
  }
  async record(input: ProductAnalyticsEvent): Promise<boolean> {
    const parsed = productAnalyticsEventSchema.safeParse(input);
    if (!parsed.success) {
      this.volatileFailures++;
      this.volatileGaps++;
      this.publish(this.baseHealth);
      return false;
    }
    const event = parsed.data;
    try {
      const admitted = await this.store.enqueue({ id: experimental_productAnalyticsQueueKey(event), event });
      this.publish(await this.store.health());
      if (admitted) void this.flush();
      return admitted;
    } catch { this.unavailable(); return false; }
  }
  async refreshHealth(): Promise<void> {
    try { this.publish(await this.store.health()); } catch { this.unavailable(); }
  }
  flush(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = this.drain().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  private async drain(): Promise<void> {
    try {
      for (let batchIndex = 0; batchIndex < 10; batchIndex++) {
        const entries = await this.store.batch();
        if (entries.length === 0) break;
        let ack: ProductAnalyticsAck;
        try { ack = productAnalyticsAckSchema.parse(await this.send({ events: entries.map((entry) => entry.event) })); }
        catch {
          await this.store.settle(entries.map(({ id }) => ({ id, status: "retry" })));
          break;
        }
        const settlements = entries.map((entry) => {
          const event = entry.event;
          const receipt = ack.receipts.find((receipt) => receipt.operationId === event.operationId && receipt.featureId === event.featureId && receipt.action === event.action && receipt.stage === event.stage && receipt.mode === event.mode && receipt.scope.kind === event.scope.kind && (receipt.scope.kind === "instance" || (event.scope.kind === "project" && receipt.scope.projectId === event.scope.projectId)));
          return { id: entry.id, status: receipt?.status ?? "retry" as const };
        });
        await this.store.settle(settlements);
        if (settlements.some((entry) => entry.status === "retry")) break;
      }
      this.publish(await this.store.health());
    } catch { this.unavailable(); }
  }
}
