import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ExecutionContext, ModelConnection } from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { Textarea } from "@bb/shared-ui/textarea";
import { ResponsiveDrawerShell } from "@bb/shared-ui/responsive-overlay";
import { SettingsSection } from "@/components/ui/settings-section";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { useHosts } from "@/hooks/queries/host-queries";
import { useSystemProviderCatalog } from "@/hooks/queries/system-queries";
import { sdk } from "@/lib/sdk";
import { invalidateExecutionBindingDefinitions } from "@/hooks/cache-owners/system-cache-effects";
import {
  executionContextsQueryKey,
  modelConnectionsQueryKey,
  projectContextDefaultsQueryKey,
} from "@/hooks/queries/query-keys";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { McpServerManager } from "./McpServerManager";

type ContextFields = Omit<ExecutionContext, "id" | "createdAt" | "updatedAt">;
type ConnectionFields = Omit<ModelConnection, "id" | "createdAt" | "updatedAt">;
const selectClass =
  "h-11 w-full rounded-md border border-input bg-background px-2 text-sm sm:h-9";
const lines = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm max-sm:[&_input]:min-h-11">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function ExecutionContextsSettingsSection() {
  const queryClient = useQueryClient();
  const contexts = useQuery({
    queryKey: executionContextsQueryKey(),
    queryFn: () => sdk.experimental_executionContexts.list(),
  });
  const connections = useQuery({
    queryKey: modelConnectionsQueryKey(),
    queryFn: () => sdk.experimental_modelConnections.list(),
  });
  const [editor, setEditor] = useState<
    | { kind: "context"; value: ExecutionContext | null }
    | { kind: "connection"; value: ModelConnection | null }
    | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ kind: "context" | "connection"; id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const projects = useSidebarNavigation();
  const hosts = useHosts();
  const providers = useSystemProviderCatalog();
  const projectNames = new Map((projects.data ? [...projects.data.projects, projects.data.personalProject] : []).map(project => [project.id, project.name]));
  const providerName = (id: string) => providers.data?.find(provider => provider.id === id)?.displayName ?? "Provider unavailable";
  const refresh = (kind: "context" | "connection" | "project-defaults", id?: string) =>
    invalidateExecutionBindingDefinitions({ queryClient, kind, id });
  const remove = async (kind: "context" | "connection", id: string) => {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    try {
      if (kind === "context")
        await sdk.experimental_executionContexts.delete({ id });
      else await sdk.experimental_modelConnections.delete({ id });
      await refresh(kind, id);
      setPendingDelete(null);
    } catch (cause) {
      setError(
        getMutationErrorMessage({
          error: cause,
          fallbackMessage: "Could not delete this definition.",
        }),
      );
    } finally {
      setDeleting(false);
    }
  };
  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold sm:sr-only">Contexts &amp; connections</h1>
      <p className="max-w-prose text-sm text-muted-foreground">
        Contexts choose project instructions and tools. Model connections choose
        an account independently. Work and Personal are labels, not security
        domains; neither a context nor a connection is a filesystem sandbox.
      </p>
      <SettingsSection
        title="Execution contexts"
        description="Changes apply to new threads. Existing threads keep their persisted binding."
      >
        {contexts.isError ? (
          <p role="alert">
            Could not load contexts.{" "}
            <button
              className="underline"
              onClick={() => void contexts.refetch()}
            >
              Retry
            </button>
          </p>
        ) : null}
        {contexts.isPending ? (
          <p className="text-sm text-muted-foreground">Loading contexts…</p>
        ) : null}
        {contexts.data?.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No contexts. Unassigned projects retain their existing behavior.
          </p>
        ) : null}
        {contexts.data?.map((context) => (
          <div
            key={context.id}
            className="flex flex-wrap items-start justify-between gap-2 py-3"
          >
            <div className="min-w-0">
              <p className="break-words text-sm font-medium">
                {context.name}
                {context.enabled ? "" : " · disabled"}
              </p>
              <p className="text-xs text-muted-foreground">
                {context.projectIds.length ? context.projectIds.map(id => projectNames.get(id) ?? "Project unavailable").join(", ") : "No project membership"}
              </p>
              <p className="text-xs text-muted-foreground">
                {context.startupPolicy ? `${context.startupPolicy.deadlineMs / 1000}s startup deadline · ${context.startupPolicy.optionalMcpServers.length} optional MCP servers` : "Legacy startup policy · existing request timeouts only"}
              </p>
            </div>
            <div className="flex shrink-0 gap-3">
              <Button
                size="sm"
                variant="ghost"
                className="min-h-11 sm:min-h-8"
                aria-label={`Edit context ${context.name}`}
                onClick={() => setEditor({ kind: "context", value: context })}
              >
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="min-h-11 sm:min-h-8"
                aria-label={`Delete context ${context.name}`}
                onClick={() => { setError(null); setPendingDelete({ kind: "context", id: context.id, name: context.name }); }}
              >
                Delete
              </Button>
            </div>
          </div>
        ))}
        <Button
          size="sm"
          variant="outline"
          className="min-h-11 sm:min-h-8"
          onClick={() => setEditor({ kind: "context", value: null })}
        >
          New execution context
        </Button>
      </SettingsSection>
      <SettingsSection
        title="Model connections"
        description="Configuration references only. Never enter provider tokens, CPA client keys or administrator secrets here."
      >
        {connections.isError ? (
          <p role="alert">
            Could not load connections.{" "}
            <button
              className="underline"
              onClick={() => void connections.refetch()}
            >
              Retry
            </button>
          </p>
        ) : null}
        {connections.isPending ? (
          <p className="text-sm text-muted-foreground">Loading connections…</p>
        ) : null}
        {connections.data?.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No connections. Native provider defaults remain available.
          </p>
        ) : null}
        {connections.data?.map((connection) => (
          <div
            key={connection.id}
            className="flex flex-wrap items-start justify-between gap-2 py-3"
          >
            <div className="min-w-0">
              <p className="break-words text-sm font-medium">
                {connection.name}
                {connection.revoked
                  ? " · revoked"
                  : !connection.enabled
                    ? " · disabled"
                    : ""}
              </p>
              <p className="break-words text-xs text-muted-foreground">
                {providerName(connection.provider)} · {connection.gateway
                  ? `CPA account: ${connection.gateway.accountPrefix}`
                  : hosts.data?.find(host => host.id === connection.hostId)?.name ?? "Machine unavailable"}
              </p>
            </div>
            <div className="flex shrink-0 gap-3">
              <Button
                size="sm"
                variant="ghost"
                className="min-h-11 sm:min-h-8"
                aria-label={`Edit model connection ${connection.name}`}
                onClick={() =>
                  setEditor({ kind: "connection", value: connection })
                }
              >
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="min-h-11 sm:min-h-8"
                aria-label={`Delete model connection ${connection.name}`}
                onClick={() => { setError(null); setPendingDelete({ kind: "connection", id: connection.id, name: connection.name }); }}
              >
                Delete
              </Button>
            </div>
          </div>
        ))}
        <Button
          size="sm"
          variant="outline"
          className="min-h-11 sm:min-h-8"
          onClick={() => setEditor({ kind: "connection", value: null })}
        >
          New model connection
        </Button>
      </SettingsSection>
      <ProjectContextDefaultsEditor
        contexts={contexts.data ?? []}
        connections={connections.data ?? []}
        onSaved={(projectId) => refresh("project-defaults", projectId)}
      />
      <ResponsiveDrawerShell
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
        srLabel={
          editor?.kind === "connection"
            ? "Model connection"
            : "Execution context"
        }
        contentClassName="max-w-xl"
      >
        {editor?.kind === "context" ? (
          <ContextEditor
            key={`context:${editor.value?.id ?? "new"}`}
            value={editor.value}
            onCancel={() => setEditor(null)}
            connections={connections.data ?? []}
            onSave={async (fields) => {
              const saved = editor.value
                ? await sdk.experimental_executionContexts.update({
                    id: editor.value.id,
                    ...fields,
                  })
                : await sdk.experimental_executionContexts.create(fields);
              await refresh("context", saved.id);
              setEditor(null);
            }}
          />
        ) : editor?.kind === "connection" ? (
          <ConnectionEditor
            key={`connection:${editor.value?.id ?? "new"}`}
            value={editor.value}
            onCancel={() => setEditor(null)}
            onSave={async (fields) => {
              const saved = editor.value
                ? await sdk.experimental_modelConnections.update({
                    id: editor.value.id,
                    ...fields,
                  })
                : await sdk.experimental_modelConnections.create(fields);
              await refresh("connection", saved.id);
              setEditor(null);
            }}
          />
        ) : null}
      </ResponsiveDrawerShell>
      <ResponsiveDrawerShell open={pendingDelete !== null} onOpenChange={open => { if (!open && !deleting) setPendingDelete(null); }} srLabel={`Delete ${pendingDelete?.name ?? "definition"}`} contentClassName="max-w-lg">
        <div className="min-h-0 flex-auto space-y-4 overflow-y-auto p-4">
          <h2 className="break-words text-lg font-semibold">Delete {pendingDelete?.name}?</h2>
          <p className="text-sm text-muted-foreground">This cannot be undone. Clear or replace saved {pendingDelete?.kind === "context" ? "project context" : "context and project connection"} defaults first. Existing thread snapshots are preserved, but a missing definition can block new launches and continuation. No other account is selected automatically.</p>
          {error && <p role="alert" className="text-sm text-destructive-text">{error}</p>}
          <div className="flex flex-wrap justify-end gap-3">
            <Button type="button" variant="outline" disabled={deleting} className="min-h-11 sm:min-h-9" onClick={() => setPendingDelete(null)}>Cancel</Button>
            <Button type="button" variant="destructive" disabled={deleting} className="min-h-11 sm:min-h-9" onClick={() => { if (pendingDelete) void remove(pendingDelete.kind, pendingDelete.id); }}>{deleting ? "Deleting…" : "Delete definition"}</Button>
          </div>
        </div>
      </ResponsiveDrawerShell>
    </div>
  );
}

