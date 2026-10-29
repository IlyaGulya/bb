import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { and, count, eq, isNull, like, lt, sql } from "drizzle-orm";
import { appSettingsValues, projects, productAnalyticsEvents as events, productAnalyticsHealth as health, type DbConnection } from "@bb/db";
import {
  productAnalyticsEventSchema,
  productAnalyticsModeSchema,
  productAnalyticsActorSchema,
  productAnalyticsSurfaceSchema,
  type ProductAnalyticsAck,
  type ProductAnalyticsEvent,
  type ProductAnalyticsFeature,
  type ProductAnalyticsMode,
  type ProductAnalyticsReceipt,
  type ProductAnalyticsReport,
  type ProductAnalyticsReportQuery,
  type ProductAnalyticsRow,
  type ProductAnalyticsScope,
} from "@bb/server-contract";
import type { ServerLogger } from "../../types.js";
import { CLIENT_ANALYTICS_FEATURES, CORE_ANALYTICS_ROUTES } from "./product-analytics-catalog.js";

export const ANALYTICS_RETENTION_MS = 30 * 86_400_000;
export const ANALYTICS_MAX_PENDING = 10_000;
export const ANALYTICS_MAX_EVENTS = 100_000;
export const ANALYTICS_PENDING_TURN_MODE_PREFIX = "productAnalytics.pendingTurn.";
export interface AnalyticsContext {
  operationId: string;
  scope: ProductAnalyticsScope;
  scopeKnown: boolean;
  actorKind: ProductAnalyticsEvent["actorKind"];
  actorSessionId: string | null;
  surface: ProductAnalyticsEvent["surface"];
  mode: ProductAnalyticsMode;
  intent: boolean;
}
const contextStorage = new AsyncLocalStorage<AnalyticsContext>();
const services = new WeakMap<DbConnection, PrivateProductAnalytics>();
export function runWithProductAnalytics<T>(context: AnalyticsContext, run: () => T): T {
  return contextStorage.run(context, run);
}
export function productAnalyticsContext(): AnalyticsContext | undefined {
  return contextStorage.getStore();
}
export function analyticsScopeKey(scope: ProductAnalyticsScope): string {
  return scope.kind === "instance" ? "instance" : scope.projectId;
}
function eventKey(event: ProductAnalyticsEvent): string {
  return createHash("sha256").update(JSON.stringify([analyticsScopeKey(event.scope), event.operationId, event.featureId, event.action, event.version, event.stage])).digest("hex");
}
function emptyRow(feature: ProductAnalyticsFeature): ProductAnalyticsRow {
  return { ...feature, exposures: 0, opens: 0, attempts: 0, successes: 0, failures: 0, denied: 0, cancelled: 0, accepted: 0, human: 0, agent: 0, system: 0, unknown: 0, repeatActors: 0, averageDurationMs: null, lastUsedAt: null };
}
export function analyticsMode(isDevelopment: boolean): ProductAnalyticsMode {
  return process.env.NODE_ENV === "test" ? "test" : isDevelopment ? "preview" : "production";
}
export function getPrivateProductAnalytics(db: DbConnection): PrivateProductAnalytics {
  const service = services.get(db);
  if (!service) throw new Error("Private product analytics is not initialized");
  return service;
}
export function initializePrivateProductAnalytics(args: { db: DbConnection; release: string; mode: ProductAnalyticsMode; logger: ServerLogger }): PrivateProductAnalytics {
  const existing = services.get(args.db);
  if (existing) return existing;
  const service = new PrivateProductAnalytics(args.db, args.release, args.mode, args.logger);
  services.set(args.db, service);
  return service;
}

