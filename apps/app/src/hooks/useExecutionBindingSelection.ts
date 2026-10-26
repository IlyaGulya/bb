import { useState } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { ExecutionContext, ModelConnection, ProjectContextDefaults } from "@bb/domain";
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
  unavailableReason: string | null;
  selectContext: (id: string) => void;
  selectConnection: (id: string) => void;
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
  const contexts = useQuery({
    queryKey: ["execution-contexts"],
    queryFn: () => sdk.executionContexts.list(),
  });
  const connections = useQuery({
    queryKey: ["model-connections"],
    queryFn: () => sdk.modelConnections.list(),
  });
  const defaults = useQuery({
    queryKey: ["project-context-defaults", projectId],
    queryFn: () => sdk.executionContexts.getProjectDefaults({ projectId }),
  });
  const [selection, setSelection] = useState<{
    projectId: string;
    executionContextId?: string;
    modelConnectionId?: string;
  }>({ projectId });
  const executionContextId = selection.projectId === projectId
    ? selection.executionContextId
    : undefined;
  const modelConnectionId = selection.projectId === projectId
    ? selection.modelConnectionId
    : undefined;
  const effectiveContextId = executionContextId ?? defaults.data?.executionContextId;
  const context = contexts.data?.find((entry) => entry.id === effectiveContextId);
  const effectiveConnectionId = modelConnectionId ??
    defaults.data?.modelConnectionId ?? context?.defaultModelConnectionId;
  const connection = connections.data?.find((entry) => entry.id === effectiveConnectionId);
  const unavailableReason = contexts.isError || connections.isError || defaults.isError
    ? "Execution context settings could not be loaded. Retry before starting a thread."
    : contexts.isPending || connections.isPending || defaults.isPending
      ? "Loading execution context settings…"
      : (effectiveContextId
        ? executionContextUnavailableReason(context, projectId)
        : null) ?? (effectiveConnectionId
        ? modelConnectionUnavailableReason(connection, providerId, hostId)
        : null);
  return {
    contexts,
    connections,
    defaults,
    executionContextId,
    modelConnectionId,
    effectiveContextId,
    effectiveConnectionId,
    unavailableReason,
    selectContext: (id: string) => setSelection((current) => ({
      ...(current.projectId === projectId ? current : {}),
      projectId,
      executionContextId: id || undefined,
    })),
    selectConnection: (id: string) => setSelection((current) => ({
      ...(current.projectId === projectId ? current : {}),
      projectId,
      modelConnectionId: id || undefined,
    })),
  };
}