function EditorForm({
  title,
  children,
  onSave,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  onSave: () => Promise<void>;
  onCancel?: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex-auto min-h-0 space-y-4 overflow-y-auto p-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (saving) return;
        setSaving(true);
        setError(null);
        try {
          await onSave();
        } catch (cause) {
          setError(
            getMutationErrorMessage({
              error: cause,
              fallbackMessage: "Could not save execution settings.",
            }),
          );
        } finally {
          setSaving(false);
        }
      }}
    >
      <h2 className="text-lg font-semibold">{title}</h2>
      <fieldset disabled={saving} className="space-y-3">
        {children}
      </fieldset>
      {error ? (
        <p role="alert" className="text-sm text-destructive-text">
          {error}
        </p>
      ) : null}
      <div className="sticky bottom-0 flex flex-wrap justify-end gap-3 border-t border-border bg-background py-3">
        {onCancel && <Button type="button" variant="outline" disabled={saving} className="min-h-11 sm:min-h-9" onClick={onCancel}>Cancel</Button>}
        <Button type="submit" disabled={saving} className="min-h-11 sm:min-h-9">
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

function ContextEditor({
  value,
  connections,
  onSave,
  onCancel,
}: {
  value: ExecutionContext | null;
  connections: ModelConnection[];
  onSave: (fields: ContextFields) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<ContextFields>(() => ({
    name: value?.name ?? "",
    enabled: value?.enabled ?? true,
    projectIds: value?.projectIds ?? [],
    instructions: value?.instructions ?? "",
    skillRoots: value?.skillRoots ?? [],
    commandRoots: value?.commandRoots ?? [],
    pluginRoots: value?.pluginRoots ?? [],
    settingsPaths: value?.settingsPaths ?? [],
    mcpServers: value?.mcpServers ?? [],
    ...(value?.nativeMcpProfile
      ? { nativeMcpProfile: value.nativeMcpProfile }
      : {}),
    hooksPath: value?.hooksPath ?? null,
    startupPolicy: value?.startupPolicy ?? null,
    autoMemory: value?.autoMemory ?? false,
    gitIdentity: value?.gitIdentity ?? null,
    defaultModelConnectionId: value?.defaultModelConnectionId ?? null,
  }));
  const [deadlineSeconds, setDeadlineSeconds] = useState(String((value?.startupPolicy?.deadlineMs ?? 120_000) / 1000));
  const projects = useSidebarNavigation();
  const [rootTexts, setRootTexts] = useState(() => ({
    skillRoots: draft.skillRoots.join("\n"),
    commandRoots: draft.commandRoots.join("\n"),
    pluginRoots: draft.pluginRoots.join("\n"),
    settingsPaths: draft.settingsPaths.join("\n"),
  }));
  const set = <K extends keyof ContextFields>(key: K, next: ContextFields[K]) =>
    setDraft((current) => ({ ...current, [key]: next }));
  return (
    <EditorForm
      title={value ? "Edit execution context" : "New execution context"}
      onCancel={onCancel}
      onSave={() => {
        const seconds = Number(deadlineSeconds);
        if (draft.startupPolicy && (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 1800)) {
          throw new Error("Startup deadline must be a whole number from 1 to 1800 seconds.");
        }
        return onSave({
          ...draft,
          startupPolicy: draft.startupPolicy ? {
            deadlineMs: seconds * 1000,
            optionalMcpServers: draft.startupPolicy.optionalMcpServers.filter((name) => draft.mcpServers.some((server) => server.name === name)),
          } : null,
          name: draft.name.trim(),
          skillRoots: lines(rootTexts.skillRoots),
          commandRoots: lines(rootTexts.commandRoots),
          pluginRoots: lines(rootTexts.pluginRoots),
          settingsPaths: lines(rootTexts.settingsPaths),
        });
      }}
    >
      <Field label="Name">
        <Input
          required
          value={draft.name}
          placeholder="e.g. Work or Personal"
          onChange={(event) => set("name", event.target.value)}
        />
      </Field>
      <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-8">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => set("enabled", event.target.checked)}
        />
        Enabled for new threads
      </label>
      <div className="space-y-1">
        <p className="text-sm font-medium">Project membership</p>
        <p className="text-xs text-muted-foreground">
          Only selected projects can use this context. No projects means
          unavailable for dispatch.
        </p>
        {projects.data
          ? [...projects.data.projects, projects.data.personalProject].map(
              (project) => (
                <label
                  key={project.id}
                  className="flex min-h-11 items-center gap-2 text-sm sm:min-h-8"
                >
                  <input
                    type="checkbox"
                    checked={draft.projectIds.includes(project.id)}
                    onChange={(event) =>
                      set(
                        "projectIds",
                        event.target.checked
                          ? [...draft.projectIds, project.id]
                          : draft.projectIds.filter((id) => id !== project.id),
                      )
                    }
                  />
                  {project.name}
                </label>
              ),
            )
          : null}
        {projects.isPending && <p role="status" className="text-sm text-muted-foreground">Loading projects…</p>}
        {projects.isError && <p role="alert">Could not load projects. <button type="button" className="underline" onClick={() => void projects.refetch()}>Retry</button></p>}
      </div>
      <Field label="Instructions">
        <Textarea
          value={draft.instructions}
          onChange={(event) => set("instructions", event.target.value)}
        />
      </Field>
      <Field label="Default model connection">
        <select
          className={selectClass}
          value={draft.defaultModelConnectionId ?? ""}
          onChange={(event) =>
            set("defaultModelConnectionId", event.target.value || null)
          }
        >
          <option value="">Use project account, otherwise native login</option>
          {connections.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
              {entry.revoked
                ? " · revoked"
                : !entry.enabled
                  ? " · disabled"
                  : ""}
            </option>
          ))}
          {draft.defaultModelConnectionId && !connections.some(entry => entry.id === draft.defaultModelConnectionId) && <option value={draft.defaultModelConnectionId} disabled>Saved connection unavailable</option>}
        </select>
      </Field>
      <Field label="Provider startup policy">
        <select
          className={selectClass}
          value={draft.startupPolicy ? "bounded" : "legacy"}
          onChange={(event) => set("startupPolicy", event.target.value === "bounded" ? { deadlineMs: 120_000, optionalMcpServers: [] } : null)}
        >
          <option value="legacy">Keep existing provider behavior</option>
          <option value="bounded">Require bounded startup</option>
        </select>
        <p className="text-xs text-muted-foreground">
          Existing threads keep their frozen policy. Legacy behavior has only existing request timeouts, not a separate startup deadline.
        </p>
      </Field>
      {draft.startupPolicy ? (
        <div className="space-y-3">
          <Field label="Startup deadline (seconds)">
            <Input type="number" inputMode="numeric" min={1} max={1800} step={1} required value={deadlineSeconds} onChange={(event) => setDeadlineSeconds(event.target.value)} />
            <p className="text-xs text-muted-foreground">
              Stops only this thread’s owned startup processes. The deadline ends at provider readiness, not at the model’s response. Hooks remain enabled; authentication setup is a separate operator action.
            </p>
          </Field>
          <p className="text-xs text-muted-foreground">
            Selected MCP servers are required unless explicitly allowed below. Providers that cannot prove required readiness fail closed.
          </p>
          {draft.mcpServers.map((server) => (
            <label key={server.name} className="flex min-h-11 items-start gap-2 py-2 text-sm sm:min-h-8">
              <input
                type="checkbox"
                className="mt-1 shrink-0"
                checked={draft.startupPolicy?.optionalMcpServers.includes(server.name) ?? false}
                onChange={(event) => {
                  if (!draft.startupPolicy) return;
                  set("startupPolicy", { ...draft.startupPolicy, optionalMcpServers: event.target.checked
                    ? [...draft.startupPolicy.optionalMcpServers, server.name]
                    : draft.startupPolicy.optionalMcpServers.filter((name) => name !== server.name) });
                }}
              />
              <span className="min-w-0 break-words">Allow startup without {server.name} if unavailable</span>
            </label>
          ))}
        </div>
      ) : null}
      <details className="space-y-3" open={draft.mcpServers.length > 0 || draft.nativeMcpProfile !== undefined ? true : undefined}>
        <summary className="cursor-pointer py-3 text-sm font-medium">Tools &amp; MCP · {draft.mcpServers.length} selected servers</summary>
      <McpServerManager
        value={draft.mcpServers}
        onChange={(refs) => set("mcpServers", refs)}
      />
      <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-8">
        <input
          type="checkbox"
          checked={draft.nativeMcpProfile !== undefined}
          onChange={(event) =>
            set(
              "nativeMcpProfile",
              event.target.checked ? { configDir: null } : undefined,
            )
          }
        />
        Use native Claude MCP profile, including Cloud Connectors
      </label>
      {draft.nativeMcpProfile ? (
        <Field label="Native Claude MCP account config directory">
          <Input
            value={draft.nativeMcpProfile.configDir ?? ""}
            placeholder="Empty: native account on the selected host"
            onChange={(event) =>
              set("nativeMcpProfile", {
                configDir: event.target.value.trim() || null,
              })
            }
          />
          <p className="text-xs text-muted-foreground">
            Claude Code only. Explicitly loads native user/project MCP and
            account Cloud Connectors, not just the BB server allowlist. Requires
            native sign-in and at least one connected Cloud connector on this
            host; model-account selection stays independent. Other contexts and
            existing sessions do not change.
          </p>
        </Field>
      ) : null}
      </details>
      <details className="space-y-3">
        <summary className="cursor-pointer text-sm font-medium">
          Native context configuration
        </summary>
        <p className="text-xs text-muted-foreground">
          Absolute host paths, one per line. These are references to scoped
          native configuration, never credentials.
        </p>
        {(
          [
            "skillRoots",
            "commandRoots",
            "pluginRoots",
            "settingsPaths",
          ] as const
        ).map((key) => (
          <Field
            key={key}
            label={
              {
                skillRoots: "Skill roots",
                commandRoots: "Command roots",
                pluginRoots: "Plugin roots",
                settingsPaths: "Settings files",
              }[key]
            }
          >
            <Textarea
              value={rootTexts[key]}
              onChange={(event) =>
                setRootTexts((current) => ({
                  ...current,
                  [key]: event.target.value,
                }))
              }
            />
          </Field>
        ))}
        <Field label="Hooks configuration path">
          <Input
            value={draft.hooksPath ?? ""}
            onChange={(event) => set("hooksPath", event.target.value || null)}
          />
        </Field>
        <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-8">
          <input
            type="checkbox"
            checked={draft.autoMemory}
            onChange={(event) => set("autoMemory", event.target.checked)}
          />
          Enable native auto memory
        </label>
        <Field label="Explicit Git name (optional)">
          <Input
            value={draft.gitIdentity?.name ?? ""}
            onChange={(event) =>
              set(
                "gitIdentity",
                event.target.value || draft.gitIdentity?.email
                  ? {
                      name: event.target.value,
                      email: draft.gitIdentity?.email ?? "",
                    }
                  : null,
              )
            }
          />
        </Field>
        <Field label="Explicit Git email (optional)">
          <Input
            value={draft.gitIdentity?.email ?? ""}
            onChange={(event) =>
              set(
                "gitIdentity",
                event.target.value || draft.gitIdentity?.name
                  ? {
                      name: draft.gitIdentity?.name ?? "",
                      email: event.target.value,
                    }
                  : null,
              )
            }
          />
        </Field>
      </details>
    </EditorForm>
  );
}

