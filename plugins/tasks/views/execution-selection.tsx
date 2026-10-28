import {
  useSdk,
  useRealtime,
  type ExecutionContext,
  type ModelConnection,
} from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import { useTasksQuery } from "../shell/data.js";
import { ExecutionPicker } from "./execution-picker.js";

interface ExecutionSelections {
  contexts: { data: ExecutionContext[] | undefined; error: string | null; refresh: () => void };
  connections: { data: ModelConnection[] | undefined; error: string | null; refresh: () => void };
}

const systemChangeSchema = z.object({ changes: z.array(z.string()), id: z.string().optional() });

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
  useRealtime("system:changed", payload => {
    if (!open) return;
    const parsed = systemChangeSchema.safeParse(payload);
    if (!parsed.success) return;
    if (parsed.data.changes.includes("execution-contexts-changed")) contexts.refresh();
    if (parsed.data.changes.includes("model-connections-changed")) connections.refresh();
  });
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
  open,
}: {
  selections: ExecutionSelections;
  executionContextId: string;
  modelConnectionId: string;
  onContextChange: (id: string) => void;
  onConnectionChange: (id: string) => void;
  provider?: string;
  hostId?: string;
  projectId?: string;
  open: boolean;
}) {
  const { contexts, connections } = selections;
  const context = contexts.data?.find(
    (entry) => entry.id === executionContextId,
  );
  return (
    <>
      <div className="space-y-1 text-sm">
        <span>Execution context</span>
        <ExecutionPicker label="Execution context" value={executionContextId} dialogOpen={open} onChange={onContextChange} options={[
          { value: "", label: "Inherit execution context" },
          ...(contexts.data ?? []).map(entry => { const reason = contextUnavailable(entry, projectId); return { value: entry.id, label: `${entry.name}${reason ? ` · ${reason}` : ""}`, disabled: !!reason }; }),
        ]} />
      </div>
      {context && projectId && !context.projectIds.includes(projectId) ? (
        <p role="alert" className="text-xs text-destructive">This code project is not a member of the selected context. Change the context or update its project membership before dispatch.</p>
      ) : null}
      <div className="space-y-1 text-sm">
        <span>Model connection</span>
        <ExecutionPicker label="Model connection" value={modelConnectionId} dialogOpen={open} onChange={onConnectionChange} options={[
          { value: "", label: "Inherit model connection" },
          ...(connections.data ?? []).map(entry => { const reason = connectionUnavailable(entry, provider, hostId); return { value: entry.id, label: `${entry.name} · ${entry.gateway ? `CPA account: ${entry.gateway.accountPrefix}` : "Native provider login"}${reason ? ` · ${reason}` : ""}`, disabled: !!reason }; }),
        ]} />
      </div>
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
      {(contexts.error || connections.error) && <button type="button" className="min-h-11 text-sm underline sm:min-h-9" onClick={() => { contexts.refresh(); connections.refresh(); }}>Retry context and account lists</button>}
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
