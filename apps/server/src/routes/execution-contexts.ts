import {
  getProjectContextDefaults,
  getThread,
  getThreadExecutionBinding,
  listExecutionContexts,
  listModelConnections,
} from "@bb/db";
import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import {
  createExecutionContextDefinition,
  createModelConnectionDefinition,
  deleteConnectionDefinition,
  deleteContextDefinition,
  inspectExecutionContextMcp,
  requireExecutionContext,
  requireModelConnection,
  updateExecutionContextDefinition,
  updateModelConnectionDefinition,
  updateProjectContextDefaults,
} from "../services/execution-contexts.js";

export function registerExecutionContextRoutes(app: Hono, deps: AppDeps): void {
  const { get, post, patch, del, put } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });
  const contexts = publicApiRoutes.executionContexts;
  const connections = publicApiRoutes.modelConnections;
  post(contexts.inspectMcp, async (context, input) =>
    context.json(await inspectExecutionContextMcp(deps, input)),
  );
  get(contexts.list, (context) => context.json(listExecutionContexts(deps.db)));
  get(contexts.get, (context) =>
    context.json(requireExecutionContext(deps.db, context.req.param("id"))),
  );
  post(contexts.create, (context, input) => {
    const result = createExecutionContextDefinition(deps.db, input);
    deps.hub.notifySystem(["execution-contexts-changed"], result.id);
    return context.json(result, 201);
  });
  patch(contexts.update, (context, input) => {
    const result = updateExecutionContextDefinition(deps.db, input);
    deps.hub.notifySystem(["execution-contexts-changed"], result.id);
    return context.json(result);
  });
  del(contexts.delete, (context, input) => {
    deleteContextDefinition(deps.db, input.id);
    deps.hub.notifySystem(["execution-contexts-changed"], input.id);
    return context.json({ id: input.id });
  });
  get(contexts.getProjectDefaults, (context) =>
    context.json(getProjectContextDefaults(deps.db, context.req.param("id"))),
  );
  put(contexts.setProjectDefaults, (context, input) => {
    const result = updateProjectContextDefaults(deps.db, input);
    deps.hub.notifySystem(["project-context-defaults-changed"], result.projectId);
    return context.json(result);
  });
  get(contexts.getThreadBinding, (context) => {
    const threadId = context.req.param("id");
    if (!getThread(deps.db, threadId))
      throw new ApiError(
        404,
        "thread_not_found",
        `Thread ${threadId} does not exist`,
      );
    return context.json(getThreadExecutionBinding(deps.db, threadId));
  });
  get(connections.list, (context) =>
    context.json(listModelConnections(deps.db)),
  );
  get(connections.get, (context) =>
    context.json(requireModelConnection(deps.db, context.req.param("id"))),
  );
  post(connections.create, (context, input) => {
    const result = createModelConnectionDefinition(deps.db, input);
    deps.hub.notifySystem(["model-connections-changed"], result.id);
    return context.json(result, 201);
  });
  patch(connections.update, (context, input) => {
    const result = updateModelConnectionDefinition(deps.db, input);
    deps.hub.notifySystem(["model-connections-changed"], result.id);
    return context.json(result);
  });
  del(connections.delete, (context, input) => {
    deleteConnectionDefinition(deps.db, input.id);
    deps.hub.notifySystem(["model-connections-changed"], input.id);
    return context.json({ id: input.id });
  });
}