function ConnectionEditor({
  value,
  onSave,
  onCancel,
}: {
  value: ModelConnection | null;
  onSave: (fields: ConnectionFields) => Promise<void>;
  onCancel: () => void;
}) {
  const hosts = useHosts();
  const providers = useSystemProviderCatalog();
  const [draft, setDraft] = useState<ConnectionFields>(() => ({
    name: value?.name ?? "",
    provider: value?.provider ?? "",
    hostId: value?.gateway ? null : (value?.hostId ?? ""),
    enabled: value?.enabled ?? true,
    revoked: value?.revoked ?? false,
    nativeAuth: value?.nativeAuth ?? {
      configDir: null,
      profile: null,
      hostEnv: null,
    },
    gateway: value?.gateway ?? null,
  }));
  const set = <K extends keyof ConnectionFields>(
    key: K,
    next: ConnectionFields[K],
  ) => setDraft((current) => ({ ...current, [key]: next }));
  const setGateway = (next: Partial<NonNullable<ModelConnection["gateway"]>>) =>
    setDraft((current) => ({
      ...current,
      gateway: current.gateway ? { ...current.gateway, ...next } : null,
    }));
  return (
    <EditorForm
      title={value ? "Edit model connection" : "New model connection"}
      onCancel={onCancel}
      onSave={() => onSave({ ...draft, name: draft.name.trim() })}
    >
      <Field label="Name">
        <Input
          required
          value={draft.name}
          placeholder="e.g. Work Claude or Personal OMP"
          onChange={(event) => set("name", event.target.value)}
        />
      </Field>
      <Field label="Connection mode">
        <select
          className={selectClass}
          value={draft.gateway ? "gateway" : "native"}
          onChange={(event) =>
            setDraft((current) =>
              event.target.value === "gateway"
                ? {
                    ...current,
                    provider: ["acp-omp", "claude-code", "codex"].includes(
                      current.provider,
                    )
                      ? current.provider
                      : "acp-omp",
                    hostId: null,
                    nativeAuth: {
                      configDir: null,
                      profile: null,
                      hostEnv: null,
                    },
                    gateway: {
                      baseUrl: "",
                      protocol:
                        current.provider === "claude-code"
                          ? "anthropic-messages"
                          : "openai-responses",
                      accountPrefix: "",
                      modelProvider:
                        current.provider === "claude-code"
                          ? "anthropic"
                          : "openai-codex",
                      credential: { kind: "env", name: "BB_CPA_API_KEY" },
                      allowedHostIds: [],
                    },
                  }
                : { ...current, provider: "", hostId: "", gateway: null },
            )
          }
        >
          <option value="native">Native provider login</option>
          <option value="gateway">CPA gateway · native engine</option>
        </select>
      </Field>
      <Field label="Native provider">
        <select
          required
          className={selectClass}
          value={draft.provider}
          onChange={(event) => {
            const provider = event.target.value;
            setDraft((current) => ({
              ...current,
              provider,
              gateway: current.gateway
                ? {
                    ...current.gateway,
                    protocol:
                      provider === "claude-code"
                        ? "anthropic-messages"
                        : provider === "codex"
                          ? "openai-responses"
                          : current.gateway.protocol,
                  }
                : null,
            }));
          }}
        >
          <option value="">Choose provider</option>
          {providers.data
            ?.filter(
              (provider) =>
                !draft.gateway ||
                ["acp-omp", "claude-code", "codex"].includes(provider.id),
            )
            .map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.displayName}
                {provider.available ? "" : " · unavailable"}
              </option>
            ))}
          {draft.provider &&
          !providers.data?.some(
            (provider) => provider.id === draft.provider,
          ) ? (
            <option value={draft.provider}>
              {draft.provider} · unavailable
            </option>
          ) : null}
        </select>
      </Field>
      {draft.gateway ? (
        <>
          <p className="text-xs text-muted-foreground">
            CPA supports native OMP, Claude Code and Codex with compatible
            protocols. The selected worker resolves its client credential and
            account namespace. Execution context, MCP identity, Git and native
            session storage remain independent. Native Claude MCP-profile mode
            must be explicitly selected. Client keys are account-service
            credentials, not per-run access grants.
          </p>
          <Field label="Gateway model API base URL">
            <Input
              required
              type="url"
              autoComplete="off"
              value={draft.gateway.baseUrl}
              placeholder="http://cpa:8317/v1"
              onChange={(event) => setGateway({ baseUrl: event.target.value })}
            />
          </Field>
          <Field label="Account namespace">
            <Input
              required
              pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
              value={draft.gateway.accountPrefix}
              placeholder="personal"
              onChange={(event) =>
                setGateway({ accountPrefix: event.target.value })
              }
            />
          </Field>
          <details className="space-y-3" open={!draft.gateway.baseUrl ? true : undefined}>
            <summary className="cursor-pointer py-3 text-sm font-medium">Gateway transport &amp; credential references</summary>
          <Field label="Native model catalog provider">
            <Input
              required
              value={draft.gateway.modelProvider}
              placeholder="openai-codex"
              onChange={(event) =>
                setGateway({ modelProvider: event.target.value })
              }
            />
          </Field>
          <p className="text-xs text-muted-foreground">
            OMP requires exact native catalog metadata, such as openai-codex or
            anthropic. Other engines list the selected CPA inventory without
            invented token budgets.
          </p>
          <Field label="Gateway protocol">
            <select
              className={selectClass}
              value={draft.gateway.protocol}
              onChange={(event) => {
                const protocol = event.target.value;
                if (
                  protocol === "openai-responses" ||
                  protocol === "openai-completions" ||
                  protocol === "anthropic-messages"
                )
                  setGateway({ protocol });
              }}
            >
              <option
                value="openai-responses"
                disabled={draft.provider === "claude-code"}
              >
                OpenAI Responses
              </option>
              <option
                value="openai-completions"
                disabled={draft.provider !== "acp-omp"}
              >
                OpenAI Completions
              </option>
              <option
                value="anthropic-messages"
                disabled={draft.provider === "codex"}
              >
                Anthropic Messages
              </option>
            </select>
          </Field>
          <Field label="Client credential reference type">
            <select
              className={selectClass}
              value={draft.gateway.credential.kind}
              onChange={(event) =>
                setGateway({
                  credential:
                    event.target.value === "file"
                      ? { kind: "file", path: "" }
                      : { kind: "env", name: "" },
                })
              }
            >
              <option value="env">Worker environment variable name</option>
              <option value="file">Absolute worker file path</option>
            </select>
          </Field>
          {draft.gateway.credential.kind === "env" ? (
            <Field label="Client credential environment variable name">
              <Input
                required
                autoComplete="off"
                pattern="[A-Za-z_][A-Za-z0-9_]*"
                value={draft.gateway.credential.name}
                placeholder="BB_CPA_API_KEY"
                onChange={(event) =>
                  setGateway({
                    credential: { kind: "env", name: event.target.value },
                  })
                }
              />
            </Field>
          ) : (
            <Field label="Client credential absolute file path on worker">
              <Input
                required
                autoComplete="off"
                pattern="/.*"
                value={draft.gateway.credential.path}
                placeholder="/absolute/private/cpa-client-key"
                onChange={(event) =>
                  setGateway({
                    credential: { kind: "file", path: event.target.value },
                  })
                }
              />
            </Field>
          )}
          <p className="text-xs text-muted-foreground">
            Enter only a reference, never the key itself. Provision the CPA
            client key on every explicitly allowed worker outside this form.
            Never use the CPA administrator key.
          </p>
          </details>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">
              Allowed execution machines
            </legend>
            <p className="text-xs text-muted-foreground">
              Select at least one enrolled worker. This connection cannot run on
              any other machine; selecting it does not select a machine.
            </p>
            {hosts.data?.map((host) => (
              <label key={host.id} className="flex min-h-11 items-center gap-2 text-sm sm:min-h-8">
                <input
                  type="checkbox"
                  checked={
                    draft.gateway?.allowedHostIds.includes(host.id) ?? false
                  }
                  onChange={(event) =>
                    setGateway({
                      allowedHostIds: event.target.checked
                        ? [...(draft.gateway?.allowedHostIds ?? []), host.id]
                        : (draft.gateway?.allowedHostIds ?? []).filter(
                            (id) => id !== host.id,
                          ),
                    })
                  }
                />
                {host.name} · {host.status}
              </label>
            ))}
            {hosts.isPending ? <p role="status">Loading machines…</p> : null}
            {hosts.isError ? (
              <button
                type="button"
                className="underline"
                onClick={() => void hosts.refetch()}
              >
                Retry loading machines
              </button>
            ) : null}
            {draft.gateway.allowedHostIds
              .filter((id) => !hosts.data?.some((host) => host.id === id))
              .map((id) => (
                <label key={id} className="flex min-h-11 items-center gap-2 text-sm sm:min-h-8">
                  <input
                    type="checkbox"
                    checked
                    onChange={() =>
                      setGateway({
                        allowedHostIds: (
                          draft.gateway?.allowedHostIds ?? []
                        ).filter((entry) => entry !== id),
                      })
                    }
                  />
                  Saved machine unavailable
                </label>
              ))}
          </fieldset>
        </>
      ) : (
        <>
          <Field label="Machine">
            <select
              required
              className={selectClass}
              value={draft.hostId ?? ""}
              onChange={(event) => set("hostId", event.target.value)}
            >
              <option value="">Choose machine</option>
              {hosts.data?.map((host) => (
                <option key={host.id} value={host.id}>
                  {host.name} · {host.status}
                </option>
              ))}
              {draft.hostId &&
              !hosts.data?.some((host) => host.id === draft.hostId) ? (
                <option value={draft.hostId}>
                  Saved machine unavailable
                </option>
              ) : null}
            </select>
          </Field>
          <p className="text-xs text-muted-foreground">
            Reference an existing native login/configuration on this machine.
            This does not sign in, copy credentials, or switch accounts in an
            existing session.
          </p>
          <Field label="Native configuration directory (optional)">
            <Input
              autoComplete="off"
              value={draft.nativeAuth.configDir ?? ""}
              placeholder="/absolute/native/config/directory"
              onChange={(event) =>
                set("nativeAuth", {
                  ...draft.nativeAuth,
                  configDir: event.target.value || null,
                })
              }
            />
          </Field>
          <Field label="Native profile name (optional)">
            <Input
              autoComplete="off"
              value={draft.nativeAuth.profile ?? ""}
              onChange={(event) =>
                set("nativeAuth", {
                  ...draft.nativeAuth,
                  profile: event.target.value || null,
                })
              }
            />
          </Field>
          <details className="space-y-3">
            <summary className="cursor-pointer text-sm font-medium">
              Native host environment references
            </summary>
            <p className="text-xs text-muted-foreground">
              Environment variable names on the execution host only. Never paste
              broker URLs, tokens, or credentials.
            </p>
            <Field label="Broker URL environment variable name">
              <Input
                autoComplete="off"
                value={draft.nativeAuth.hostEnv?.brokerUrlEnv ?? ""}
                onChange={(event) =>
                  set("nativeAuth", {
                    ...draft.nativeAuth,
                    hostEnv:
                      event.target.value ||
                      draft.nativeAuth.hostEnv?.brokerTokenEnv
                        ? {
                            brokerUrlEnv: event.target.value,
                            brokerTokenEnv:
                              draft.nativeAuth.hostEnv?.brokerTokenEnv ?? "",
                          }
                        : null,
                  })
                }
              />
            </Field>
            <Field label="Broker token environment variable name">
              <Input
                autoComplete="off"
                value={draft.nativeAuth.hostEnv?.brokerTokenEnv ?? ""}
                onChange={(event) =>
                  set("nativeAuth", {
                    ...draft.nativeAuth,
                    hostEnv:
                      event.target.value ||
                      draft.nativeAuth.hostEnv?.brokerUrlEnv
                        ? {
                            brokerUrlEnv:
                              draft.nativeAuth.hostEnv?.brokerUrlEnv ?? "",
                            brokerTokenEnv: event.target.value,
                          }
                        : null,
                  })
                }
              />
            </Field>
          </details>
        </>
      )}
      <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-8">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => set("enabled", event.target.checked)}
        />
        Enabled for new threads
      </label>
      <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-8">
        <input
          type="checkbox"
          checked={draft.revoked}
          onChange={(event) => set("revoked", event.target.checked)}
        />
        Revoked
      </label>
    </EditorForm>
  );
}

