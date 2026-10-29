import { useState } from "react";
import { useRpc, useSdk, useRealtime } from "@get-bb/plugin-sdk/app";
import type { DelegationRpcContract } from "../../delegate/contract.js";
import type { Preset, TaskThread } from "../../shared/contract.js";
import type {
  ExecutionTarget,
  TaskContinuation,
  TaskExecution,
} from "../../shared/execution.js";
import { errorMessage } from "../../shared/errors.js";
import { useTasksQuery } from "../../shell/data.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ResponsiveDrawerShell } from "@/components/ui/responsive-overlay";
import {
  ExecutionSelectionFields,
  executionSelectionsValid,
  useExecutionSelections,
} from "../execution-selection.js";
import { ExecutionPicker } from "../execution-picker.js";
import { z } from "zod";

const executionDefaultsChangeSchema = z.object({ changes: z.array(z.string()), id: z.string().optional() });

const fieldClass = "flex flex-col gap-1 text-sm";
const selectClass =
  "h-11 w-full rounded-md border border-input bg-background px-2 text-sm sm:h-9";

export interface ExecutionControlProps {
  execution?: TaskExecution;
  executionError?: string | null;
  onExecutionChange?: () => void;
}

export function ExecutionTargetControl({
  taskId,
  presets,
  execution,
  executionError,
  onExecutionChange,
  saveTarget,
  disabled = false,
  surfaceActive = true,
}: ExecutionControlProps & { taskId: string; presets: Preset[] | undefined; saveTarget?: (target: ExecutionTarget | null) => Promise<void>; disabled?: boolean; surfaceActive?: boolean }) {
  const rpc = useRpc<DelegationRpcContract>();
  const sdk = useSdk();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState("");
  const [hostId, setHostId] = useState("");
  const [kind, setKind] =
    useState<ExecutionTarget["workspace"]["kind"]>("managed-worktree");
  const [baseBranch, setBaseBranch] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [presetId, setPresetId] = useState("");
  const [executionContextId, setExecutionContextId] = useState("");
  const [modelConnectionId, setModelConnectionId] = useState("");
  const selections = useExecutionSelections(true);
  const selectedPreset = presets?.find((entry) => entry.id === presetId);
  const projects = useTasksQuery(
    async (query) => (await query.call("listBbProjects")).bbProjects,
    ["projects:changed"],
  );
  const machines = useTasksQuery(
    async (query) => (await query.call("listMachines", {})).machines,
    [],
  );
  const environments = useTasksQuery(
    async () => {
      if (!open || !projectId || !hostId || kind !== "existing-environment")
        return [];
      return (
        await rpc.call("listTaskExecutionEnvironments", {
          bbProjectId: projectId,
          hostId,
        })
      ).environments;
    },
    ["projects:changed"],
    [open, projectId, hostId, kind],
  );

  const edit = () => {
    const target = execution?.resolved;
    setProjectId(target?.bbProjectId ?? "");
    setHostId(target?.hostId ?? "");
    setKind(target?.workspace.kind ?? "managed-worktree");
    setBaseBranch(
      target?.workspace.kind === "managed-worktree"
        ? (target.workspace.baseBranch ?? "")
        : "",
    );
    setEnvironmentId(
      target?.workspace.kind === "existing-environment"
        ? target.workspace.environmentId
        : "",
    );
    setPresetId(target?.presetId ?? presets?.[0]?.id ?? "");
    setExecutionContextId(target?.executionContextId ?? "");
    setModelConnectionId(target?.modelConnectionId ?? "");
    setError(null);
    setOpen(true);
  };
  const save = async (target: ExecutionTarget | null) => {
    if (saving || disabled) return;
    setSaving(true);
    setError(null);
    try {
      if (saveTarget) await saveTarget(target);
      else await rpc.call("setTaskExecution", { taskId, target });
      onExecutionChange?.();
      setOpen(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };
  const validEnvironment = environments.data?.some(
    (entry) => entry.id === environmentId && entry.hostId === hostId,
  );
  const canSave =
    projects.data?.some(project => project.id === projectId) &&
    machines.data?.some(machine => machine.id === hostId) &&
    !!selectedPreset &&
    (kind !== "existing-environment" || validEnvironment) &&
    executionSelectionsValid(
      selections,
      executionContextId || selectedPreset?.executionContextId || "",
      modelConnectionId || selectedPreset?.modelConnectionId || "",
      selectedPreset?.providerId,
      hostId,
      projectId,
    );
  const resolved = execution?.resolved;
  const resolvedProject = projects.data?.find(
    (entry) => entry.id === resolved?.bbProjectId,
  );
  const resolvedMachine = machines.data?.find(
    (entry) => entry.id === resolved?.hostId,
  );
  const resolvedProfile = presets?.find(
    (entry) => entry.id === resolved?.presetId,
  );
  const defaults = useTasksQuery(async () => resolved ? sdk.experimental_executionContexts.getProjectDefaults({ projectId: resolved.bbProjectId }) : null, [], [resolved?.bbProjectId]);
  useRealtime("system:changed", payload => {
    const parsed = executionDefaultsChangeSchema.safeParse(payload);
    if (parsed.success && parsed.data.changes.includes("project-context-defaults-changed") && (!parsed.data.id || parsed.data.id === resolved?.bbProjectId)) defaults.refresh();
  });
  const workspaceSummary =
    resolved?.workspace.kind === "managed-worktree"
      ? `Isolated managed worktree · ${resolved.workspace.baseBranch ?? "default branch"}`
      : resolved?.workspace.kind === "existing-environment"
        ? "Existing prepared workspace"
        : "Project checkout";
  const summary = resolved
    ? `${resolvedProject?.name ?? "Code project unavailable"} · ${resolvedMachine?.name ?? "Machine unavailable"}`
    : execution ? "Choose a linked code project and an execution profile, or configure a task override." : "Loading execution target…";
  const effectiveContextId = resolved?.executionContextId ?? defaults.data?.executionContextId;
  const resolvedContext = selections.contexts.data?.find(entry => entry.id === effectiveContextId);
  const effectiveConnectionId = resolved?.modelConnectionId ?? defaults.data?.modelConnectionId ?? resolvedContext?.defaultModelConnectionId;
  const resolvedConnection = selections.connections.data?.find(entry => entry.id === effectiveConnectionId);

  return (
    <div className="min-w-0">
      <button
        type="button"
        disabled={disabled}
        className="min-h-11 text-left text-xs underline underline-offset-2 sm:min-h-8"
        onClick={edit}
      >
        Configure task execution
      </button>
      <p className="mt-1 break-words text-xs text-muted-foreground">
        {summary}
      </p>
      {resolved && <>
        <p className="break-words text-xs text-muted-foreground">Profile: {resolvedProfile?.name ?? "unavailable"} · Model: {resolvedProfile?.modelId ?? "unavailable"}{resolvedProfile ? ` · ${resolvedProfile.reasoningLevel} · ${resolvedProfile.permissionMode}` : ""}</p>
        <p className="break-words text-xs text-muted-foreground">Context: {resolvedContext?.name ?? (effectiveContextId ? "unavailable" : defaults.isLoading ? "loading defaults…" : defaults.error ? "defaults unavailable" : "none")}; account: {resolvedConnection?.name ?? (effectiveConnectionId ? "unavailable" : defaults.isLoading ? "loading defaults…" : defaults.error ? "defaults unavailable" : "native login; identity not known here")}.</p>
        <details className="mt-1 text-xs text-muted-foreground">
          <summary className="cursor-pointer py-2">Workspace &amp; execution diagnostics</summary>
          <p>{workspaceSummary}</p>
          <button type="button" className="min-h-11 underline sm:min-h-8" onClick={() => { void navigator.clipboard.writeText(JSON.stringify({ target: resolved, context: resolvedContext?.id, connection: resolvedConnection?.id }, null, 2)).catch(() => setError("Could not copy execution diagnostics. Select the diagnostics text instead.")); }}>Copy execution diagnostics</button>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(resolved, null, 2)}</pre>
        </details>
      </>}
      {(selections.contexts.error || selections.connections.error) && <p role="alert" className="text-xs text-destructive">Execution definitions could not refresh. Last known names are retained. <button className="underline" type="button" onClick={() => { selections.contexts.refresh(); selections.connections.refresh(); }}>Retry</button></p>}
      {defaults.error && <p role="alert" className="text-xs text-destructive">Project defaults could not refresh. <button type="button" className="underline" onClick={defaults.refresh}>Retry</button></p>}
      {execution ? (
        <p className="text-xs text-muted-foreground">
          {execution.inherited
            ? "Inherited from tracker project and profile"
            : "Task override"}
        </p>
      ) : null}
      {executionError ? (
        <p role="alert" className="text-xs text-destructive">
          {executionError}
        </p>
      ) : null}
      <ResponsiveDrawerShell
        open={open && surfaceActive}
        onOpenChange={(next) => {
          if (!saving) setOpen(next);
        }}
        srLabel="Task execution"
        contentClassName="max-w-xl"
      >
        <form
          className="flex-auto min-h-0 space-y-4 overflow-y-auto p-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSave) return;
            const workspace: ExecutionTarget["workspace"] =
              kind === "existing-environment"
                ? { kind, environmentId }
                : kind === "managed-worktree"
                  ? {
                      kind,
                      ...(baseBranch.trim()
                        ? { baseBranch: baseBranch.trim() }
                        : {}),
                    }
                  : { kind };
            void save({
              bbProjectId: projectId,
              hostId,
              workspace,
              presetId,
              ...(executionContextId ? { executionContextId } : {}),
              ...(modelConnectionId ? { modelConnectionId } : {}),
            });
          }}
        >
          <h3 className="font-semibold">Task execution</h3>
          <p className="text-sm text-muted-foreground">
            Choose a code project independently of this task’s tracker project.
            Profiles retain provider, model, and permissions.
          </p>
          <fieldset disabled={saving || disabled} className="space-y-3">
            <div className={fieldClass}>
              <span>Code project</span>
              <ExecutionPicker label="Code project" value={projectId} dialogOpen={open} options={(projects.data ?? []).map(project => ({ value: project.id, label: project.name }))} onChange={id => { setProjectId(id); setEnvironmentId(""); }} />
            </div>
            <div className={fieldClass}>
              <span>Execution machine</span>
              <ExecutionPicker label="Execution machine" value={hostId} dialogOpen={open} options={(machines.data ?? []).map(machine => ({ value: machine.id, label: machine.name }))} onChange={id => { setHostId(id); setEnvironmentId(""); }} />
            </div>
            <label className={fieldClass}>
              Workspace
              <select
                aria-label="Workspace"
                className={selectClass}
                value={kind}
                onChange={(event) => {
                  const value = event.target.value;
                  if (
                    value === "managed-worktree" ||
                    value === "project-checkout" ||
                    value === "existing-environment"
                  )
                    setKind(value);
                }}
              >
                <option value="managed-worktree">
                  Isolated managed worktree
                </option>
                <option value="project-checkout">Project checkout</option>
                <option value="existing-environment">
                  Existing environment
                </option>
              </select>
            </label>
            {kind === "managed-worktree" ? (
              <label className={fieldClass}>
                Base branch (optional)
                <Input
                  value={baseBranch}
                  onChange={(event) => setBaseBranch(event.target.value)}
                />
              </label>
            ) : null}
            {kind === "existing-environment" ? (
              <div className={fieldClass}>
                <span>Existing environment</span>
                <ExecutionPicker label="Existing environment" value={environmentId} dialogOpen={open} options={(environments.data ?? []).map(entry => ({ value: entry.id, label: `${entry.name} · ${entry.path}` }))} onChange={setEnvironmentId} />
              </div>
            ) : null}
            <div className={fieldClass}>
              <span>Execution profile</span>
              <ExecutionPicker label="Execution profile" value={presetId} dialogOpen={open} options={(presets ?? []).map(preset => ({ value: preset.id, label: `${preset.name} · ${preset.modelId}` }))} onChange={setPresetId} />
            </div>
            <ExecutionSelectionFields
              selections={selections}
              open={open}
              executionContextId={executionContextId}
              modelConnectionId={modelConnectionId}
              onContextChange={setExecutionContextId}
              onConnectionChange={setModelConnectionId}
              provider={selectedPreset?.providerId}
              hostId={hostId}
              projectId={projectId}
            />
            {selectedPreset?.executionContextId ? (
              <p className="text-xs text-muted-foreground">
                Profile context default: {selections.contexts.data?.find(entry => entry.id === selectedPreset.executionContextId)?.name ?? "unavailable"}
              </p>
            ) : null}
            {selectedPreset?.modelConnectionId ? (
              <p className="text-xs text-muted-foreground">
                Profile connection default: {selections.connections.data?.find(entry => entry.id === selectedPreset.modelConnectionId)?.name ?? "unavailable"}
              </p>
            ) : null}
            {!executionSelectionsValid(
              selections,
              executionContextId || selectedPreset?.executionContextId || "",
              modelConnectionId || selectedPreset?.modelConnectionId || "",
              selectedPreset?.providerId,
              hostId,
              projectId,
            ) ? (
              <p role="alert" className="text-sm text-destructive">
                The selected or inherited context/account is unavailable or
                incompatible with this code project, provider, or host. Choose a
                compatible override or update the profile; no fallback will be
                used.
              </p>
            ) : null}
          </fieldset>
          {[error, projects.error, machines.error, environments.error]
            .filter(Boolean)
            .map((message, index) => (
              <p key={index} role="alert" className="text-sm text-destructive">
                {message}
              </p>
            ))}
          <div className="sticky bottom-0 flex flex-wrap justify-end gap-2 bg-background py-3 max-sm:[&_button]:min-h-11">
            <Button
              type="button"
              variant="ghost"
              disabled={saving || disabled || !execution?.override}
              onClick={() => void save(null)}
            >
              Clear override · inherit defaults
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving || disabled || !canSave}>
              {saving ? "Saving…" : "Save execution target"}
            </Button>
          </div>
        </form>
      </ResponsiveDrawerShell>
    </div>
  );
}

