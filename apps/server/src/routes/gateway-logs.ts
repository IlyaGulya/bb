import { getThread, getThreadExecutionBinding } from "@bb/db";
import { publicApiRoutes, typedRoutes, type PublicApiSchema } from "@bb/server-contract";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import type { AppDeps } from "../types.js";
import { downloadGatewayLog, listGatewayLogs, readGatewayLog } from "../services/gateway-logs.js";

export function registerGatewayLogRoutes(app: Hono, deps: AppDeps): void {
  const { get } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) => new ApiError(400, "invalid_request", message),
  });
  const routes = publicApiRoutes.gatewayLogs;
  function requireGatewayThread(threadId: string): void {
    if (!getThread(deps.db, threadId)) {
      throw new ApiError(404, "thread_not_found", "Thread does not exist.");
    }
    const connection = getThreadExecutionBinding(deps.db, threadId)?.modelConnection;
    if (connection?.provider !== "acp-omp" || !connection.gateway) {
      throw new ApiError(409, "gateway_logs_unsupported", "This thread has no persisted CPA gateway binding.");
    }
  }
  get(routes.list, async (context, query) => {
    requireGatewayThread(query.threadId);
    context.header("cache-control", "private, no-store");
    return context.json(await listGatewayLogs(process.env.BB_CPA_LOG_DIR, query.threadId));
  });
  get(routes.read, async (context, query) => {
    requireGatewayThread(query.threadId);
    context.header("cache-control", "private, no-store");
    return context.json(await readGatewayLog(process.env.BB_CPA_LOG_DIR, query.threadId, context.req.param("logId"), query.previewBytes));
  });
  get(routes.download, async (context, query) => {
    requireGatewayThread(query.threadId);
    return downloadGatewayLog(process.env.BB_CPA_LOG_DIR, query.threadId, context.req.param("logId"));
  });
}