function ProjectContextDefaultsEditor({
  contexts,
  connections,
  onSaved,
}: {
  contexts: ExecutionContext[];
  connections: ModelConnection[];
  onSaved: (projectId: string) => Promise<void>;
}) {
  const projects = useSidebarNavigation();
  const [projectId, setProjectId] = useState("");
  const defaults = useQuery({
    queryKey: projectContextDefaultsQueryKey(projectId),
    queryFn: () =>
      sdk.experimental_executionContexts.getProjectDefaults({ projectId }),
    enabled: !!projectId,
  });
  return (
    <SettingsSection
      title="Project defaults"
      description="Context supplies instructions and tools; the model connection supplies the account. Explicit thread or profile choices take precedence."
    >
      <Field label="Project">
        <select
          className={selectClass}
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
        >
          <option value="">Choose project</option>
          {projects.data
            ? [...projects.data.projects, projects.data.personalProject].map(
                (project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ),
              )
            : null}
        </select>
      </Field>
      {defaults.isError ? (
        <p role="alert">Could not load project defaults. <button type="button" className="underline" onClick={() => void defaults.refetch()}>Retry</button></p>
      ) : projectId && defaults.isPending ? <p role="status" className="mt-3 text-sm text-muted-foreground">Loading project defaults…</p> : projectId && defaults.data ? (
        <ProjectDefaultsForm
          key={projectId}
          projectId={projectId}
          initialContextId={defaults.data.executionContextId}
          initialConnectionId={defaults.data.modelConnectionId}
          contexts={contexts}
          connections={connections}
          onSaved={onSaved}
        />
      ) : null}
    </SettingsSection>
  );
}

