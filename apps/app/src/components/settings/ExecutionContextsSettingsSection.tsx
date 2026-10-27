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
import { sdk } from "@/lib/sdk";
import { allSystemExecutionOptionsQueryKeyPrefix } from "@/hooks/queries/query-keys";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { McpServerManager } from "./McpServerManager";

type ContextFields = Omit<ExecutionContext, "id" | "createdAt" | "updatedAt">;
type ConnectionFields = Omit<ModelConnection, "id" | "createdAt" | "updatedAt">;
const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";
const lines = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function ExecutionContextsSettingsSection() {
  const queryClient = useQueryClient();
  const contexts = useQuery({
    queryKey: ["execution-contexts"],
    queryFn: () => sdk.experimental_executionContexts.list(),
  });
  const connections = useQuery({
    queryKey: ["model-connections"],
    queryFn: () => sdk.experimental_modelConnections.list(),
  });
  const [editor, setEditor] = useState<
    | { kind: "context"; value: ExecutionContext | null }
    | { kind: "connection"; value: ModelConnection | null }
    | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["execution-contexts"] }),
      queryClient.invalidateQueries({ queryKey: ["model-connections"] }),
      queryClient.invalidateQueries({ queryKey: ["project-context-defaults"] }),
      queryClient.removeQueries({ queryKey: allSystemExecutionOptionsQueryKeyPrefix() }),
    ]);
  };
  const remove = async (kind: "context" | "connection", id: string) => {
    setError(null);
    try {
      if (kind === "context")
        await sdk.experimental_executionContexts.delete({ id });
      else await sdk.experimental_modelConnections.delete({ id });
      await refresh();
    } catch (cause) {
      setError(
        getMutationErrorMessage({
          error: cause,
          fallbackMessage: "Could not delete this definition.",
        }),
      );
    }
  };
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Execution contexts select project instructions and tools, not a physical
        worktree. Model connections select a native provider account or a CPA
        gateway independently of context, tools and session storage. Work and
        Personal are ordinary labels, not security domains. Configuration
        separation is not a filesystem sandbox.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive-text">
          {error}
        </p>
      ) : null}
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
            className="flex items-center justify-between gap-2 py-2"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {context.name}
                {context.enabled ? "" : " · disabled"}
              </p>
              <p className="text-xs text-muted-foreground">
                {context.projectIds.length} projects
              </p>
            </div>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditor({ kind: "context", value: context })}
              >
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void remove("context", context.id)}
              >
                Delete
              </Button>
            </div>
          </div>
        ))}
        <Button
          size="sm"
          variant="outline"
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
            className="flex items-center justify-between gap-2 py-2"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {connection.name}
                {connection.revoked
                  ? " · revoked"
                  : !connection.enabled
                    ? " · disabled"
                    : ""}
              </p>
              <p className="break-all text-xs text-muted-foreground">
                {connection.gateway
                  ? `${connection.provider} · CPA gateway · ${connection.gateway.accountPrefix}`
                  : `${connection.provider} · ${connection.hostId}`}
              </p>
            </div>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setEditor({ kind: "connection", value: connection })
                }
              >
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void remove("connection", connection.id)}
              >
                Delete
              </Button>
            </div>
          </div>
        ))}
        <Button
          size="sm"
          variant="outline"
          onClick={() => setEditor({ kind: "connection", value: null })}
        >
          New model connection
        </Button>
      </SettingsSection>
      <ProjectContextDefaultsEditor
        contexts={contexts.data ?? []}
        connections={connections.data ?? []}
        onSaved={refresh}
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
            connections={connections.data ?? []}
            onSave={async (fields) => {
              if (editor.value)
                await sdk.experimental_executionContexts.update({
                  id: editor.value.id,
                  ...fields,
                });
              else await sdk.experimental_executionContexts.create(fields);
              await refresh();
              setEditor(null);
            }}
          />
        ) : editor?.kind === "connection" ? (
          <ConnectionEditor
            key={`connection:${editor.value?.id ?? "new"}`}
            value={editor.value}
            onSave={async (fields) => {
              if (editor.value)
                await sdk.experimental_modelConnections.update({
                  id: editor.value.id,
                  ...fields,
                });
              else await sdk.experimental_modelConnections.create(fields);
              await refresh();
              setEditor(null);
            }}
          />
        ) : null}
      </ResponsiveDrawerShell>
    </div>
  );
}

