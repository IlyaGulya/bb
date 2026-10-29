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
}

export default async function setup(project: TestProject) {
  let active: Awaited<ReturnType<typeof createAnalyticsConsumer>> | null = null;
  const app = new Hono();
  const optionsSchema = z.object({ pluginSource: z.string().optional() }).strict();
  app.post("/__analytics_fixture", async (context) => {
    if (active !== null) return context.text("Previous analytics fixture is still active", 409);
    const options = optionsSchema.parse(await context.req.json());
    const fixture = await createAnalyticsConsumer();
    try {
      fixture.harness.config.serverPort = port;
      fixture.harness.pluginService.bindSdk({ baseUrl: `http://127.0.0.1:${port}` });
      const pluginId = options.pluginSource === undefined ? null : (await installConsumerPlugin(fixture.harness, options.pluginSource)).pluginId;
      active = fixture;
      return context.json({ work: { id: fixture.work.id }, personal: { id: fixture.personal.id }, pluginId } satisfies AnalyticsBrowserFixtureContext);
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
  app.delete("/__analytics_fixture", async (context) => {
    const fixture = active;
    active = null;
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