function ProjectDefaultsForm({
  projectId,
  initialContextId,
  initialConnectionId,
  contexts,
  connections,
  onSaved,
}: {
  projectId: string;
  initialContextId: string | null;
  initialConnectionId: string | null;
  contexts: ExecutionContext[];
  connections: ModelConnection[];
  onSaved: (projectId: string) => Promise<void>;
}) {
  const [contextId, setContextId] = useState(initialContextId ?? "");
  const [connectionId, setConnectionId] = useState(initialConnectionId ?? "");
  const context = contexts.find(entry => entry.id === contextId);
  const effectiveConnectionId = connectionId || context?.defaultModelConnectionId;
  const effectiveConnection = connections.find(entry => entry.id === effectiveConnectionId);
  return (
    <EditorForm
      title="Project binding defaults"
      onCancel={() => { setContextId(initialContextId ?? ""); setConnectionId(initialConnectionId ?? ""); }}
      onSave={async () => {
        await sdk.experimental_executionContexts.setProjectDefaults({
          projectId,
          executionContextId: contextId || null,
          modelConnectionId: connectionId || null,
        });
        await onSaved(projectId);
      }}
    >
      <Field label="Default execution context">
        <select
          className={selectClass}
          value={contextId}
          onChange={(event) => setContextId(event.target.value)}
        >
          <option value="">No project context</option>
          {contexts.map((entry) => (
            <option
              key={entry.id}
              value={entry.id}
              disabled={!entry.enabled || !entry.projectIds.includes(projectId)}
            >
              {entry.name}
              {!entry.enabled
                ? " · disabled"
                : !entry.projectIds.includes(projectId)
                  ? " · project not included"
                  : ""}
            </option>
          ))}
          {contextId && !context && <option value={contextId} disabled>Saved context unavailable</option>}
        </select>
      </Field>
      <Field label="Default model connection">
        <select
          className={selectClass}
          value={connectionId}
          onChange={(event) => setConnectionId(event.target.value)}
        >
          <option value="">Use context account, otherwise native login</option>
          {connections.map((entry) => (
            <option
              key={entry.id}
              value={entry.id}
              disabled={!entry.enabled || entry.revoked}
            >
              {entry.name}
              {entry.revoked
                ? " · revoked"
                : !entry.enabled
                  ? " · disabled"
                  : ""}
            </option>
          ))}
          {connectionId && !connections.some(entry => entry.id === connectionId) && <option value={connectionId} disabled>Saved connection unavailable</option>}
        </select>
      </Field>
      <p role="status" className="text-sm text-muted-foreground">For new threads without an explicit thread/profile override: context — {context?.name ?? (contextId ? "unavailable" : "none")}; model account — {effectiveConnection?.name ?? (effectiveConnectionId ? "unavailable; choose another connection" : "native provider login; account identity is not known here")}. {effectiveConnection && (!effectiveConnection.enabled || effectiveConnection.revoked) ? "This account is unavailable; launches are refused, not redirected." : "The model version is selected when creating the thread, not on this page."}</p>
    </EditorForm>
  );
}
