import {
  useSdk,
  type ExecutionContext,
  type ModelConnection,
} from "@get-bb/plugin-sdk/app";
import { useTasksQuery } from "../shell/data.js";

interface ExecutionSelections {
  contexts: { data: ExecutionContext[] | undefined; error: string | null };
  connections: { data: ModelConnection[] | undefined; error: string | null };
}

export function contextUnavailable(
  context: ExecutionContext,
  projectId?: string,
) {
  if (!context.enabled) return "disabled";
  if (projectId && !context.projectIds.includes(projectId))
    return "code project is not a member";
  return null;
}

export function connectionUnavailable(
  connection: ModelConnection,
  provider?: string,
  hostId?: string,
) {
  if (connection.revoked) return "revoked";
  if (!connection.enabled) return "disabled";
  if (provider && connection.provider !== provider) return "provider mismatch";
  if (
    hostId &&
    (connection.gateway
      ? !connection.gateway.allowedHostIds.includes(hostId)
      : connection.hostId !== hostId)
  )
    return "host mismatch";
  return null;
}

export function useExecutionSelections(open: boolean) {
  const sdk = useSdk();
  const contexts = useTasksQuery(
    async () => (open ? sdk.experimental_executionContexts.list() : []),
    [],
    [open],
  );
  const connections = useTasksQuery(
    async () => (open ? sdk.experimental_modelConnections.list() : []),
    [],
    [open],
  );
  return { contexts, connections };
}

export function ExecutionSelectionFields({
  selections,
  executionContextId,
  modelConnectionId,
  onContextChange,
  onConnectionChange,
  provider,
  hostId,
  projectId,
}: {
  selections: ExecutionSelections;
  executionContextId: string;
  modelConnectionId: string;
  onContextChange: (id: string) => void;
  onConnectionChange: (id: string) => void;
  provider?: string;
  hostId?: string;
  projectId?: string;
}) {
  const { contexts, connections } = selections;
  const context = contexts.data?.find(
    (entry) => entry.id === executionContextId,
  );
  const connection = connections.data?.find(
    (entry) => entry.id === modelConnectionId,
  );
  const selectClass =
    "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";
  return (
    <>
      <label className="flex flex-col gap-1 text-sm">
        Execution context
        <select
          aria-label="Execution context"
          className={selectClass}
          value={executionContextId}
          onChange={(event) => onContextChange(event.target.value)}
        >
          <option value="">Inherit execution context</option>
          {executionContextId && !context ? (
            <option value={executionContextId} disabled>
              {executionContextId} · unavailable
            </option>
          ) : null}
          {contexts.data?.map((entry) => {
            const reason = contextUnavailable(entry, projectId);
            return (
              <option key={entry.id} value={entry.id} disabled={!!reason}>
                {entry.name} · {entry.id}
                {reason ? ` · ${reason}` : ""}
              </option>
            );
          })}
        </select>
      </label>
      {context?.projectIds.length ? (
        <p className="text-xs text-muted-foreground">
          Code project must belong to this context:{" "}
          {context.projectIds.join(", ")}. Membership is checked at dispatch.
        </p>
      ) : null}
      <label className="flex flex-col gap-1 text-sm">
        Model connection
        <select
          aria-label="Model connection"
          className={selectClass}
          value={modelConnectionId}
          onChange={(event) => onConnectionChange(event.target.value)}
        >
          <option value="">Inherit model connection</option>
          {modelConnectionId && !connection ? (
            <option value={modelConnectionId} disabled>
              {modelConnectionId} · unavailable
            </option>
          ) : null}
          {connections.data?.map((entry) => {
            const reason = connectionUnavailable(entry, provider, hostId);
            return (
              <option key={entry.id} value={entry.id} disabled={!!reason}>
                {entry.name} · {entry.id} · {entry.provider} ·{" "}
                {entry.gateway ? "CPA gateway" : entry.hostId}
                {reason ? ` · ${reason}` : ""}
              </option>
            );
          })}
        </select>
      </label>
      <p className="text-xs text-muted-foreground">
        Context and model account are independent. Inherited connections are
        validated against the execution host and provider at dispatch.
      </p>
      {[contexts.error, connections.error]
        .filter(Boolean)
        .map((error, index) => (
          <p key={index} role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ))}
    </>
  );
}

export function executionSelectionsValid(
  selections: ExecutionSelections,
  executionContextId: string,
  modelConnectionId: string,
  provider?: string,
  hostId?: string,
  projectId?: string,
) {
  const context = selections.contexts.data?.find(
    (entry) => entry.id === executionContextId,
  );
  const connection = selections.connections.data?.find(
    (entry) => entry.id === modelConnectionId,
  );
  return (
    (!executionContextId ||
      (!!context && !contextUnavailable(context, projectId))) &&
    (!modelConnectionId ||
      (!!connection && !connectionUnavailable(connection, provider, hostId)))
  );
}
