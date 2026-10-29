import {
  executionContextSchema,
  inspectMcpRequestSchema,
  mcpConfigurationInspectionSchema,
  modelConnectionSchema,
  projectContextDefaultsSchema,
  threadExecutionBindingSchema,
  threadExecutionEligibilitySchema,
  type CreateExecutionContextRequest,
  type UpdateExecutionContextRequest,
  type CreateModelConnectionRequest,
  type UpdateModelConnectionRequest,
} from "@bb/server-contract";
import type {
  ExecutionContext,
  InspectMcpRequest,
  McpConfigurationInspection,
  ModelConnection,
  ProjectContextDefaults,
  ThreadExecutionBinding,
  ThreadExecutionEligibility,
} from "@bb/domain";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export interface ContextListArgs {
  signal?: AbortSignal;
}
export interface ExecutionContextsArea {
  inspectMcp(args: InspectMcpRequest): Promise<McpConfigurationInspection>;
  list(args?: ContextListArgs): Promise<ExecutionContext[]>;
  get(args: { id: string }): Promise<ExecutionContext>;
  create(args: CreateExecutionContextRequest): Promise<ExecutionContext>;
  update(args: UpdateExecutionContextRequest): Promise<ExecutionContext>;
  delete(args: { id: string }): Promise<void>;
  getProjectDefaults(args: {
    projectId: string;
  }): Promise<ProjectContextDefaults>;
  setProjectDefaults(
    args: ProjectContextDefaults,
  ): Promise<ProjectContextDefaults>;
  getThreadBinding(args: {
    threadId: string;
  }): Promise<ThreadExecutionBinding | null>;
  getThreadEligibility(args: {
    threadId: string;
  }): Promise<ThreadExecutionEligibility>;
}
export interface ModelConnectionsArea {
  list(args?: ContextListArgs): Promise<ModelConnection[]>;
  get(args: { id: string }): Promise<ModelConnection>;
  create(args: CreateModelConnectionRequest): Promise<ModelConnection>;
  update(args: UpdateModelConnectionRequest): Promise<ModelConnection>;
  delete(args: { id: string }): Promise<void>;
}

export function createExecutionContextsArea({
  transport,
}: CreateSdkAreaArgs): ExecutionContextsArea {
  const api = transport.api.v1["execution-contexts"];
  return {
    async inspectMcp(input) {
      return mcpConfigurationInspectionSchema.parse(
        await transport.readJson(
          api.mcp.inspect.$post({ json: inspectMcpRequestSchema.parse(input) }),
        ),
      );
    },
    async list(input) {
      return executionContextSchema
        .array()
        .parse(
          await transport.readJson(
            api.$get({}, ...signalRequestArgs(input?.signal)),
          ),
        );
    },
    async get(input) {
      return executionContextSchema.parse(
        await transport.readJson(api[":id"].$get({ param: { id: input.id } })),
      );
    },
    async create(input) {
      return executionContextSchema.parse(
        await transport.readJson(api.$post({ json: input })),
      );
    },
    async update(input) {
      return executionContextSchema.parse(
        await transport.readJson(api.$patch({ json: input })),
      );
    },
    async delete(input) {
      await transport.readJson(api.$delete({ json: input }));
    },
    async getProjectDefaults(input) {
      return projectContextDefaultsSchema.parse(
        await transport.readJson(
          api["project-defaults"][":id"].$get({
            param: { id: input.projectId },
          }),
        ),
      );
    },
    async setProjectDefaults(input) {
      return projectContextDefaultsSchema.parse(
        await transport.readJson(api["project-defaults"].$put({ json: input })),
      );
    },
    async getThreadBinding(input) {
      return threadExecutionBindingSchema.nullable().parse(
        await transport.readJson(
          api["thread-binding"][":id"].$get({
            param: { id: input.threadId },
          }),
        ),
      );
    },
    async getThreadEligibility(input) {
      return threadExecutionEligibilitySchema.parse(
        await transport.readJson(
          api["thread-eligibility"][":id"].$get({
            param: { id: input.threadId },
          }),
        ),
      );
    },
  };
}

export function createModelConnectionsArea({
  transport,
}: CreateSdkAreaArgs): ModelConnectionsArea {
  const api = transport.api.v1["model-connections"];
  return {
    async list(input) {
      return modelConnectionSchema
        .array()
        .parse(
          await transport.readJson(
            api.$get({}, ...signalRequestArgs(input?.signal)),
          ),
        );
    },
    async get(input) {
      return modelConnectionSchema.parse(
        await transport.readJson(api[":id"].$get({ param: { id: input.id } })),
      );
    },
    async create(input) {
      return modelConnectionSchema.parse(
        await transport.readJson(api.$post({ json: input })),
      );
    },
    async update(input) {
      return modelConnectionSchema.parse(
        await transport.readJson(api.$patch({ json: input })),
      );
    },
    async delete(input) {
      await transport.readJson(api.$delete({ json: input }));
    },
  };
}