function EditorForm({
  title,
  children,
  onSave,
}: {
  title: string;
  children: ReactNode;
  onSave: () => Promise<void>;
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
      <Button type="submit" disabled={saving}>
        {saving ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}

function ContextEditor({
  value,
  connections,
  onSave,
}: {
  value: ExecutionContext | null;
  connections: ModelConnection[];
  onSave: (fields: ContextFields) => Promise<void>;
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
    hooksPath: value?.hooksPath ?? null,
    autoMemory: value?.autoMemory ?? false,
    gitIdentity: value?.gitIdentity ?? null,
    defaultModelConnectionId: value?.defaultModelConnectionId ?? null,
  }));
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
      onSave={() =>
        onSave({
          ...draft,
          name: draft.name.trim(),
          skillRoots: lines(rootTexts.skillRoots),
          commandRoots: lines(rootTexts.commandRoots),
          pluginRoots: lines(rootTexts.pluginRoots),
          settingsPaths: lines(rootTexts.settingsPaths),
        })
      }
    >
      <Field label="Name">
        <Input
          required
          value={draft.name}
          placeholder="e.g. Work or Personal"
          onChange={(event) => set("name", event.target.value)}
        />
      </Field>
      <label className="flex items-center gap-2 text-sm">
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
                  className="flex items-center gap-2 text-sm"
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
        {projects.isError ? <p role="alert">Could not load projects.</p> : null}
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
          <option value="">Native/project default</option>
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
        </select>
      </Field>
      <McpServerManager
        value={draft.mcpServers}
        onChange={(refs) => set("mcpServers", refs)}
      />
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
        <label className="flex items-center gap-2 text-sm">
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
}: {
  value: ModelConnection | null;
  onSave: (fields: ConnectionFields) => Promise<void>;
}) {
  const hosts = useHosts();
  const providers = useQuery({
    queryKey: ["provider-catalog"],
    queryFn: () => sdk.providers.catalog(),
  });
  const [draft, setDraft] = useState<ConnectionFields>(() => ({
    name: value?.name ?? "",
    provider: value?.provider ?? "",
    hostId: value?.hostId ?? "",
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
                    provider: "acp-omp",
                    hostId: null,
                    nativeAuth: { configDir: null, profile: null, hostEnv: null },
                    gateway: {
                      baseUrl: "",
                      protocol: "openai-responses",
                      accountPrefix: "",
                      modelProvider: "openai-codex",
                      credential: { kind: "env", name: "BB_CPA_API_KEY" },
                      allowedHostIds: [],
                    },
                  }
                : { ...current, provider: "", hostId: "", gateway: null },
            )
          }
        >
          <option value="native">Native provider login</option>
          <option value="gateway">CPA gateway · native OMP (acp-omp)</option>
        </select>
      </Field>
      <Field label="Native provider">
        <select
          required
          disabled={draft.gateway !== null}
          className={selectClass}
          value={draft.provider}
          onChange={(event) => set("provider", event.target.value)}
        >
          <option value="">Choose provider</option>
          {providers.data?.map((provider) => (
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
            CPA gateway supports native OMP (acp-omp) only. The selected worker
            resolves the client credential reference and discovers only this
            account namespace. This does not change context, MCP, Git identity
            or native session storage. Client keys are flat, trusted-pilot
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
          <Field label="Account namespace (accountPrefix)">
            <Input
              required
              pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
              value={draft.gateway.accountPrefix}
              placeholder="personal"
              onChange={(event) => setGateway({ accountPrefix: event.target.value })}
            />
          </Field>
          <Field label="Native model catalog provider (modelProvider)">
            <Input
              required
              value={draft.gateway.modelProvider}
              placeholder="openai-codex"
              onChange={(event) => setGateway({ modelProvider: event.target.value })}
            />
          </Field>
          <p className="text-xs text-muted-foreground">
            Use the exact native OMP catalog provider ID, such as openai-codex or
            anthropic. Unknown models or capabilities are unsupported.
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
                ) setGateway({ protocol });
              }}
            >
              <option value="openai-responses">OpenAI Responses</option>
              <option value="openai-completions">OpenAI Completions</option>
              <option value="anthropic-messages">Anthropic Messages</option>
            </select>
          </Field>
          <Field label="Client credential reference type">
            <select
              className={selectClass}
              value={draft.gateway.credential.kind}
              onChange={(event) =>
                setGateway({
                  credential: event.target.value === "file"
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
                  setGateway({ credential: { kind: "env", name: event.target.value } })
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
                  setGateway({ credential: { kind: "file", path: event.target.value } })
                }
              />
            </Field>
          )}
          <p className="text-xs text-muted-foreground">
            Enter only a reference, never the key itself. Provision the CPA
            client key on every explicitly allowed worker outside this form.
            Never use the CPA administrator key.
          </p>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Allowed execution machines</legend>
            <p className="text-xs text-muted-foreground">
              Select at least one enrolled worker. This connection cannot run on
              any other machine; selecting it does not select a machine.
            </p>
            {hosts.data?.map((host) => (
              <label key={host.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.gateway?.allowedHostIds.includes(host.id) ?? false}
                  onChange={(event) =>
                    setGateway({
                      allowedHostIds: event.target.checked
                        ? [...(draft.gateway?.allowedHostIds ?? []), host.id]
                        : (draft.gateway?.allowedHostIds ?? []).filter((id) => id !== host.id),
                    })
                  }
                />
                {host.name} · {host.status}
              </label>
            ))}
            {hosts.isPending ? <p role="status">Loading machines…</p> : null}
            {hosts.isError ? (
              <button type="button" className="underline" onClick={() => void hosts.refetch()}>
                Retry loading machines
              </button>
            ) : null}
            {draft.gateway.allowedHostIds
              .filter((id) => !hosts.data?.some((host) => host.id === id))
              .map((id) => (
                <label key={id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked
                    onChange={() =>
                      setGateway({
                        allowedHostIds: (draft.gateway?.allowedHostIds ?? []).filter((entry) => entry !== id),
                      })
                    }
                  />
                  {id} · unavailable
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
            <option value={draft.hostId}>{draft.hostId} · unavailable</option>
          ) : null}
        </select>
      </Field>
      <p className="text-xs text-muted-foreground">
        Reference an existing native login/configuration on this machine. This
        does not sign in, copy credentials, or switch accounts in an existing
        session.
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
                  event.target.value || draft.nativeAuth.hostEnv?.brokerTokenEnv
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
                  event.target.value || draft.nativeAuth.hostEnv?.brokerUrlEnv
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
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => set("enabled", event.target.checked)}
        />
        Enabled for new threads
      </label>
      <label className="flex items-center gap-2 text-sm">
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
  onSaved: () => Promise<void>;
}) {
  const projects = useSidebarNavigation();
  const [projectId, setProjectId] = useState("");
  const defaults = useQuery({
    queryKey: ["project-context-defaults", projectId],
    queryFn: () =>
      sdk.experimental_executionContexts.getProjectDefaults({ projectId }),
    enabled: !!projectId,
  });
  return (
    <SettingsSection
      title="Project defaults"
      description="Default context and model connection are independent. Leave both unassigned to retain legacy behavior."
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
        <p role="alert">Could not load project defaults.</p>
      ) : projectId && defaults.data ? (
        <ProjectDefaultsForm
          key={`${projectId}:${defaults.data.executionContextId}:${defaults.data.modelConnectionId}`}
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
  onSaved: () => Promise<void>;
}) {
  const [contextId, setContextId] = useState(initialContextId ?? "");
  const [connectionId, setConnectionId] = useState(initialConnectionId ?? "");
  return (
    <EditorForm
      title="Project binding defaults"
      onSave={async () => {
        await sdk.experimental_executionContexts.setProjectDefaults({
          projectId,
          executionContextId: contextId || null,
          modelConnectionId: connectionId || null,
        });
        await onSaved();
      }}
    >
      <Field label="Default execution context">
        <select
          className={selectClass}
          value={contextId}
          onChange={(event) => setContextId(event.target.value)}
        >
          <option value="">Unassigned</option>
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
        </select>
      </Field>
      <Field label="Default model connection">
        <select
          className={selectClass}
          value={connectionId}
          onChange={(event) => setConnectionId(event.target.value)}
        >
          <option value="">Context/native default</option>
          {connections.map((entry) => (
            <option
              key={entry.id}
              value={entry.id}
              disabled={!entry.enabled || entry.revoked}
            >
              {entry.name} · {entry.provider}
              {entry.revoked
                ? " · revoked"
                : !entry.enabled
                  ? " · disabled"
                  : ""}
            </option>
          ))}
        </select>
      </Field>
    </EditorForm>
  );
}
