import { randomUUID } from "node:crypto";
import {
  deleteExecutionContext,
  deleteModelConnection,
  getExecutionContext,
  getHost,
  getModelConnection,
  getProject,
  getProjectContextDefaults,
  isSqliteForeignKeyConstraint,
  saveExecutionContext,
  saveModelConnection,
  setProjectContextDefaults,
  type DbConnection,
} from "@bb/db";
import {
  isModelGatewayProviderCompatible,
  executionContextSchema,
  modelConnectionSchema,
  inspectMcpRequestSchema,
  validateSelectedMcpServers,
  type InspectMcpRequest,
  type McpConfigurationInspection,
  type ExecutionContext,
  type ModelConnection,
  type ProjectContextDefaults,
  type ResolvedThreadExecutionBinding,
} from "@bb/domain";
import type {
  ParsedCreateExecutionContextRequest,
  UpdateExecutionContextRequest,
  ParsedCreateModelConnectionRequest,
  UpdateModelConnectionRequest,
} from "@bb/server-contract";
import { ApiError } from "../errors.js";
import type { WorkSessionDeps } from "../types.js";
import { callHostOnlineRpc } from "./hosts/online-rpc.js";

export async function inspectExecutionContextMcp(
  deps: WorkSessionDeps,
  args: InspectMcpRequest,
): Promise<McpConfigurationInspection> {
  if (args.providerId !== "claude-code" && args.providerId !== "acp-omp")
    throw new ApiError(
      400,
      "mcp_inspection_provider_unsupported",
      "MCP configuration inspection is unavailable for this provider.",
    );
  if (!inspectMcpRequestSchema.safeParse(args).success)
    throw new ApiError(
      400,
      "mcp_inspection_invalid_request",
      "MCP inspection requires at most 16 absolute configuration paths.",
    );
  try {
    const result = await callHostOnlineRpc(deps, {
      hostId: args.hostId,
      timeoutMs: 30_000,
      command: {
        type: "host.inspect_mcp_sources",
        providerId: args.providerId,
        configPaths: args.configPaths,
      },
    });
    return { hostId: args.hostId, providerId: args.providerId, ...result };
  } catch {
    throw new ApiError(
      409,
      "mcp_inspection_unavailable",
      "MCP configuration could not be inspected on the execution host.",
    );
  }
}

export async function assertSelectedExecutionContextMcp(
  deps: WorkSessionDeps,
  args: {
    binding: ResolvedThreadExecutionBinding | null;
    hostId: string | null;
    providerId: string;
  },
): Promise<void> {
  const refs = args.binding?.executionContext?.mcpServers ?? [];
  if (refs.length === 0) return;
  if (args.hostId === null)
    throw new ApiError(
      400,
      "execution_context_host_required",
      "Selected MCP servers require a concrete execution host.",
    );
  const inspection = await inspectExecutionContextMcp(deps, {
    hostId: args.hostId,
    providerId: args.providerId,
    configPaths: [...new Set(refs.map((ref) => ref.configPath))],
  });
  const issue = validateSelectedMcpServers(refs, inspection);
  if (issue !== null)
    throw new ApiError(400, "execution_context_mcp_invalid", issue);
}

function requireProject(db: DbConnection, projectId: string): void {
  const project = getProject(db, projectId);
  if (!project || project.deletedAt !== null)
    throw new ApiError(
      404,
      "project_not_found",
      `Project ${projectId} is unavailable`,
    );
}

export function requireExecutionContext(
  db: DbConnection,
  id: string,
): ExecutionContext {
  const context = getExecutionContext(db, id);
  if (!context)
    throw new ApiError(
      404,
      "execution_context_not_found",
      `Execution context ${id} does not exist; select an available context`,
    );
  return context;
}

export function requireModelConnection(
  db: DbConnection,
  id: string,
): ModelConnection {
  const connection = getModelConnection(db, id);
  if (!connection)
    throw new ApiError(
      404,
      "model_connection_not_found",
      `Model connection ${id} does not exist; select an available connection`,
    );
  return connection;
}

function requireEnabledContext(
  context: ExecutionContext,
  projectId: string,
): void {
  if (!context.enabled)
    throw new ApiError(
      409,
      "execution_context_disabled",
      `Execution context ${context.name} is disabled; enable it or select another context`,
    );
  if (!context.projectIds.includes(projectId))
    throw new ApiError(
      400,
      "execution_context_project_mismatch",
      `Project ${projectId} is not a member of execution context ${context.name}; add project membership or select another context`,
    );
}

