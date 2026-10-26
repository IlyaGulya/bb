import { getProjectContextDefaults, getThread, getThreadExecutionBinding, listExecutionContexts, listModelConnections } from "@bb/db";
import { publicApiRoutes, typedRoutes, type PublicApiSchema } from "@bb/server-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import {
  createExecutionContextDefinition, createModelConnectionDefinition,
  deleteConnectionDefinition, deleteContextDefinition,
  requireExecutionContext, requireModelConnection,
  updateExecutionContextDefinition, updateModelConnectionDefinition, updateProjectContextDefaults,
} from "../services/execution-contexts.js";

export function registerExecutionContextRoutes(app: Hono, deps: AppDeps): void {
  const { get, post, patch, del, put } = typedRoutes<PublicApiSchema>(app, { onValidationError: (message) => new ApiError(400, "invalid_request", message) });
  const contexts = publicApiRoutes.executionContexts;
  const connections = publicApiRoutes.modelConnections;
  get(contexts.list, (context) => context.json(listExecutionContexts(deps.db)));
  get(contexts.get, (context) => context.json(requireExecutionContext(deps.db, context.req.param("id"))));
  post(contexts.create, (context, input) => context.json(createExecutionContextDefinition(deps.db, input), 201));
  patch(contexts.update, (context, input) => context.json(updateExecutionContextDefinition(deps.db, input)));
  del(contexts.delete, (context, input) => {
    deleteContextDefinition(deps.db, input.id);
    return context.json({ id: input.id });
  });
  get(contexts.getProjectDefaults, (context) => context.json(getProjectContextDefaults(deps.db, context.req.param("id"))));
  put(contexts.setProjectDefaults, (context, input) => context.json(updateProjectContextDefaults(deps.db, input)));
  get(contexts.getThreadBinding, (context) => {
    const threadId = context.req.param("id");
    if (!getThread(deps.db, threadId)) throw new ApiError(404, "thread_not_found", `Thread ${threadId} does not exist`);
    return context.json(getThreadExecutionBinding(deps.db, threadId));
  });
  get(connections.list, (context) => context.json(listModelConnections(deps.db)));
  get(connections.get, (context) => context.json(requireModelConnection(deps.db, context.req.param("id"))));
  post(connections.create, (context, input) => context.json(createModelConnectionDefinition(deps.db, input), 201));
  patch(connections.update, (context, input) => context.json(updateModelConnectionDefinition(deps.db, input)));
  del(connections.delete, (context, input) => {
    deleteConnectionDefinition(deps.db, input.id);
    return context.json({ id: input.id });
  });
}
