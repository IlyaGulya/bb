import { gatewayLogDirectory } from "../services/gateway-log-directory.js";
import {
  isModelGatewayProviderCompatible,
} from "@bb/domain";
import { getThread, getThreadExecutionBinding } from "@bb/db";
import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import type { AppDeps } from "../types.js";
import {
  downloadGatewayLog,
  gatewayLogManifest,
  listGatewayLogs,
  readGatewayLog,
} from "../services/gateway-logs.js";
import { gatewayLogCoverage } from "../services/gateway-log-coverage.js";


export function registerGatewayLogRoutes(app: Hono, deps: AppDeps): void {
  const { get } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });
  const routes = publicApiRoutes.gatewayLogs;
  function requireGatewayThread(threadId: string): string | undefined {
    if (!getThread(deps.db, threadId)) {
      throw new ApiError(404, "thread_not_found", "Thread does not exist.");
    }
    const connection = getThreadExecutionBinding(
      deps.db,
      threadId,
    )?.modelConnection;
    if (
      !connection?.gateway ||
      !isModelGatewayProviderCompatible(
        connection.provider,
        connection.gateway.protocol,
      )
    ) {
      throw new ApiError(
        409,
        "gateway_logs_unsupported",
        "This thread has no persisted CPA gateway binding.",
      );
    }
    return gatewayLogDirectory(
      connection.gateway.baseUrl,
      process.env.BB_CPA_LOG_DIRS,
    );
  }
  get(routes.coverage, (context, query) => {
    if (!getThread(deps.db, query.threadId)) {
      throw new ApiError(404, "thread_not_found", "Thread does not exist.");
    }
    const binding = getThreadExecutionBinding(deps.db, query.threadId);
    const connection = binding?.modelConnection;
    const gatewayCompatible = connection?.gateway !== null &&
      connection?.gateway !== undefined &&
      isModelGatewayProviderCompatible(connection.provider, connection.gateway.protocol);
    const directory = gatewayCompatible && connection?.gateway
      ? gatewayLogDirectory(connection.gateway.baseUrl, process.env.BB_CPA_LOG_DIRS)
      : undefined;
    context.header("cache-control", "private, no-store");
    return context.json(gatewayLogCoverage({
      threadId: query.threadId,
      binding,
      gatewayCompatible,
      logRootMapped: directory !== undefined,
    }));
  });
  get(routes.manifest, async (context, query) => {
    const directory = requireGatewayThread(query.threadId);
    context.header("cache-control", "private, no-store");
    return context.json(await gatewayLogManifest(directory, query.threadId, context.req.param("logId")));
  });
  get(routes.list, async (context, query) => {
    const directory = requireGatewayThread(query.threadId);
    context.header("cache-control", "private, no-store");
    return context.json(await listGatewayLogs(directory, query.threadId));
  });
  get(routes.read, async (context, query) => {
    const directory = requireGatewayThread(query.threadId);
    context.header("cache-control", "private, no-store");
    return context.json(
      await readGatewayLog(
        directory,
        query.threadId,
        context.req.param("logId"),
        query.previewBytes,
      ),
    );
  });
  get(routes.download, async (context, query) => {
    const directory = requireGatewayThread(query.threadId);
    return downloadGatewayLog(
      directory,
      query.threadId,
      context.req.param("logId"),
    );
  });
}