export function resolveProjectExecutionContext(
  db: DbConnection,
  args: { projectId: string; executionContextId?: string },
): ExecutionContext | null {
  const id =
    args.executionContextId ??
    getProjectContextDefaults(db, args.projectId).executionContextId;
  if (!id) return null;
  requireProject(db, args.projectId);
  const context = requireExecutionContext(db, id);
  requireEnabledContext(context, args.projectId);
  return context;
}

export function requireEnabledConnection(connection: ModelConnection): void {
  if (connection.revoked)
    throw new ApiError(
      409,
      "model_connection_revoked",
      `Model connection ${connection.name} is revoked; select another connection`,
    );
  if (!connection.enabled)
    throw new ApiError(
      409,
      "model_connection_disabled",
      `Model connection ${connection.name} is disabled; enable it or select another connection`,
    );
}

function requireAvailableExecutionHost(db: DbConnection, hostId: string): void {
  const host = getHost(db, hostId);
  if (
    !host ||
    host.destroyedAt !== null ||
    host.phase === "destroyed" ||
    host.phase === "removing"
  )
    throw new ApiError(
      409,
      "model_connection_host_unavailable",
      `Execution host ${hostId} is unavailable; select an available host and connection`,
    );
}

export function assertModelConnectionHostAuthorized(
  connection: ModelConnection,
  hostId: string,
  providerId?: string,
): void {
  if (
    (connection.gateway !== null &&
      !isModelGatewayProviderCompatible(
        connection.provider,
        connection.gateway.protocol,
      )) ||
    (providerId !== undefined && connection.provider !== providerId)
  )
    throw new ApiError(
      400,
      "model_connection_provider_mismatch",
      `Connection ${connection.name} is incompatible with provider ${providerId ?? connection.provider}; select its provider or another connection`,
    );
  if (connection.gateway !== null) {
    if (!connection.gateway.allowedHostIds.includes(hostId))
      throw new ApiError(
        400,
        "model_connection_host_mismatch",
        `Connection ${connection.name} does not authorize execution host ${hostId}; select an allowed execution host`,
      );
  } else if (connection.hostId !== hostId)
    throw new ApiError(
      400,
      "model_connection_host_mismatch",
      `Connection ${connection.name} belongs to host ${connection.hostId}, not execution host ${hostId}; select a connection on the execution host`,
    );
}

export interface ResolveThreadExecutionBindingArgs {
  projectId: string;
  hostId: string | null;
  provider?: string;
  executionContextId?: string;
  modelConnectionId?: string;
  presetExecutionContextId?: string | null;
  presetModelConnectionId?: string | null;
}

export function resolveThreadExecutionBinding(
  db: DbConnection,
  args: ResolveThreadExecutionBindingArgs,
): ResolvedThreadExecutionBinding | null {
  const defaults = getProjectContextDefaults(db, args.projectId);
  const contextId =
    args.executionContextId ??
    args.presetExecutionContextId ??
    defaults.executionContextId;
  const executionContext = contextId
    ? requireExecutionContext(db, contextId)
    : null;
  const connectionId =
    args.modelConnectionId ??
    args.presetModelConnectionId ??
    defaults.modelConnectionId ??
    executionContext?.defaultModelConnectionId;
  if (!executionContext && !connectionId) return null;
  requireProject(db, args.projectId);
  if (!args.hostId)
    throw new ApiError(
      400,
      "execution_context_host_required",
      "Scoped context or model connection selection requires a concrete execution host; select an existing host environment",
    );
  requireAvailableExecutionHost(db, args.hostId);
  if (executionContext) requireEnabledContext(executionContext, args.projectId);
  const modelConnection = connectionId
    ? requireModelConnection(db, connectionId)
    : null;
  if (modelConnection) {
    requireEnabledConnection(modelConnection);
    assertModelConnectionHostAuthorized(
      modelConnection,
      args.hostId,
      args.provider,
    );
  }
  return { executionContext, modelConnection, createdAt: Date.now() };
}

export function assertThreadExecutionBindingAvailable(
  db: DbConnection,
  binding: ResolvedThreadExecutionBinding | null,
  hostId?: string | null,
  providerId?: string,
): void {
  if (binding?.modelConnection) {
    const snapshot = binding.modelConnection;
    const current = requireModelConnection(db, snapshot.id);
    requireEnabledConnection(current);
    requireEnabledConnection(snapshot);
    const executionHostId =
      hostId ?? (snapshot.gateway === null ? snapshot.hostId : null);
    if (executionHostId !== null) {
      requireAvailableExecutionHost(db, executionHostId);
      assertModelConnectionHostAuthorized(
        snapshot,
        executionHostId,
        providerId,
      );
      assertModelConnectionHostAuthorized(
        current,
        executionHostId,
        providerId ?? snapshot.provider,
      );
    }
  }
  if (binding?.executionContext) {
    const current = requireExecutionContext(db, binding.executionContext.id);
    if (!current.enabled)
      throw new ApiError(
        409,
        "execution_context_disabled",
        `Execution context ${current.name} is disabled; enable it before continuing this thread`,
      );
  }
}