export class PrivateProductAnalytics {
  private readonly catalog = new Map<string, ProductAnalyticsFeature>();
  private readonly clientCompletionFeatures = new Set<string>();
  private readonly transientFailures = new Map<string, number>();
  private storageHealthy = true;
  private timer: ReturnType<typeof setInterval> | null = null;
  private instanceId = "";
  private catalogProvider: () => ProductAnalyticsFeature[] = () => [];
  private dynamicCatalogKeys = new Set<string>();
  constructor(private readonly db: DbConnection, readonly release: string, readonly mode: ProductAnalyticsMode, private readonly logger: ServerLogger) {
    for (const feature of [...CORE_ANALYTICS_ROUTES, ...CLIENT_ANALYTICS_FEATURES]) this.register(feature, feature.featureId.startsWith("ui.") ? "client" : "server");
    try {
      this.initializeIdentity();
    } catch {
      this.storageHealthy = false;
      this.logger.error({ code: "product_analytics_storage_unavailable" }, "Private analytics identity could not be persisted");
    }
  }
  private initializeIdentity(): void {
    if (this.instanceId !== "") return;
    if (this.db.$client.inTransaction) throw new Error("product_analytics_identity_uncommitted");
    this.db.insert(health).values({ scopeMode: "identity", instanceId: randomUUID() }).onConflictDoNothing().run();
    const identity = this.db.select({ id: health.instanceId }).from(health).where(eq(health.scopeMode, "identity")).get();
    if (!identity?.id) throw new Error("product_analytics_identity_unavailable");
    this.instanceId = identity.id;
  }
  start(): void {
    if (this.timer !== null) return;
    this.flush();
    this.timer = setInterval(() => this.flush(), 1000);
    this.timer.unref();
  }
  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.flush();
  }
  setCatalogProvider(provider: () => ProductAnalyticsFeature[]): void { this.catalogProvider = provider; }
  private refreshCatalog(): boolean {
    try {
      const features = this.catalogProvider();
      const keys = new Set(features.map((feature) => `${feature.featureId}:${feature.action}`));
      for (const key of this.dynamicCatalogKeys) {
        if (keys.has(key)) continue;
        const feature = this.catalog.get(key);
        if (feature !== undefined) this.register({ ...feature, availability: "unavailable" });
      }
      for (const feature of features) this.register(feature);
      this.dynamicCatalogKeys = keys;
      return true;
    } catch {
      this.failure("instance", this.mode);
      return false;
    }
  }
  register(feature: ProductAnalyticsFeature, completionSource: "server" | "client" = "server"): void {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,119}$/.test(feature.featureId) || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,119}$/.test(feature.action)) return;
    this.catalog.set(`${feature.featureId}:${feature.action}`, feature);
    const key = `${feature.featureId}:${feature.action}`;
    if (completionSource === "client" || (feature.featureId.startsWith("plugin.") && feature.action === "open" && feature.coverage === "lifecycle")) this.clientCompletionFeatures.add(key);
    else this.clientCompletionFeatures.delete(key);
  }
  registerOwned(feature: ProductAnalyticsFeature, completionSource: "server" | "client"): { dispose(): void } {
    this.register(feature, completionSource);
    const key = `${feature.featureId}:${feature.action}`;
    return {
      dispose: () => {
        if (this.catalog.get(key) !== feature) return;
        this.register({ ...feature, availability: "unavailable" });
      },
    };
  }
  registerRouteGaps(routes: readonly { method: string; path: string }[]): void {
    for (const route of routes) {
      const method = route.method.toUpperCase();
      if (route.path === "*" || route.path === "/*" || route.path.startsWith("/system/product-analytics") || route.path.startsWith("/system/telemetry")) continue;
      if (/^\/plugins\/:[^/]+\/(rpc|http|cli|ws|assets)(\/|$)/.test(route.path) || route.path.startsWith("/plugin-catalog/icons/") || route.path.startsWith("/plugin-app-assets/")) continue;
      if (CORE_ANALYTICS_ROUTES.some((known) => known.method === method && known.path === route.path)) continue;
      const action = `route.${createHash("sha256").update(`${method}:${route.path}`).digest("hex").slice(0, 20)}`;
      this.register({ featureId: "core.uncatalogued", action, version: 1, label: `Uncatalogued API · ${method} ${route.path}`, entrypoints: [`${method} ${route.path}`], surfaces: ["api", "sdk", "cli", "web", "agent", "mcp"], coverage: "gap", availability: "unknown", limitation: "Registered runtime route without a semantic analytics contract; unknown usage is not measured zero." });
    }
  }
  private healthKey(scope: string, mode: ProductAnalyticsMode): string { return `${scope}:${mode}`; }
  private ensureHealth(scope: string, mode: ProductAnalyticsMode): string {
    const key = this.healthKey(scope, mode);
    this.db.insert(health).values({ scopeMode: key, instanceId: this.instanceId }).onConflictDoNothing().run();
    return key;
  }
  private effectiveMode(mode: ProductAnalyticsMode): ProductAnalyticsMode { return mode === "production" ? this.mode : mode; }
  noteGap(scope: ProductAnalyticsScope, mode = this.mode): void {
    mode = this.effectiveMode(mode);
    const key = analyticsScopeKey(scope);
    try {
      this.db.update(health).set({ gaps: sql`${health.gaps} + 1` }).where(eq(health.scopeMode, this.ensureHealth(key, mode))).run();
    } catch { this.failure(key, mode); }
  }
  private failure(scope: string, mode: ProductAnalyticsMode): void {
    mode = this.effectiveMode(mode);
    const requestedKey = this.healthKey(scope, mode);
    const key = this.transientFailures.has(requestedKey) || this.transientFailures.size < 100 ? requestedKey : this.healthKey("instance", mode);
    this.transientFailures.set(key, (this.transientFailures.get(key) ?? 0) + 1);
    if (this.storageHealthy) this.logger.error({ code: "product_analytics_storage_unavailable" }, "Private analytics admission failed; primary action continues; delivery gap is visible in analytics health");
    this.storageHealthy = false;
  }
  scopeAllowed(scope: ProductAnalyticsScope): boolean {
    return scope.kind === "instance" || this.db.select({ id: projects.id }).from(projects).where(eq(projects.id, scope.projectId)).get() !== undefined;
  }
  admit(input: ProductAnalyticsEvent, source: "client" | "server", now = Date.now()): ProductAnalyticsReceipt {
    const receipt = (status: ProductAnalyticsReceipt["status"], code: ProductAnalyticsReceipt["code"]): ProductAnalyticsReceipt => {
      if (status === "rejected") this.noteGap({ kind: "instance" }, productAnalyticsModeSchema.safeParse(input.mode).data ?? this.mode);
      return { operationId: input.operationId, featureId: input.featureId, action: input.action, stage: input.stage, scope: input.scope, mode: input.mode, status, code };
    };
    const parsed = productAnalyticsEventSchema.safeParse(input);
    if (!parsed.success) return receipt("rejected", "invalid");
    const event = parsed.data;
    if (event.timestamp < now - ANALYTICS_RETENTION_MS || event.timestamp > now + 300_000) return receipt("rejected", "expired");
    const scope = analyticsScopeKey(event.scope);
    try {
      if (!this.scopeAllowed(event.scope)) return receipt("rejected", "scope_denied");
      if (this.db.$client.inTransaction) {
        this.failure(scope, event.mode);
        return receipt("retry", "storage_unavailable");
      }
      this.initializeIdentity();
      return this.db.transaction(() => {
        const id = eventKey(event);
        if (this.db.select({ id: events.id }).from(events).where(eq(events.id, id)).get()) return receipt("duplicate", "none");
        if ((event.featureId.startsWith("plugin.") || !this.catalog.has(`${event.featureId}:${event.action}`)) && !this.refreshCatalog()) return receipt("retry", "storage_unavailable");
        const feature = this.catalog.get(`${event.featureId}:${event.action}`);
        if (!feature || feature.coverage === "gap" || feature.availability === "unavailable") return receipt("rejected", "unknown_feature");
        if (source === "client" && event.stage === "completed" && !this.clientCompletionFeatures.has(`${event.featureId}:${event.action}`)) return receipt("rejected", "server_authoritative");
        const prior = this.db.select({ mode: events.mode, actorKind: events.actorKind, actorSessionId: events.actorSessionId, surface: events.surface }).from(events).where(eq(events.id, eventKey({ ...event, stage: event.stage === "started" ? "completed" : "started" }))).get();
        const mode = productAnalyticsModeSchema.parse(prior?.mode ?? this.effectiveMode(event.mode));
        const normalized = { ...event, mode, actorKind: productAnalyticsActorSchema.parse(prior?.actorKind ?? event.actorKind), surface: productAnalyticsSurfaceSchema.parse(prior?.surface ?? event.surface) };
        const healthKey = this.ensureHealth(scope, mode);
        const pending = this.db.select({ value: count() }).from(events).where(isNull(events.projectedAt)).get()!.value;
        const total = this.db.select({ value: count() }).from(events).get()!.value;
        if (pending >= ANALYTICS_MAX_PENDING || total >= ANALYTICS_MAX_EVENTS) {
          this.db.update(health).set({ gaps: sql`${health.gaps} + 1` }).where(eq(health.scopeMode, healthKey)).run();
          return receipt("retry", "queue_full");
        }
        const actorSessionId = prior === undefined ? (event.actorSessionId === null ? null : createHash("sha256").update(`${this.instanceId}:${scope}:${event.actorSessionId}`).digest("hex")) : prior.actorSessionId;
        this.db.insert(events).values({ ...normalized, id, scope, actorSessionId, release: this.release.slice(0, 100), admittedAt: now, projectedAt: null }).run();
        this.db.update(health).set({ lastAcceptedAt: now }).where(eq(health.scopeMode, healthKey)).run();
        return receipt("accepted", "none");
      });
    } catch {
      this.failure(scope, event.mode);
      return receipt("retry", "storage_unavailable");
    }
  }
  admitBatch(batch: ProductAnalyticsEvent[]): ProductAnalyticsAck {
    return { receipts: batch.map((event) => this.admit(event, "client")) };
  }
  record(featureId: string, action: string, stage: ProductAnalyticsEvent["stage"], outcome: ProductAnalyticsEvent["outcome"] = "none", errorCode: ProductAnalyticsEvent["errorCode"] = "none", durationMs: number | null = null, override?: Partial<AnalyticsContext> & { timestamp?: number }): ProductAnalyticsReceipt {
    const context = contextStorage.getStore();
    const event: ProductAnalyticsEvent = {
      operationId: override?.operationId ?? context?.operationId ?? randomUUID(),
      featureId, action, version: 1,
      scope: override?.scope ?? context?.scope ?? { kind: "instance" },
      actorKind: override?.actorKind ?? context?.actorKind ?? "system",
      actorSessionId: override?.actorSessionId ?? context?.actorSessionId ?? null,
      surface: override?.surface ?? context?.surface ?? "system",
      mode: override?.mode ?? context?.mode ?? this.mode,
      stage, outcome, errorCode, timestamp: override?.timestamp ?? Date.now(),
      durationMs: durationMs === null ? null : Math.min(86_400_000, Math.max(0, Math.round(durationMs))),
    };
    if (override?.scope === undefined && context?.scopeKnown === false) {
      this.noteGap({ kind: "instance" }, event.mode);
      return { operationId: event.operationId, featureId, action, stage, scope: event.scope, mode: event.mode, status: "rejected", code: "scope_denied" };
    }
    if (stage === "completed" && durationMs === null) {
      try {
        const mode = this.mode === "production" ? event.mode : this.mode;
        const started = this.db.select({ timestamp: events.timestamp }).from(events).where(eq(events.id, eventKey({ ...event, mode, stage: "started" }))).get();
        if (started) event.durationMs = Math.min(86_400_000, Math.max(0, event.timestamp - started.timestamp));
      } catch {
        this.failure(analyticsScopeKey(event.scope), event.mode);
      }
    }
    const receipt = this.admit(event, "server");
    return receipt;
  }
  flush(now = Date.now()): void {
    try {
      this.initializeIdentity();
      this.db.transaction(() => {
        for (const [key, failed] of this.transientFailures) {
          this.db.insert(health).values({ scopeMode: key, instanceId: this.instanceId, failed, gaps: failed }).onConflictDoUpdate({ target: health.scopeMode, set: { failed: sql`${health.failed} + ${failed}`, gaps: sql`${health.gaps} + ${failed}` } }).run();
        }
        const expired = this.db.select({ scope: events.scope, mode: events.mode, value: count(), pending: sql<number>`sum(case when ${events.projectedAt} is null then 1 else 0 end)` }).from(events).where(lt(events.timestamp, now - ANALYTICS_RETENTION_MS)).groupBy(events.scope, events.mode).all();
        for (const row of expired) {
          this.db.update(health).set({ expired: sql`${health.expired} + ${row.value}`, gaps: sql`${health.gaps} + ${row.pending}` }).where(eq(health.scopeMode, `${row.scope}:${row.mode}`)).run();
        }
        this.db.delete(events).where(lt(events.timestamp, now - ANALYTICS_RETENTION_MS)).run();
        this.db.delete(appSettingsValues).where(and(like(appSettingsValues.key, `${ANALYTICS_PENDING_TURN_MODE_PREFIX}%`), lt(appSettingsValues.updatedAt, now - ANALYTICS_RETENTION_MS))).run();
        const pending = this.db.select({ id: events.id, scope: events.scope, mode: events.mode }).from(events).where(isNull(events.projectedAt)).orderBy(events.admittedAt).limit(500).all();
        for (const event of pending) {
          this.db.update(events).set({ projectedAt: now }).where(eq(events.id, event.id)).run();
          this.db.update(health).set({ lastProjectedAt: now }).where(eq(health.scopeMode, `${event.scope}:${event.mode}`)).run();
        }
      });
      this.transientFailures.clear();
      this.storageHealthy = true;
    } catch {
      if (this.storageHealthy) this.logger.error({ code: "product_analytics_projection_unavailable" }, "Private analytics projection is pending; durable events will be retried");
      this.storageHealthy = false;
    }
  }
  report(query: ProductAnalyticsReportQuery, now = Date.now()): ProductAnalyticsReport {
    this.refreshCatalog();
    const scope: ProductAnalyticsScope = query.projectId === undefined ? { kind: "instance" } : { kind: "project", projectId: query.projectId };
    if (!this.scopeAllowed(scope)) throw new Error("Analytics scope is not available");
    const scopeKey = analyticsScopeKey(scope);
    const since = now - query.days * 86_400_000;
    const filters = and(eq(events.scope, scopeKey), eq(events.mode, query.mode), sql`${events.timestamp} >= ${since}`, sql`${events.projectedAt} IS NOT NULL`, query.actorKind === undefined ? undefined : eq(events.actorKind, query.actorKind), query.surface === undefined ? undefined : eq(events.surface, query.surface), query.release === undefined ? undefined : eq(events.release, query.release));
    const sum = (condition: ReturnType<typeof sql>) => sql<number>`sum(case when ${condition} then 1 else 0 end)`;
    const aggregates = this.db.select({
      featureId: events.featureId, action: events.action,
      exposures: sum(sql`${events.stage} = 'exposed'`), opens: sum(sql`${events.stage} = 'opened'`), attempts: sum(sql`${events.stage} = 'started'`),
      successes: sum(sql`${events.stage} = 'completed' and ${events.outcome} = 'succeeded'`), failures: sum(sql`${events.stage} = 'completed' and ${events.outcome} in ('failed', 'unavailable')`), denied: sum(sql`${events.stage} = 'completed' and ${events.outcome} = 'denied'`), cancelled: sum(sql`${events.stage} = 'completed' and ${events.outcome} = 'cancelled'`), accepted: sum(sql`${events.stage} = 'completed' and ${events.outcome} = 'accepted'`),
      human: sum(sql`${events.stage} = 'started' and ${events.actorKind} = 'human'`), agent: sum(sql`${events.stage} = 'started' and ${events.actorKind} = 'agent'`), system: sum(sql`${events.stage} = 'started' and ${events.actorKind} = 'system'`), unknown: sum(sql`${events.stage} = 'started' and ${events.actorKind} = 'unknown'`),
      averageDurationMs: sql<number | null>`avg(case when ${events.stage} = 'completed' then ${events.durationMs} end)`,
      lastUsedAt: sql<number | null>`max(case when ${events.stage} in ('started', 'opened') then ${events.timestamp} end)`,
    }).from(events).where(filters).groupBy(events.featureId, events.action).all();
    const repeats = this.db.select({ featureId: events.featureId, action: events.action, actor: events.actorSessionId, uses: count() }).from(events).where(and(filters, eq(events.stage, "started"), sql`${events.actorSessionId} IS NOT NULL`)).groupBy(events.featureId, events.action, events.actorSessionId).having(sql`count(*) > 1`).all();
    const repeatCounts = new Map<string, number>();
    for (const row of repeats) {
      const key = `${row.featureId}:${row.action}`;
      repeatCounts.set(key, (repeatCounts.get(key) ?? 0) + 1);
    }
    const rows = new Map<string, ProductAnalyticsRow>();
    for (const [key, feature] of this.catalog) rows.set(key, emptyRow(feature));
    for (const aggregate of aggregates) {
      const key = `${aggregate.featureId}:${aggregate.action}`;
      const base = rows.get(key) ?? emptyRow({ featureId: aggregate.featureId, action: aggregate.action, version: 1, label: `${aggregate.featureId} · ${aggregate.action}`, entrypoints: [], surfaces: [], coverage: "gap", availability: "unknown", limitation: "Previously instrumented feature is no longer in the current catalog." });
      rows.set(key, { ...base, ...aggregate, repeatActors: repeatCounts.get(key) ?? 0 });
    }
    const state = this.db.select().from(health).where(eq(health.scopeMode, this.healthKey(scopeKey, query.mode))).get();
    const instanceState = scopeKey === "instance" ? state : this.db.select({ gaps: health.gaps }).from(health).where(eq(health.scopeMode, this.healthKey("instance", query.mode))).get();
    const instanceGaps = (instanceState?.gaps ?? 0) + (this.transientFailures.get(this.healthKey("instance", query.mode)) ?? 0);
    const pending = this.db.select({ value: count() }).from(events).where(and(eq(events.scope, scopeKey), eq(events.mode, query.mode), isNull(events.projectedAt))).get()!.value;
    return {
      scope, mode: query.mode, release: this.release, instanceId: this.instanceId, generatedAt: now, since,
      diagnostics: { pending, failed: (state?.failed ?? 0) + (this.transientFailures.get(this.healthKey(scopeKey, query.mode)) ?? 0), gaps: (state?.gaps ?? 0) + (this.transientFailures.get(this.healthKey(scopeKey, query.mode)) ?? 0), instanceGaps, expired: state?.expired ?? 0, lastAcceptedAt: state?.lastAcceptedAt ?? null, lastProjectedAt: state?.lastProjectedAt ?? null, storage: this.storageHealthy ? "healthy" : "unavailable", retentionDays: 30, maxPending: 10000, maxEvents: 100000 },
      rows: [...rows.values()].sort((a, b) => b.attempts - a.attempts || a.label.localeCompare(b.label)),
    };
  }
}
