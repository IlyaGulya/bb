import { useState } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type {
  ExecutionContext,
  ModelConnection,
  ProjectContextDefaults,
} from "@bb/domain";
import { validateSelectedMcpServers } from "@bb/domain";
import {
  useMcpInspection,
  type McpInspectionQuery,
} from "@/hooks/useMcpInspection";
import { sdk } from "@/lib/sdk";
import {
  executionContextUnavailableReason,
  modelConnectionUnavailableReason,
} from "@/lib/execution-binding-selection";

export interface ExecutionBindingSelection {
  contexts: UseQueryResult<ExecutionContext[], Error>;
  connections: UseQueryResult<ModelConnection[], Error>;
  defaults: UseQueryResult<ProjectContextDefaults, Error>;
  executionContextId: string | undefined;
  modelConnectionId: string | undefined;
  effectiveContextId: string | null | undefined;
  effectiveConnectionId: string | null | undefined;
  effectiveContext: ExecutionContext | undefined;
  effectiveConnection: ModelConnection | undefined;
  mcpInspection: McpInspectionQuery;
  mcpIssue: string | null;
  unavailableReason: string | null;
  selectContext: (id: string) => void;
  selectConnection: (id: string) => void;
}

export type ExecutionBindingDefinitions = Omit<
  ExecutionBindingSelection,
  "mcpInspection" | "mcpIssue" | "unavailableReason"
>;

export function useExecutionBindingDefinitions({
  projectId,
}: {
  projectId: string;
}): ExecutionBindingDefinitions {
  const contexts = useQuery({
    queryKey: ["execution-contexts"],
    queryFn: () => sdk.experimental_executionContexts.list(),
  });
  const connections = useQuery({
    queryKey: ["model-connections"],
    queryFn: () => sdk.experimental_modelConnections.list(),
  });
  const defaults = useQuery({
    queryKey: ["project-context-defaults", projectId],
    queryFn: () =>
      sdk.experimental_executionContexts.getProjectDefaults({ projectId }),
  });
  const [selection, setSelection] = useState<{
    projectId: string;
    executionContextId?: string;
    modelConnectionId?: string;
  }>({ projectId });
  const executionContextId =
    selection.projectId === projectId
      ? selection.executionContextId
      : undefined;
  const modelConnectionId =
    selection.projectId === projectId ? selection.modelConnectionId : undefined;
  const effectiveContextId =
    executionContextId ?? defaults.data?.executionContextId;
  const context = contexts.data?.find(
    (entry) => entry.id === effectiveContextId,
  );
  const effectiveConnectionId =
    modelConnectionId ??
    defaults.data?.modelConnectionId ??
    context?.defaultModelConnectionId;
  const connection = connections.data?.find(
    (entry) => entry.id === effectiveConnectionId,
  );
  return {
    contexts,
    connections,
    defaults,
    executionContextId,
    modelConnectionId,
    effectiveContextId,
    effectiveConnectionId,
    effectiveContext: context,
    effectiveConnection: connection,
    selectContext: (id: string) =>
      setSelection((current) => ({
        ...(current.projectId === projectId ? current : {}),
        projectId,
        executionContextId: id || undefined,
      })),
    selectConnection: (id: string) =>
      setSelection((current) => ({
        ...(current.projectId === projectId ? current : {}),
        projectId,
        modelConnectionId: id || undefined,
      })),
  };
}

export function useExecutionBindingValidation({
  selection,
  projectId,
  providerId,
  hostId,
}: {
  selection: ExecutionBindingDefinitions;
  projectId: string;
  providerId: string;
  hostId: string | null;
}): ExecutionBindingSelection {
  const {
    contexts,
    connections,
    defaults,
    effectiveContextId,
    effectiveConnectionId,
    effectiveContext: context,
    effectiveConnection: connection,
  } = selection;
  const mcpServers = context?.mcpServers ?? [];
  const mcpInspection = useMcpInspection({
    hostId,
    providerId,
    configPaths: mcpServers.map((ref) => ref.configPath),
  });
  const mcpIssue =
    mcpInspection.data && !mcpInspection.isError && !mcpInspection.isFetching
      ? validateSelectedMcpServers(mcpServers, mcpInspection.data)
      : null;
  const unavailableReason =
    contexts.isError || connections.isError || defaults.isError
      ? "Execution context settings could not be loaded. Retry before starting a thread."
      : contexts.isPending || connections.isPending || defaults.isPending
        ? "Loading execution context settings…"
        : ((effectiveContextId
            ? executionContextUnavailableReason(context, projectId)
            : null) ??
          (effectiveConnectionId
            ? modelConnectionUnavailableReason(connection, providerId, hostId)
            : null) ??
          mcpIssue ??
          (mcpServers.length > 0 && mcpInspection.isFetching
            ? "Checking selected MCP configuration…"
            : null));
  return {
    ...selection,
    mcpInspection,
    mcpIssue,
    unavailableReason,
  };
}

export function useExecutionBindingSelection({
  projectId,
  providerId,
  hostId,
}: {
  projectId: string;
  providerId: string;
  hostId: string | null;
}): ExecutionBindingSelection {
  const selection = useExecutionBindingDefinitions({ projectId });
  return useExecutionBindingValidation({
    selection,
    projectId,
    providerId,
    hostId,
  });
}
