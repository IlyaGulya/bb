import { createBrowserBbSdk } from "@bb/sdk/browser";
import type { ProductAnalyticsReport } from "@bb/server-contract";
import { inject } from "vitest";
import { z } from "zod";

const contextSchema = z.object({
  work: z.object({ id: z.string() }),
  personal: z.object({ id: z.string() }),
  pluginId: z.string().nullable(),
});

export type AnalyticsBrowserFixtureContext = z.infer<typeof contextSchema>;

declare module "vitest" {
  export interface ProvidedContext {
    analyticsConsumerServerUrl: string;
  }
}

export async function withBrowserAnalyticsConsumer<T>(
  options: { pluginSource?: string },
  run: (fixture: AnalyticsBrowserFixtureContext & {
    forward(request: Request): Promise<Response>;
    report(projectId?: string): Promise<ProductAnalyticsReport>;
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
      forward(request) {
        const source = new URL(request.url);
        return fetchImpl(new Request(new URL(`${source.pathname}${source.search}`, baseUrl), request));
      },
      async report(projectId) {
        await control("POST", "/__analytics_fixture/flush");
        return sdk.experimental_productAnalytics.report({ days: 7, mode: "test", ...(projectId === undefined ? {} : { projectId }) });
      },
    });
  } finally {
    await control("DELETE", "/__analytics_fixture");
  }
}