export function ContinuationDialog({
  taskId,
  thread,
  retry,
  open,
  onOpenChange,
  onChanged,
}: {
  taskId: string;
  thread: TaskThread | null;
  retry: TaskContinuation | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const rpc = useRpc<DelegationRpcContract>();
  const [targetHostId, setTargetHostId] = useState("");
  const [targetPath, setTargetPath] = useState("");
  const [presetId, setPresetId] = useState("");
  const [branch, setBranch] = useState("");
  const [instructions, setInstructions] = useState("");
  const [includePaths, setIncludePaths] = useState<string[]>([]);
  const [extraPathsInput, setExtraPathsInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const machines = useTasksQuery(
    async (query) => (await query.call("listMachines", {})).machines,
    [],
  );
  const presets = useTasksQuery(
    async (query) => (await query.call("listPresets")).presets,
    ["projects:changed"],
  );
  const hostId = retry?.targetHostId ?? targetHostId;
  const sourceThreadId = retry?.sourceThreadId ?? thread?.threadId;
  const preview = useTasksQuery(
    async () => {
      if (!open || retry || !sourceThreadId || !hostId) return null;
      return rpc.call("previewTaskContinuation", {
        taskId,
        sourceThreadId,
        targetHostId: hostId,
      });
    },
    ["threads:changed"],
    [open, taskId, sourceThreadId, hostId, retry?.operationId],
  );
  const selectedPaths = [
    ...new Set([
      ...includePaths,
      ...extraPathsInput
        .split(/\r?\n/u)
        .map((path) => path.trim())
        .filter(Boolean),
    ]),
  ];
  const blockedFiles = preview.data?.files.some(
    (file) =>
      file.tracked &&
      !file.selectedByDefault &&
      !selectedPaths.includes(file.path),
  );
  const active = (preview.data?.activeThreadIds.length ?? 0) > 0;
  const sameHost = preview.data?.sourceHostId === hostId;
  const canSubmit =
    !!sourceThreadId &&
    !!hostId &&
    !!(retry?.targetPath ?? targetPath).trim() &&
    !!(retry?.presetId ?? presetId) &&
    !!instructions.trim() &&
    !busy &&
    (!!retry ||
      (!!preview.data &&
        !preview.isLoading &&
        !preview.error &&
        !blockedFiles &&
        !active &&
        !sameHost));
  const submit = async () => {
    if (!canSubmit || !sourceThreadId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.call("continueTask", {
        taskId,
        sourceThreadId,
        targetHostId: hostId,
        targetPath: (retry?.targetPath ?? targetPath).trim(),
        presetId: retry?.presetId ?? presetId,
        includePaths: retry ? [] : selectedPaths,
        extraInstructions: instructions.trim(),
        ...(!retry && branch.trim() ? { branch: branch.trim() } : {}),
        ...(retry ? { operationId: retry.operationId } : {}),
      });
      setOperationId(result.operationId);
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <ResponsiveDrawerShell
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      srLabel="Continue on another machine"
      contentClassName="max-w-xl"
    >
      <form
        className="flex-auto min-h-0 space-y-4 overflow-y-auto p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h3 className="font-semibold">
          {retry
            ? "Retry prepared continuation"
            : "Continue on another machine"}
        </h3>
        <p className="text-sm text-muted-foreground">
          Start a new native thread only after the workspace is ready. The
          source thread stays attached and its workspace is preserved.
        </p>
        {retry ? (
          <div className="break-words text-sm">
            Prepared continuation · {machines.data?.find(machine => machine.id === retry.targetHostId)?.name ?? "Target machine unavailable"}
            <br />
            {retry.targetPath}
            <p>{retry.lastError}</p>
          </div>
        ) : null}
        <fieldset disabled={busy || !!operationId} className="space-y-3">
          {!retry ? (
            <>
              <label className={fieldClass}>
                Target machine
                <ExecutionPicker label="Target machine" value={targetHostId} dialogOpen={open} options={(machines.data ?? []).map(machine => ({ value: machine.id, label: machine.name }))} onChange={id => { setTargetHostId(id); setIncludePaths([]); setExtraPathsInput(""); setError(null); }} />
              </label>
              <label className={fieldClass}>
                New target path
                <Input
                  required
                  value={targetPath}
                  onChange={(event) => setTargetPath(event.target.value)}
                  placeholder="/path/to/new-checkout"
                />
              </label>
              <label className={fieldClass}>
                Continuation profile
                <ExecutionPicker label="Continuation profile" value={presetId} dialogOpen={open} options={(presets.data ?? []).map(preset => ({ value: preset.id, label: `${preset.name} · ${preset.modelId}` }))} onChange={setPresetId} />
              </label>
              <label className={fieldClass}>
                New branch (optional)
                <Input
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                />
              </label>
              {preview.isLoading && hostId ? (
                <p role="status">Previewing source workspace…</p>
              ) : null}
              {preview.data ? (
                <section className="space-y-2 text-sm">
                  <p className="break-words">
                    Source: {machines.data?.find(machine => machine.id === preview.data?.sourceHostId)?.name ?? "Source machine unavailable"} ·{" "}
                    {preview.data.branch ?? "detached HEAD"} ·{" "}
                    {preview.data.head}
                  </p>
                  <p>
                    Ordinary tracked files always transfer. Select each extra
                    file explicitly. Sensitive tracked files require explicit
                    consent; review the warning before selecting the exact file.
                    No extra or sensitive files are selected automatically.
                  </p>
                  <div className="max-h-64 space-y-2 overflow-auto">
                    {preview.data.files.map((file) => (
                      <label
                        key={file.path}
                        className="flex items-start gap-2 break-all"
                      >
                        <input
                          type="checkbox"
                          aria-label={file.path}
                          disabled={
                            file.tracked && file.kind !== "sensitive-tracked"
                          }
                          checked={
                            file.tracked && file.selectedByDefault
                              ? true
                              : includePaths.includes(file.path)
                          }
                          onChange={(event) =>
                            setIncludePaths((current) =>
                              event.target.checked
                                ? [...current, file.path]
                                : current.filter((path) => path !== file.path),
                            )
                          }
                        />
                        <span>
                          {file.path} · {file.kind}
                          {file.tracked ? " · tracked (required)" : " · extra"}
                          {file.excludedReason
                            ? ` · ${file.excludedReason}`
                            : ""}
                        </span>
                      </label>
                    ))}
                  </div>
                  <label className={fieldClass}>
                    Additional exact file paths
                    <Textarea
                      value={extraPathsInput}
                      onChange={(event) =>
                        setExtraPathsInput(event.target.value)
                      }
                      placeholder="ignored-folder/config.json"
                    />
                  </label>
                  <p className="text-xs text-muted-foreground">
                    Ignored directories stay collapsed. List exact files, one
                    relative path per line. Directories, symlinks, and path
                    traversal are refused; nothing in a directory is copied
                    automatically.
                  </p>
                </section>
              ) : null}
            </>
          ) : null}
          <label className={fieldClass}>
            Next operation / handoff
            <Textarea
              required
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="Tell the new agent explicitly what to do next."
            />
          </label>
        </fieldset>
        {active ? (
          <p role="alert" className="text-sm text-destructive">
            Source threads are active. Wait until every source thread is idle.
          </p>
        ) : null}
        {sameHost ? (
          <p role="alert" className="text-sm text-destructive">
            Choose another machine, not the source machine.
          </p>
        ) : null}
        {blockedFiles ? (
          <p role="alert" className="text-sm text-destructive">
            Tracked sensitive files require explicit consent. Select each exact
            file after reviewing its warning, or resolve it in the source
            workspace; tracked work cannot be silently omitted.
          </p>
        ) : null}
        {[error, machines.error, presets.error, preview.error]
          .filter(Boolean)
          .map((message, index) => (
            <p key={index} role="alert" className="text-sm text-destructive">
              {message}
            </p>
          ))}
        {operationId ? (
          <div className="space-y-2 text-sm"><p role="status">New native thread started. Source thread retained.</p><details><summary className="cursor-pointer py-2">Continuation receipt</summary><code className="break-all">{operationId}</code></details></div>
        ) : null}
        <div className="sticky bottom-0 flex flex-wrap justify-end gap-2 bg-background py-3 max-sm:[&_button]:min-h-11">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {operationId ? "Close" : "Cancel"}
          </Button>
          {!operationId ? (
            <Button type="submit" disabled={!canSubmit}>
              {busy
                ? "Continuing…"
                : retry
                  ? "Retry agent start"
                  : "Continue task"}
            </Button>
          ) : null}
        </div>
      </form>
    </ResponsiveDrawerShell>
  );
}
