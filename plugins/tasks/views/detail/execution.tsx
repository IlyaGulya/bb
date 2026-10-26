import { useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
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

const fieldClass = "flex flex-col gap-1 text-sm";
const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";

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
}: ExecutionControlProps & { taskId: string; presets: Preset[] | undefined }) {
  const rpc = useRpc<DelegationRpcContract>();
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
  const selections = useExecutionSelections(open);
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
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await rpc.call("setTaskExecution", { taskId, target });
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
    !!projectId &&
    !!hostId &&
    !!presetId &&
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
  const resolvedEnvironmentId =
    resolved?.workspace.kind === "existing-environment"
      ? resolved.workspace.environmentId
      : null;
  const workspaceSummary =
    resolved?.workspace.kind === "managed-worktree"
      ? `Isolated managed worktree · ${resolved.workspace.baseBranch ?? "default branch"}`
      : resolved?.workspace.kind === "existing-environment"
        ? `Existing environment · ${environments.data?.find((entry) => entry.id === resolvedEnvironmentId)?.path ?? resolvedEnvironmentId}`
        : "Project checkout";
  const summary =
    resolved && resolvedProject && resolvedMachine && resolvedProfile
      ? `${resolvedProject.name} · ${resolvedMachine.name} · ${workspaceSummary} · ${resolvedProfile.name}`
      : (execution?.summary ?? "Loading execution target…");

  return (
    <div className="min-w-0">
      <button
        type="button"
        className="text-left text-xs underline underline-offset-2"
        onClick={edit}
      >
        Configure task execution
      </button>
      <p className="mt-1 break-words text-xs text-muted-foreground">
        {summary}
      </p>
      {resolved?.executionContextId ? (
        <p className="text-xs text-muted-foreground">
          Execution context:{" "}
          {selections.contexts.data?.find(
            (entry) => entry.id === resolved.executionContextId,
          )?.name ?? resolved.executionContextId}{" "}
          · {resolved.executionContextId}
        </p>
      ) : null}
      {resolved?.modelConnectionId ? (
        <p className="text-xs text-muted-foreground">
          Model connection:{" "}
          {selections.connections.data?.find(
            (entry) => entry.id === resolved.modelConnectionId,
          )?.name ?? resolved.modelConnectionId}{" "}
          · {resolved.modelConnectionId}
        </p>
      ) : null}
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
        open={open}
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
          <fieldset disabled={saving} className="space-y-3">
            <label className={fieldClass}>
              Code project
              <select
                aria-label="Code project"
                className={selectClass}
                value={projectId}
                onChange={(event) => {
                  setProjectId(event.target.value);
                  setEnvironmentId("");
                }}
              >
                <option value="">Choose code project</option>
                {projects.data?.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={fieldClass}>
              Execution machine
              <select
                aria-label="Execution machine"
                className={selectClass}
                value={hostId}
                onChange={(event) => {
                  setHostId(event.target.value);
                  setEnvironmentId("");
                }}
              >
                <option value="">Choose machine</option>
                {machines.data?.map((machine) => (
                  <option key={machine.id} value={machine.id}>
                    {machine.name}
                  </option>
                ))}
              </select>
            </label>
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
              <label className={fieldClass}>
                Existing environment
                <select
                  aria-label="Existing environment"
                  className={selectClass}
                  value={environmentId}
                  onChange={(event) => setEnvironmentId(event.target.value)}
                >
                  <option value="">Choose environment</option>
                  {environments.data?.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name} · {entry.path}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className={fieldClass}>
              Execution profile
              <select
                aria-label="Execution profile"
                className={selectClass}
                value={presetId}
                onChange={(event) => setPresetId(event.target.value)}
              >
                <option value="">Choose profile</option>
                {presets?.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name}
                  </option>
                ))}
              </select>
            </label>
            <ExecutionSelectionFields
              selections={selections}
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
                Profile context default: {selectedPreset.executionContextId}
              </p>
            ) : null}
            {selectedPreset?.modelConnectionId ? (
              <p className="text-xs text-muted-foreground">
                Profile connection default: {selectedPreset.modelConnectionId}
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
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={saving || !execution?.override}
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
            <Button type="submit" disabled={saving || !canSave}>
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
            Operation {retry.operationId} · ready
            <br />
            {retry.targetHostId} · {retry.targetPath}
            <p>{retry.lastError}</p>
          </div>
        ) : null}
        <fieldset disabled={busy || !!operationId} className="space-y-3">
          {!retry ? (
            <>
              <label className={fieldClass}>
                Target machine
                <select
                  aria-label="Target machine"
                  className={selectClass}
                  value={targetHostId}
                  onChange={(event) => {
                    setTargetHostId(event.target.value);
                    setIncludePaths([]);
                    setExtraPathsInput("");
                    setError(null);
                  }}
                >
                  <option value="">Choose target machine</option>
                  {machines.data?.map((machine) => (
                    <option key={machine.id} value={machine.id}>
                      {machine.name}
                    </option>
                  ))}
                </select>
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
                <select
                  aria-label="Continuation profile"
                  className={selectClass}
                  value={presetId}
                  onChange={(event) => setPresetId(event.target.value)}
                >
                  <option value="">Choose profile</option>
                  {presets.data?.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name}
                    </option>
                  ))}
                </select>
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
                    Source: {preview.data.sourceHostId} ·{" "}
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
          <p role="status" className="break-all text-sm">
            New native thread started. Operation {operationId}. Source thread
            retained.
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
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