function validateContextDefinition(
  db: DbConnection,
  value: ExecutionContext,
): void {
  for (const projectId of value.projectIds) requireProject(db, projectId);
  if (new Set(value.projectIds).size !== value.projectIds.length)
    throw new ApiError(
      400,
      "duplicate_project_membership",
      "Execution context project membership must not contain duplicates",
    );
  if (value.defaultModelConnectionId)
    requireEnabledConnection(
      requireModelConnection(db, value.defaultModelConnectionId),
    );
  const previous = getExecutionContext(db, value.id);
  if (previous) {
    for (const projectId of previous.projectIds) {
      if (
        !value.projectIds.includes(projectId) &&
        getProjectContextDefaults(db, projectId).executionContextId === value.id
      )
        throw new ApiError(
          409,
          "execution_context_in_use",
          `Project ${projectId} defaults to this context; clear or replace its default before removing membership`,
        );
    }
  }
}

export function createExecutionContextDefinition(
  db: DbConnection,
  input: ParsedCreateExecutionContextRequest,
): ExecutionContext {
  const now = Date.now();
  const value = executionContextSchema.parse({
    ...input,
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
  });
  validateContextDefinition(db, value);
  return saveExecutionContext(db, value);
}

export function updateExecutionContextDefinition(
  db: DbConnection,
  input: UpdateExecutionContextRequest,
): ExecutionContext {
  const previous = requireExecutionContext(db, input.id);
  const value = executionContextSchema.parse({
    ...previous,
    ...input,
    updatedAt: Date.now(),
  });
  validateContextDefinition(db, value);
  return saveExecutionContext(db, value);
}

function validateConnectionDefinition(
  db: DbConnection,
  value: ModelConnection,
): void {
  const hostIds =
    value.gateway === null ? [value.hostId] : value.gateway.allowedHostIds;
  for (const hostId of hostIds) {
    if (hostId === null || !getHost(db, hostId))
      throw new ApiError(
        404,
        "host_not_found",
        `Connection execution host ${hostId} does not exist`,
      );
    requireAvailableExecutionHost(db, hostId);
  }
}

export function createModelConnectionDefinition(
  db: DbConnection,
  input: ParsedCreateModelConnectionRequest,
): ModelConnection {
  const now = Date.now();
  const value = modelConnectionSchema.parse({
    ...input,
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
  });
  validateConnectionDefinition(db, value);
  return saveModelConnection(db, value);
}

export function updateModelConnectionDefinition(
  db: DbConnection,
  input: UpdateModelConnectionRequest,
): ModelConnection {
  const previous = requireModelConnection(db, input.id);
  const value = modelConnectionSchema.parse({
    ...previous,
    ...input,
    updatedAt: Date.now(),
  });
  if (value.enabled && !value.revoked) validateConnectionDefinition(db, value);
  return saveModelConnection(db, value);
}

export function updateProjectContextDefaults(
  db: DbConnection,
  input: ProjectContextDefaults,
): ProjectContextDefaults {
  requireProject(db, input.projectId);
  if (input.executionContextId)
    requireEnabledContext(
      requireExecutionContext(db, input.executionContextId),
      input.projectId,
    );
  if (input.modelConnectionId)
    requireEnabledConnection(
      requireModelConnection(db, input.modelConnectionId),
    );
  return setProjectContextDefaults(db, input);
}

export function deleteContextDefinition(db: DbConnection, id: string): void {
  try {
    if (!deleteExecutionContext(db, id))
      throw new ApiError(
        404,
        "execution_context_not_found",
        `Execution context ${id} does not exist`,
      );
  } catch (error) {
    if (error instanceof Error && isSqliteForeignKeyConstraint(error))
      throw new ApiError(
        409,
        "execution_context_in_use",
        "Clear or replace project context defaults before deleting this context; existing thread snapshots are preserved",
      );
    throw error;
  }
}

export function deleteConnectionDefinition(db: DbConnection, id: string): void {
  try {
    if (!deleteModelConnection(db, id))
      throw new ApiError(
        404,
        "model_connection_not_found",
        `Model connection ${id} does not exist`,
      );
  } catch (error) {
    if (error instanceof Error && isSqliteForeignKeyConstraint(error))
      throw new ApiError(
        409,
        "model_connection_in_use",
        "Clear or replace context/project connection defaults before deleting this connection; existing thread snapshots are preserved",
      );
    throw error;
  }
}
