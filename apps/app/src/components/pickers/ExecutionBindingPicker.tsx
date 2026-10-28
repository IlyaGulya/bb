import { Link } from "react-router-dom";
import { OptionPicker, type PickerOption } from "./OptionPicker";
import type { ExecutionBindingSelection } from "@/hooks/useExecutionBindingSelection";
import {
  executionContextUnavailableReason,
  modelConnectionUnavailableReason,
} from "@/lib/execution-binding-selection";
import { getSettingsRoutePath } from "@/lib/route-paths";
import { useHosts } from "@/hooks/queries/host-queries";
import { useSystemProviderCatalog } from "@/hooks/queries/system-queries";

export function ExecutionBindingPicker({
  selection,
  projectId,
  hostId,
  disabled,
}: {
  selection: ExecutionBindingSelection;
  projectId: string;
  providerId: string;
  hostId: string | null;
  disabled: boolean;
}) {
  const hosts = useHosts();
  const providers = useSystemProviderCatalog();
  const providerName = (id: string) => providers.data?.find(provider => provider.id === id)?.displayName ?? "Provider unavailable";
  const executionHost = hosts.data?.find((host) => host.id === hostId);
  const mcpServers = selection.effectiveContext?.mcpServers ?? [];
  const inspection = selection.mcpInspection;
  const contexts = selection.contexts.data ?? [];
  const connections = selection.connections.data ?? [];
  const defaultContext = contexts.find(
    (entry) => entry.id === selection.defaults.data?.executionContextId,
  );
  const defaultConnection = connections.find(
    (entry) => entry.id === selection.effectiveConnectionId,
  );
  const contextOptions: PickerOption<string>[] = [
    {
      value: "",
      label: `Context: ${defaultContext?.name ?? "Project default"}`,
      description: defaultContext
        ? "Project default"
        : "Legacy behavior when no project default is assigned",
    },
    ...contexts.map((entry) => {
      const reason = executionContextUnavailableReason(entry, projectId);
      return {
        value: entry.id,
        label: entry.name,
        disabled: reason !== null,
        disabledReason: reason ?? undefined,
      };
    }),
  ];
  const connectionOptions: PickerOption<string>[] = [
    {
      value: "",
      label: `Connection: ${defaultConnection?.name ?? "Native default"}`,
      description:
        "Use context/project defaults, independently of the selected context",
    },
    ...connections.map((entry) => {
      const reason = modelConnectionUnavailableReason(
        entry,
        entry.provider,
        hostId,
      );
      return {
        value: entry.id,
        label: entry.name,
        description: entry.gateway
          ? `CPA account: ${entry.gateway.accountPrefix} · ${providerName(entry.provider)}`
          : `${providerName(entry.provider)} · ${hosts.data?.find(host => host.id === entry.hostId)?.name ?? "Machine unavailable"}`,
        disabled: reason !== null,
        disabledReason: reason ?? undefined,
      };
    }),
  ];
  return (
    <div className="space-y-1 px-2 py-1">
      <div className="flex flex-wrap items-center gap-1">
        <OptionPicker
          label="Execution context"
          value={selection.executionContextId ?? ""}
          options={contextOptions}
          onChange={selection.selectContext}
          disabled={disabled}
        />
        <OptionPicker
          label="Model connection"
          value={selection.modelConnectionId ?? ""}
          options={connectionOptions}
          onChange={selection.selectConnection}
          disabled={disabled}
        />
        <Link
          className="text-xs text-muted-foreground underline underline-offset-2"
          to={getSettingsRoutePath("execution-contexts")}
        >
          Manage contexts and connections
        </Link>
      </div>
      <div className="space-y-1 text-xs text-muted-foreground">
        <p className="break-all">
          Execution machine: {executionHost?.name ?? (hostId ? "Unavailable" : "Not selected")}
          {executionHost ? ` · ${executionHost.status}` : ""}
        </p>
        <p className="break-words">
          Context MCP:{" "}
          {mcpServers.length > 0
            ? mcpServers.map((ref) => ref.name).join(", ")
            : "None selected (native defaults unchanged)"}
        </p>
        {selection.effectiveContext?.nativeMcpProfile ? (
          <p className="break-all">
            Native Claude MCP profile:{" "}
            {selection.effectiveContext.nativeMcpProfile.configDir ??
              "Host-native account"}
            . Includes native user/project MCP and Cloud; not the BB server
            allowlist.
          </p>
        ) : null}
        {selection.effectiveConnection?.gateway ? (
          <p className="break-all">
            CPA gateway: {selection.effectiveConnection.gateway.accountPrefix} ·{" "}
            {selection.effectiveConnection.gateway.baseUrl}. Native engine:{" "}
            {providerName(selection.effectiveConnection.provider)}. Account selection is
            independent of the context and MCP profile.
          </p>
        ) : null}
        {mcpServers.length > 0 ? (
          <>
            <p role="status">
              {hostId === null
                ? "Unchecked · choose an execution machine."
                : inspection.isFetching
                  ? "Checking configuration on the execution machine…"
                  : inspection.isError || !inspection.data
                    ? "Unchecked · inspection unavailable. The server must validate before launch."
                    : selection.mcpIssue
                      ? "Configuration issue · resolve before launch."
                      : "Configuration valid · authentication not checked."}
            </p>
            <button
              type="button"
              className="underline underline-offset-2"
              disabled={disabled || hostId === null || inspection.isFetching}
              onClick={() => void inspection.refetch()}
            >
              Recheck MCP configuration
            </button>
            <p>
              MCP configuration and native sign-in belong to this execution
              machine, independently of the model connection. New sessions only;
              not per-tool permissions.
            </p>
          </>
        ) : null}
      </div>
      {selection.unavailableReason ? (
        <p role="status" className="text-xs text-warning-text">
          {selection.unavailableReason}
        </p>
      ) : null}
      {selection.contexts.isError ||
      selection.connections.isError ||
      selection.defaults.isError ? (
        <button
          type="button"
          className="text-xs underline"
          onClick={() => {
            void selection.contexts.refetch();
            void selection.connections.refetch();
            void selection.defaults.refetch();
          }}
        >
          Retry context settings
        </button>
      ) : null}
    </div>
  );
}
