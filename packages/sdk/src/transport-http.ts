import { experimental_createProductAnalyticsFetch } from "./product-analytics.js";
import { createApiClient, PRODUCT_ANALYTICS_HEADERS } from "@bb/server-contract";
import {
  readJsonResponse,
  readVoidResponse,
  resolveResponse,
} from "./response.js";
import type { BbSdkTransport, CreateHttpTransportArgs } from "./transport.js";

const SAME_ORIGIN_BASE_URL = "";

export function createHttpTransport(
  args: CreateHttpTransportArgs,
): BbSdkTransport {
  const baseUrl = args.baseUrl ?? SAME_ORIGIN_BASE_URL;
  const underlyingFetch = args.fetch ?? experimental_createProductAnalyticsFetch({ actorKind: "unknown", surface: args.runtime === "node" ? "sdk" : "web" });
  const fetchImpl: typeof underlyingFetch = (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has(PRODUCT_ANALYTICS_HEADERS.origin)) headers.set(PRODUCT_ANALYTICS_HEADERS.origin, args.runtime === "node" ? "sdk" : "web");
    return underlyingFetch(input, { ...init, headers });
  };
  const client = createApiClient(baseUrl, { fetch: fetchImpl });

  return {
    api: client.api,
    baseUrl,
    fetch: fetchImpl,
    ...(args.realtimeUrl ? { realtimeUrl: args.realtimeUrl } : {}),
    runtime: args.runtime,
    websocket: args.websocket,
    readJson: readJsonResponse,
    readVoid: readVoidResponse,
    resolve: resolveResponse,
  };
}
