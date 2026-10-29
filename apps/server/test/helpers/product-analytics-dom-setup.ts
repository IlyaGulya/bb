import { productAnalyticsEventSchema } from "@bb/server-contract";
import { seedEnvironment, seedThread } from "./seed.js";
import { SqliteQueueStore } from "./product-analytics-queue.js";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { TestProject } from "vitest/node";
import { z } from "zod";
import { createAnalyticsConsumer, installConsumerPlugin } from "./product-analytics-consumer.js";

declare module "vitest" {
  export interface ProvidedContext {
    analyticsConsumerServerUrl: string;
  }
}

interface AnalyticsBrowserFixtureContext {
  work: { id: string };
  personal: { id: string };
  pluginId: string | null;
  workThread: { id: string; projectId: string };
  secondWorkThread: { id: string; projectId: string };
  personalThread: { id: string; projectId: string };
}

export default async function setup(project: TestProject) {
  let active: Awaited<ReturnType<typeof createAnalyticsConsumer>> | null = null;
  let queue: SqliteQueueStore | null = null;
  const app = new Hono();
  const optionsSchema = z.object({ pluginSource: z.string().optional(), appSource: z.string().optional(), notifications: z.boolean().optional() }).strict();
  app.post("/__analytics_fixture", async (context) => {
    if (active !== null) return context.text("Previous analytics fixture is still active", 409);
    const options = optionsSchema.parse(await context.req.json());
    const fixture = await createAnalyticsConsumer();
    try {
      fixture.harness.config.serverPort = port;
      fixture.harness.pluginService.bindSdk({ baseUrl: `http://127.0.0.1:${port}` });
      const serverSource = options.notifications ? `import { defineRpcContract } from "@get-bb/plugin-sdk";
import { createNotificationPreferences } from "./preferences.js";
import { pushNotificationsRpcContract } from "./contract.js";
export default function plugin(bb) {
  const preferences = createNotificationPreferences({ bb, getDefaults: async () => ({ defaultLevel: "all", childLevel: "input-only" }), publish: (threads) => bb.realtime.publish("threadNotifications", { threads }) });
  bb.rpc.register(defineRpcContract({ "threadNotifications.list": pushNotificationsRpcContract["threadNotifications.list"], "threadNotifications.set": pushNotificationsRpcContract["threadNotifications.set"] }), {
    "threadNotifications.list": async ({ threadIds }) => ({ threads: await preferences.list(threadIds) }),
    "threadNotifications.set": ({ threadId, level }) => preferences.set(threadId, level),
  });
}` : options.pluginSource;
      const appSource = options.appSource ?? (options.notifications ? `import { definePluginApp } from "@get-bb/plugin-sdk/app"; import { notificationsThreadAction } from "./notificationsAction.js"; export default definePluginApp((app) => { app.slots.experimental_threadAction(notificationsThreadAction); });` : undefined);
      const sourceFiles = options.notifications ? ["preferences.ts", "contract.ts", "notificationsAction.ts"].map((name) => new URL(`../../../../plugins/push-notifications/${name}`, import.meta.url)) : [];
      const pluginId = serverSource === undefined ? null : (await installConsumerPlugin(fixture.harness, serverSource, { appSource, sourceFiles })).pluginId;
      const personalEnvironment = seedEnvironment(fixture.harness.deps, { hostId: fixture.host.id, projectId: fixture.personal.id, status: "ready" });
      const personalThread = seedThread(fixture.harness.deps, { projectId: fixture.personal.id, environmentId: personalEnvironment.id, status: "idle" });
      const secondWorkThread = seedThread(fixture.harness.deps, { projectId: fixture.work.id, environmentId: fixture.environment.id, status: "idle" });
      queue = new SqliteQueueStore(fixture.harness.db);
      active = fixture;
      return context.json({ work: { id: fixture.work.id }, personal: { id: fixture.personal.id }, pluginId, workThread: { id: fixture.thread.id, projectId: fixture.thread.projectId }, personalThread: { id: personalThread.id, projectId: personalThread.projectId }, secondWorkThread: { id: secondWorkThread.id, projectId: secondWorkThread.projectId } } satisfies AnalyticsBrowserFixtureContext);
    } catch (error) {
      await fixture.close();
      throw error;
    }
  });
  app.post("/__analytics_fixture/flush", (context) => {
    if (active === null) return context.text("Analytics fixture is not active", 409);
    active.collector.flush();
    return context.body(null, 204);
  });
  const queueEntry = z.object({ id: z.string(), event: productAnalyticsEventSchema }).strict();
  const settlement = z.object({ id: z.string(), status: z.enum(["accepted", "duplicate", "retry", "rejected"]) }).strict();
  app.post("/__analytics_fixture/queue/enqueue", async (context) => {
    if (queue === null) return context.text("Analytics fixture is not active", 409);
    return context.json(await queue.enqueue(queueEntry.parse(await context.req.json())));
  });
  app.post("/__analytics_fixture/queue/batch", async (context) => {
    if (queue === null) return context.text("Analytics fixture is not active", 409);
    return context.json(await queue.batch());
  });
  app.post("/__analytics_fixture/queue/settle", async (context) => {
    if (queue === null) return context.text("Analytics fixture is not active", 409);
    await queue.settle(z.array(settlement).parse(await context.req.json()));
    return context.body(null, 204);
  });
  app.post("/__analytics_fixture/queue/health", async (context) => {
    if (queue === null) return context.text("Analytics fixture is not active", 409);
    return context.json(await queue.health());
  });
  app.delete("/__analytics_fixture", async (context) => {
    const fixture = active;
    active = null;
    queue = null;
    await fixture?.close();
    return context.body(null, 204);
  });
  app.all("*", (context) => {
    if (active === null) return context.text("Analytics fixture is not active", 409);
    return active.harness.app.fetch(context.req.raw);
  });
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Analytics fixture did not bind a TCP port");
  const port = address.port;
  project.provide("analyticsConsumerServerUrl", `http://127.0.0.1:${port}`);
  return async () => {
    try {
      await active?.close();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}
