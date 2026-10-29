import type { GatewayLogCoverage, GatewayLogManifest, GatewayLogList, GatewayLogPreview } from "@bb/server-contract";
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

export type { GatewayLogCoverage, GatewayLogManifest, GatewayLogList, GatewayLogPreview } from "@bb/server-contract";

export interface ExperimentalGatewayLogsArea {
  coverage(args: GatewayLogListArgs): Promise<GatewayLogCoverage>;
  manifest(args: GatewayLogDownloadArgs): Promise<GatewayLogManifest>;
  list(args: GatewayLogListArgs): Promise<GatewayLogList>;
  read(args: GatewayLogReadArgs): Promise<GatewayLogPreview>;
  download(args: GatewayLogDownloadArgs): Promise<Blob>;
}

export function createGatewayLogsArea({
  transport,
}: CreateSdkAreaArgs): ExperimentalGatewayLogsArea {
  const api = transport.api.v1["gateway-logs"];
  return {
    async coverage(input) {
      return transport.readJson(api.coverage.$get(
        { query: { threadId: input.threadId } },
        ...signalRequestArgs(input.signal),
      ));
    },
    async manifest(input) {
      return transport.readJson(api[":logId"].manifest.$get(
        { param: { logId: input.logId }, query: { threadId: input.threadId } },
        ...signalRequestArgs(input.signal),
      ));
    },
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
