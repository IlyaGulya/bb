import { useState } from "react";
import { validateSelectedMcpServers, type ExecutionContext } from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { useHosts } from "@/hooks/queries/host-queries";
import { useMcpInspection } from "@/hooks/useMcpInspection";

type McpRefs = ExecutionContext["mcpServers"];
const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";

export function McpServerManager({
  value,
  onChange,
}: {
  value: McpRefs;
  onChange: (refs: McpRefs) => void;
}) {
  const hosts = useHosts();
  const [hostId, setHostId] = useState("");
  const [providerId, setProviderId] = useState("claude-code");
  const [configPath, setConfigPath] = useState("");
  const [inspectedPath, setInspectedPath] = useState<string | null>(null);
  const selectedHost = hosts.data?.find((host) => host.id === hostId);
  const connected = selectedHost?.status === "connected";
  const inspection = useMcpInspection({
    hostId: hostId || null,
    providerId,
    configPaths: [
      ...value.map((ref) => ref.configPath),
      ...(inspectedPath ? [inspectedPath] : []),
    ],
    enabled: connected,
  });
  const currentInspection =
    connected && !inspection.isError && !inspection.isFetching
      ? inspection.data
      : undefined;
  const selectedIssue = currentInspection
    ? validateSelectedMcpServers(value, currentInspection)
    : null;
  const canInspect =
    connected && configPath.trim() !== "" && !inspection.isFetching;
  return (
    <section
      aria-label="MCP servers"
      className="space-y-3 rounded-md border p-3"
    >
      <div>
        <h3 className="text-sm font-medium">MCP servers</h3>
        <p className="text-xs text-muted-foreground">
          Select named servers from native configuration on a preview machine.
          Only names and file references are saved, independently of model
          accounts. This does not bind the context to this machine. Changes
          apply to new sessions only.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span>Preview machine</span>
          <select
            className={selectClass}
            value={hostId}
            onChange={(event) => setHostId(event.target.value)}
          >
            <option value="">Choose machine</option>
            {hosts.data?.map((host) => (
              <option key={host.id} value={host.id}>
                {host.name} · {host.status}
              </option>
            ))}
            {hostId && !selectedHost ? (
              <option value={hostId}>{hostId} · unavailable</option>
            ) : null}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span>Native configuration format</span>
          <select
            className={selectClass}
            value={providerId}
            onChange={(event) => setProviderId(event.target.value)}
          >
            <option value="claude-code">Claude Code</option>
            <option value="acp-omp">OMP</option>
          </select>
        </label>
      </div>
      {hosts.isError ? (
        <p role="status" className="text-xs text-warning-text">
          Machines could not be loaded. Your selections are unchanged.{" "}
          <button
            type="button"
            className="underline"
            onClick={() => void hosts.refetch()}
          >
            Retry machines
          </button>
        </p>
      ) : null}
      <div className="space-y-1">
        <p className="text-sm font-medium">Selected servers ({value.length})</p>
        {value.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No context MCP servers selected.
          </p>
        ) : (
          <ul aria-label="Selected MCP servers" className="space-y-2">
            {value.map((ref, index) => {
              const issue = currentInspection
                ? validateSelectedMcpServers([ref], currentInspection)
                : null;
              return (
                <li
                  key={`${ref.name}:${ref.configPath}:${index}`}
                  className="flex items-start justify-between gap-2"
                >
                  <div className="min-w-0">
                    <p className="break-all text-sm font-medium">{ref.name}</p>
                    <p className="break-all text-xs text-muted-foreground">
                      {ref.configPath}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {currentInspection
                        ? (issue ??
                          "Configuration valid · authentication not checked")
                        : "Unchecked · authentication not checked"}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${ref.name}`}
                    onClick={() =>
                      onChange(
                        value.filter(
                          (_, selectedIndex) => selectedIndex !== index,
                        ),
                      )
                    }
                  >
                    Remove
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {selectedIssue ? (
        <p role="alert" className="text-xs text-warning-text">
          {selectedIssue}
        </p>
      ) : null}
      <label className="block space-y-1 text-sm">
        <span>Add from native config file</span>
        <Input
          value={configPath}
          onChange={(event) => setConfigPath(event.target.value)}
          placeholder="/absolute/path/mcp.json"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={!canInspect}
        onClick={() => {
          const path = configPath.trim();
          if (path === inspectedPath) void inspection.refetch();
          else setInspectedPath(path);
        }}
      >
        {inspection.isFetching ? "Inspecting…" : "Inspect config"}
      </Button>
      {!connected ? (
        <p role="status" className="text-xs text-muted-foreground">
          Unchecked. Enter a path now and choose an online machine to inspect
          it. Saved and unsaved server selections are kept while offline.
        </p>
      ) : inspection.isError ? (
        <p role="status" className="text-xs text-warning-text">
          Inspection unavailable. Selections are unchanged; no configuration or
          authentication readiness has been confirmed.{" "}
          <button
            type="button"
            className="underline"
            onClick={() => void inspection.refetch()}
          >
            Retry inspection
          </button>
        </p>
      ) : null}
      {currentInspection?.files.map((file) => (
        <div key={file.configPath} className="space-y-2 border-t pt-2">
          <p className="break-all text-xs font-medium">{file.configPath}</p>
          {file.status !== "ok" ? (
            <p role="status" className="text-xs text-warning-text">
              {file.issue ?? "Configuration could not be inspected."}
            </p>
          ) : file.servers.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No named MCP servers found.
            </p>
          ) : (
            file.servers.map((server, index) => {
              const ref = { name: server.name, configPath: file.configPath };
              const selected = value.some(
                (entry) =>
                  entry.name === ref.name &&
                  entry.configPath === ref.configPath,
              );
              const conflict = value.some(
                (entry) =>
                  entry.name === ref.name &&
                  entry.configPath !== ref.configPath,
              );
              const issue = validateSelectedMcpServers(
                [ref],
                currentInspection,
              );
              return (
                <label
                  key={`${server.name}:${index}`}
                  className="flex items-start gap-2 text-sm"
                >
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selected}
                    disabled={!selected && (issue !== null || conflict)}
                    onChange={(event) =>
                      onChange(
                        event.target.checked
                          ? [...value, ref]
                          : value.filter(
                              (entry) =>
                                entry.name !== ref.name ||
                                entry.configPath !== ref.configPath,
                            ),
                      )
                    }
                  />
                  <span className="min-w-0">
                    <span className="block break-all">
                      {server.name} · {server.transport}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {conflict
                        ? "Name already selected from another file; remove it first."
                        : (issue ??
                          "Configuration valid · authentication not checked")}
                    </span>
                  </span>
                </label>
              );
            })
          )}
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        Inspection does not connect to servers or check sign-in. Native
        authentication stays on the execution machine. This is not a per-tool
        permission control. The server validates the selected configuration
        again before starting a new session.
      </p>
    </section>
  );
}
