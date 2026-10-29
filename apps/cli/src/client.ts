import { createNodeBbSdk, experimental_productAnalyticsRequestInit, type BbSdk, type ExperimentalProductAnalyticsContext } from "@bb/sdk/node";
import { productAnalyticsModeSchema } from "@bb/server-contract";
import type { Dispatcher } from "undici";

type CliRequestInit = RequestInit & { dispatcher?: Dispatcher };
const cliOperationId = crypto.randomUUID();
export function cliAnalyticsContext(): ExperimentalProductAnalyticsContext {
  const mode = productAnalyticsModeSchema.safeParse(process.env.BB_PRODUCT_ANALYTICS_MODE).data;
  return { actorKind: process.env.BB_PRODUCT_ANALYTICS_SURFACE === "mcp" ? "unknown" : process.env.BB_THREAD_ID ? "agent" : process.stdin.isTTY ? "human" : "unknown", surface: process.env.BB_PRODUCT_ANALYTICS_SURFACE === "mcp" ? "mcp" : "cli", intentional: true, operationId: cliOperationId, ...(mode === undefined ? {} : { mode }), ...(process.env.BB_PROJECT_ID === undefined ? {} : { projectId: process.env.BB_PROJECT_ID }) };
}

export function cliFetch(
  input: RequestInfo | URL,
  init?: CliRequestInit,
): Promise<Response> {
  return fetch(input, {
    ...init,
    ...experimental_productAnalyticsRequestInit(cliAnalyticsContext(), init),
  });
}

export function createCliBbSdk(baseUrl: string): BbSdk {
  return createNodeBbSdk({ baseUrl, fetch: cliFetch });
}
