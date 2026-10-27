import type { GatewayLogList, GatewayLogPreview } from "@bb/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export interface GatewayLogListArgs {
  threadId: string;
  signal?: AbortSignal;
}

export interface GatewayLogDownloadArgs extends GatewayLogListArgs {
  logId: string;
}

export interface GatewayLogReadArgs extends GatewayLogDownloadArgs {
  previewBytes?: number;
}

export type { GatewayLogList, GatewayLogPreview } from "@bb/server-contract";

/**
 * Native CPA request logs linked by a persisted gateway binding and exact inbound
 * X-BB-Thread-Id header. This is trusted-pilot correlation, not cryptographic
 * ownership, per-run authorization, per-turn attribution, or lossless capture.
 * Requests use the same protected BB application API as other SDK areas.
 */
export interface ExperimentalGatewayLogsArea {
  list(args: GatewayLogListArgs): Promise<GatewayLogList>;
  read(args: GatewayLogReadArgs): Promise<GatewayLogPreview>;
  download(args: GatewayLogDownloadArgs): Promise<Blob>;
}

export function createGatewayLogsArea({
  transport,
}: CreateSdkAreaArgs): ExperimentalGatewayLogsArea {
  const api = transport.api.v1["gateway-logs"];
  return {
    async list(input) {
      return transport.readJson(
        api.$get(
          { query: { threadId: input.threadId } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async read(input) {
      return transport.readJson(
        api[":logId"].$get(
          {
            param: { logId: input.logId },
            query: {
              threadId: input.threadId,
              previewBytes: input.previewBytes ?? 65536,
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async download(input) {
      const response = await transport.resolve(
        api[":logId"].download.$get(
          {
            param: { logId: input.logId },
            query: { threadId: input.threadId },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
      return new Blob([await response.arrayBuffer()], {
        type:
          response.headers.get("content-type") ?? "application/octet-stream",
      });
    },
  };
}
