import { createNodeBbSdk, experimental_productAnalyticsRequestInit, type BbSdk } from "@bb/sdk/node";
import { productAnalyticsModeSchema } from "@bb/server-contract";
import type { Dispatcher } from "undici";

type CliRequestInit = RequestInit & { dispatcher?: Dispatcher };
const cliOperationId = crypto.randomUUID();

export function cliFetch(
  input: RequestInfo | URL,
  init?: CliRequestInit,
): Promise<Response> {
  const mode = productAnalyticsModeSchema.safeParse(process.env.BB_PRODUCT_ANALYTICS_MODE).data;
  return fetch(input, {
    ...init,
    ...experimental_productAnalyticsRequestInit({
      actorKind: process.env.BB_PRODUCT_ANALYTICS_SURFACE === "mcp" ? "unknown" : process.env.BB_THREAD_ID ? "agent" : process.stdin.isTTY ? "human" : "unknown",
      surface: process.env.BB_PRODUCT_ANALYTICS_SURFACE === "mcp" ? "mcp" : "cli",
      intentional: true,
      operationId: cliOperationId,
      ...(mode === undefined ? {} : { mode }),
      ...(process.env.BB_PROJECT_ID === undefined ? {} : { projectId: process.env.BB_PROJECT_ID }),
    }, init),
  });
}

export function createCliBbSdk(baseUrl: string): BbSdk {
  return createNodeBbSdk({ baseUrl, fetch: cliFetch });
}
