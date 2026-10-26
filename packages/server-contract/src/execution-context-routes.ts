import {
  defineRoute,
  jsonRequest,
  jsonResponse,
  noRequest,
  type EmptyInput,
} from "@bb/hono-typed-routes";
import type {
  ExecutionContext,
  InspectMcpRequest,
  McpConfigurationInspection,
  ModelConnection,
  ProjectContextDefaults,
  ThreadExecutionBinding,
} from "@bb/domain";
import {
  createExecutionContextRequestSchema,
  inspectMcpRequestSchema,
  updateExecutionContextRequestSchema,
  createModelConnectionRequestSchema,
  updateModelConnectionRequestSchema,
  setProjectContextDefaultsRequestSchema,
  contextIdRequestSchema,
  type CreateExecutionContextRequest,
  type UpdateExecutionContextRequest,
  type CreateModelConnectionRequest,
  type UpdateModelConnectionRequest,
} from "./api/execution-contexts.js";

type IdInput = { param: { id: string } };

export const executionContextRoutes = {
  executionContexts: {
    inspectMcp: defineRoute({
      path: "/execution-contexts/mcp/inspect",
      method: "post",
      request: jsonRequest<EmptyInput, InspectMcpRequest>(
        inspectMcpRequestSchema,
      ),
      response: jsonResponse<McpConfigurationInspection>(),
    }),
    list: defineRoute({
      path: "/execution-contexts",
      method: "get",
      request: noRequest<EmptyInput>(),
      response: jsonResponse<ExecutionContext[]>(),
    }),
    get: defineRoute({
      path: "/execution-contexts/:id",
      method: "get",
      request: noRequest<IdInput>(),
      response: jsonResponse<ExecutionContext>(),
    }),
    create: defineRoute({
      path: "/execution-contexts",
      method: "post",
      request: jsonRequest<
        EmptyInput,
        CreateExecutionContextRequest,
        typeof createExecutionContextRequestSchema
      >(createExecutionContextRequestSchema),
      response: jsonResponse<ExecutionContext>({ status: 201 }),
    }),
    update: defineRoute({
      path: "/execution-contexts",
      method: "patch",
      request: jsonRequest<EmptyInput, UpdateExecutionContextRequest>(
        updateExecutionContextRequestSchema,
      ),
      response: jsonResponse<ExecutionContext>(),
    }),
    delete: defineRoute({
      path: "/execution-contexts",
      method: "delete",
      request: jsonRequest<EmptyInput, { id: string }>(contextIdRequestSchema),
      response: jsonResponse<{ id: string }>(),
    }),
    getProjectDefaults: defineRoute({
      path: "/execution-contexts/project-defaults/:id",
      method: "get",
      request: noRequest<IdInput>(),
      response: jsonResponse<ProjectContextDefaults>(),
    }),
    setProjectDefaults: defineRoute({
      path: "/execution-contexts/project-defaults",
      method: "put",
      request: jsonRequest<EmptyInput, ProjectContextDefaults>(
        setProjectContextDefaultsRequestSchema,
      ),
      response: jsonResponse<ProjectContextDefaults>(),
    }),
    getThreadBinding: defineRoute({
      path: "/execution-contexts/thread-binding/:id",
      method: "get",
      request: noRequest<IdInput>(),
      response: jsonResponse<ThreadExecutionBinding | null>(),
    }),
  },
  modelConnections: {
    list: defineRoute({
      path: "/model-connections",
      method: "get",
      request: noRequest<EmptyInput>(),
      response: jsonResponse<ModelConnection[]>(),
    }),
    get: defineRoute({
      path: "/model-connections/:id",
      method: "get",
      request: noRequest<IdInput>(),
      response: jsonResponse<ModelConnection>(),
    }),
    create: defineRoute({
      path: "/model-connections",
      method: "post",
      request: jsonRequest<
        EmptyInput,
        CreateModelConnectionRequest,
        typeof createModelConnectionRequestSchema
      >(createModelConnectionRequestSchema),
      response: jsonResponse<ModelConnection>({ status: 201 }),
    }),
    update: defineRoute({
      path: "/model-connections",
      method: "patch",
      request: jsonRequest<EmptyInput, UpdateModelConnectionRequest>(
        updateModelConnectionRequestSchema,
      ),
      response: jsonResponse<ModelConnection>(),
    }),
    delete: defineRoute({
      path: "/model-connections",
      method: "delete",
      request: jsonRequest<EmptyInput, { id: string }>(contextIdRequestSchema),
      response: jsonResponse<{ id: string }>(),
    }),
  },
};
