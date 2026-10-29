import { createBrowserBbSdk } from "@bb/sdk/browser";
import { productAnalyticsEventSchema, type ProductAnalyticsReport } from "@bb/server-contract";
import type { ExperimentalAnalyticsQueueStore } from "@bb/sdk/browser";
import { inject } from "vitest";
import { z } from "zod";

const contextSchema = z.object({
  work: z.object({ id: z.string() }),
  personal: z.object({ id: z.string() }),
  pluginId: z.string().nullable(),
  workThread: z.object({ id: z.string(), projectId: z.string() }),
  secondWorkThread: z.object({ id: z.string(), projectId: z.string() }),
  personalThread: z.object({ id: z.string(), projectId: z.string() }),
});

export type AnalyticsBrowserFixtureContext = z.infer<typeof contextSchema>;

declare module "vitest" {
  export interface ProvidedContext {
    analyticsConsumerServerUrl: string;
  }
}

export async function withBrowserAnalyticsConsumer<T>(
  options: { pluginSource?: string; appSource?: string; notifications?: boolean },
  run: (fixture: AnalyticsBrowserFixtureContext & {
    forward(request: Request): Promise<Response>;
    report(projectId?: string): Promise<ProductAnalyticsReport>;
    queue: ExperimentalAnalyticsQueueStore;
  }) => Promise<T>,
): Promise<T> {
  const baseUrl = inject("analyticsConsumerServerUrl");
  const fetchImpl = globalThis.fetch.bind(globalThis);
  const control = async (method: "POST" | "DELETE", path: string, body?: string) => {
    const response = await fetchImpl(new URL(path, baseUrl), {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body }),
    });
    if (!response.ok) throw new Error(`Analytics test fixture ${method} failed: ${response.status}`);
    return response;
  };
  const response = await control("POST", "/__analytics_fixture", JSON.stringify(options));
  try {
    const context = contextSchema.parse(await response.json());
    const sdk = createBrowserBbSdk({ baseUrl, fetch: fetchImpl });
    return await run({
      ...context,
      async forward(request) {
        const source = new URL(request.url);
        return fetchImpl(new URL(`${source.pathname}${source.search}`, baseUrl), {
          method: request.method,
          headers: request.headers,
          ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: await request.arrayBuffer() }),
          signal: request.signal,
        });
      },
      async report(projectId) {
        await control("POST", "/__analytics_fixture/flush");
        return sdk.experimental_productAnalytics.report({ days: 7, mode: "test", ...(projectId === undefined ? {} : { projectId }) });
      },
      queue: {
        async enqueue(entry) { return z.boolean().parse(await (await control("POST", "/__analytics_fixture/queue/enqueue", JSON.stringify(entry))).json()); },
        async batch() { return z.array(z.object({ id: z.string(), event: productAnalyticsEventSchema }).strict()).parse(await (await control("POST", "/__analytics_fixture/queue/batch")).json()); },
        async settle(entries) { await control("POST", "/__analytics_fixture/queue/settle", JSON.stringify(entries)); },
        async health() { return z.object({ pending: z.number(), failed: z.number(), gaps: z.number(), expired: z.number(), storage: z.enum(["healthy", "unavailable"]) }).strict().parse(await (await control("POST", "/__analytics_fixture/queue/health")).json()); },
      },
    });
  } finally {
    await control("DELETE", "/__analytics_fixture");
  }
}
