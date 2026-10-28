import { outcomeForStatus, withProductAnalyticsJsonResult } from "./product-analytics-result.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Context, MiddlewareHandler } from "hono";
import { environments, threads, type DbConnection } from "@bb/db";
import { eq } from "drizzle-orm";
import {
  PRODUCT_ANALYTICS_HEADERS as headers,
  productAnalyticsActorSchema,
  productAnalyticsModeSchema,
  productAnalyticsSurfaceSchema,
  type ProductAnalyticsScope,
} from "@bb/server-contract";
import { CORE_ANALYTICS_ROUTES } from "./product-analytics-catalog.js";
import { runWithProductAnalytics, type AnalyticsContext, type PrivateProductAnalytics } from "./product-analytics.js";

const uuid = z.string().uuid();
const selectorSchema = z.object({
  projectId: z.string().regex(/^proj_[a-zA-Z0-9_-]+$/).optional().catch(undefined),
  threadId: z.string().regex(/^thr_[a-zA-Z0-9_-]+$/).optional().catch(undefined),
  environmentId: z.string().regex(/^env_[a-zA-Z0-9_-]+$/).optional().catch(undefined),
});
export function analyticsScopeFromSelectors(db: DbConnection, selectors: z.infer<typeof selectorSchema>): ProductAnalyticsScope | null {
  const projects = new Set<string>();
  if (selectors.projectId !== undefined) {
    if (!/^proj_[a-zA-Z0-9_-]+$/.test(selectors.projectId)) return null;
    projects.add(selectors.projectId);
  }
  if (selectors.threadId !== undefined) {
    const thread = db.select({ projectId: threads.projectId }).from(threads).where(eq(threads.id, selectors.threadId)).get();
    if (!thread) return null;
    projects.add(thread.projectId);
  }
  if (selectors.environmentId !== undefined) {
    const environment = db.select({ projectId: environments.projectId }).from(environments).where(eq(environments.id, selectors.environmentId)).get();
    if (!environment) return null;
    projects.add(environment.projectId);
  }
  if (projects.size > 1) return null;
  const projectId = [...projects][0];
  return projectId === undefined ? { kind: "instance" } : { kind: "project", projectId };
}
export function analyticsRequestContext(context: Context, service: PrivateProductAnalytics, scope: ProductAnalyticsScope): AnalyticsContext {
  return {
    operationId: uuid.safeParse(context.req.header(headers.operation)).data ?? randomUUID(),
    scope,
    scopeKnown: true,
    actorKind: productAnalyticsActorSchema.safeParse(context.req.header(headers.actor)).data ?? "unknown",
    actorSessionId: uuid.safeParse(context.req.header(headers.session)).data ?? null,
    surface: productAnalyticsSurfaceSchema.safeParse(context.req.header(headers.surface)).data ?? productAnalyticsSurfaceSchema.safeParse(context.req.header(headers.origin)).data ?? "api",
    mode: productAnalyticsModeSchema.safeParse(context.req.header(headers.mode)).data ?? service.mode,
    intent: context.req.header(headers.intent) === "use",
  };
}
export function privateAnalyticsMiddleware(db: DbConnection, service: PrivateProductAnalytics): MiddlewareHandler {
  return async (context, next) => {
    const path = context.req.path.replace(/^\/api\/v1/, "");
    const route = CORE_ANALYTICS_ROUTES.find((route) => route.method === context.req.method && route.pattern.test(path));
    const match = route?.pattern.exec(path);
    const params = Object.fromEntries((route?.parameters ?? []).map((key, index) => [key, match?.[index + 1]]));
    let body: z.infer<typeof selectorSchema> = {};
    if (context.req.header("content-type")?.includes("application/json")) {
      try { body = selectorSchema.parse(await context.req.json()); } catch { body = {}; }
    }
    const selectors = { ...selectorSchema.parse(context.req.query()), ...body };
    const declaredProject = context.req.header(headers.project);
    if (declaredProject !== undefined && selectors.projectId === undefined && selectors.threadId === undefined && selectors.environmentId === undefined) selectors.projectId = declaredProject;
    if (route?.path.startsWith("/projects/:id")) selectors.projectId = params.id;
    if (route?.path.startsWith("/threads/:id")) selectors.threadId = params.id;
    if (route?.path.startsWith("/environments/:id")) selectors.environmentId = params.id;
    const scope = analyticsScopeFromSelectors(db, selectors);
    if (scope === null) {
      service.noteGap({ kind: "instance" });
      return next();
    }
    const metadata = analyticsRequestContext(context, service, scope);
    if (/^\/plugins\/[^/]+\/(rpc|http|cli)(\/|$)/.test(path) && scope.kind !== "project") metadata.scopeKnown = false;
    return runWithProductAnalytics(metadata, async () => {
      if (!route) return next();
      const intentional = metadata.intent || context.req.method !== "GET";
      if (!intentional) {
        return next();
      }
      const started = performance.now();
      service.record(route.featureId, route.action, "started");
      return withProductAnalyticsJsonResult(context, async (classify) => {
      try {
        await next();
        const result = classify(context.res) ?? outcomeForStatus(context.res.status);
        service.record(route.featureId, route.action, "completed", result.outcome, result.errorCode, performance.now() - started);
      } catch (error) {
        const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 500;
        const result = outcomeForStatus(status);
        service.record(route.featureId, route.action, "completed", result.outcome, result.errorCode, performance.now() - started);
        throw error;
      }
      });
    });
  };
}
