import { useState } from "react";
import { useRpc, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ResponsiveDrawerShell } from "@/components/ui/responsive-overlay";
import { useTasksQuery } from "../../shell/data";
import {
  repositoryBindingsSchema,
  type RepositoryBinding,
  type RepositoryCheckpoint,
  type RepositoryRpcContract,
} from "../../shared/repositories";
import { errorMessage } from "../../shared/errors";
import type { Preset } from "../../shared/contract";
import type { DelegationRpcContract } from "../../delegate/contract.js";
import { ExecutionPicker } from "../execution-picker.js";

function emptyBinding(index: number, presetId: string): RepositoryBinding {
  return {
    id: `repo-${index}-${crypto.randomUUID()}`,
    bbProjectId: "",
    role: "",
    owner: "",
    required: true,
    sourceEnvironmentId: "",
    sourceHostId: "",
    sourcePath: "",
    sourceBranch: null,
    sourceHead: "",
    targetHostId: "",
    targetPath: "",
    branch: "",
    presetId,
    instructions: "",
    instructionPaths: [],
    includePaths: [],
  };
}
export function TaskRepositoriesControl({
  taskId,
  presets,
}: {
  taskId: string;
  presets: Preset[] | undefined;
}) {
  const rpc = useRpc<RepositoryRpcContract>();
  const executionRpc = useRpc<DelegationRpcContract>();
  const navigate = useBbNavigate();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [bindings, setBindings] = useState<RepositoryBinding[]>([]);
  const [checkpointId, setCheckpointId] = useState<string | undefined>();
  const [remoteCandidates, setRemoteCandidates] = useState<
    Record<string, NonNullable<RepositoryBinding["remoteBase"]>[]>
  >({});
  const [flaggedPaths, setFlaggedPaths] = useState<Record<string, string[]>>(
    {},
  );
  const checkpoints = useTasksQuery(
    async () => (await rpc.call("getTaskRepositories", { taskId })).checkpoints,
    ["tasks:changed"],
    [taskId, revision],
  );
  const projects = useTasksQuery(async query => (await query.call("listBbProjects")).bbProjects, ["projects:changed"]);
  const machines = useTasksQuery(async query => (await query.call("listMachines", {})).machines, []);
  const sourceProjectIds = [...new Set(bindings.map(binding => binding.bbProjectId).filter(Boolean))].sort();
  const sourceEnvironments = useTasksQuery(async () => {
    if (!open) return [];
    return (await Promise.all(sourceProjectIds.map(async bbProjectId => {
      const result = await executionRpc.call("listTaskExecutionEnvironments", { bbProjectId });
      return result.environments.map(environment => ({ ...environment, bbProjectId }));
    }))).flat();
  }, ["projects:changed"], [open, ...sourceProjectIds]);
  const projectName = (id: string) => projects.data?.find(project => project.id === id)?.name ?? "Code project unavailable";
  const machineName = (id: string) => machines.data?.find(machine => machine.id === id)?.name ?? "Machine unavailable";
  const update = (index: number, patch: Partial<RepositoryBinding>) =>
    setBindings((current) =>
      current.map((binding, position) =>
        position === index ? { ...binding, ...patch } : binding,
      ),
    );
  const act = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      setRevision((value) => value + 1);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const edit = (checkpoint?: RepositoryCheckpoint) => {
    setCheckpointId(checkpoint?.id);
    setBindings(
      checkpoint
        ? checkpoint.roots.map((root) => root.binding)
        : [
            emptyBinding(1, presets?.[0]?.id ?? ""),
            emptyBinding(2, presets?.[0]?.id ?? ""),
          ],
    );
    setError(null);
    setOpen(true);
  };
  return (
    <section className="space-y-3" aria-label="Multi-repository workspace">
      <h3 className="font-semibold">Repository workspace</h3>
      <p className="text-sm text-muted-foreground">
        Explicit projects, source owners and isolated branches. Preparation
        never starts work. Continuation starts ONE coherent native writer with
        access to all verified repository folders on the same host, only after
        every required root verifies.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {checkpoints.error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(checkpoints.error)}
        </p>
      ) : null}
      {!checkpoints.data?.length ? (
        <Button variant="outline" disabled={busy} onClick={() => edit()}>
          Prepare multiple repositories
        </Button>
      ) : null}
      {checkpoints.data?.map((checkpoint) => (
        <article key={checkpoint.id} className="space-y-2 rounded border p-3">
          <p className="break-words text-sm">
            <strong>{checkpoint.state.replaceAll("_", " ")}</strong> · {checkpoint.roots.length} repositories
          </p>
          {checkpoint.roots.map((root) => (
            <div
              key={root.binding.id}
              className="space-y-1 border-t pt-2 text-sm"
            >
              <p>
                <strong>{root.binding.role}</strong> · {root.state} ·{" "}
                {root.binding.required ? "Required" : "Optional"}
              </p>
              <p className="break-words">
                Owner: {root.binding.owner} · Project:{" "}
                {projectName(root.binding.bbProjectId)}
              </p>
              <p className="break-words">
                Source preserved: {machineName(root.binding.sourceHostId)}:
                {root.binding.sourcePath} ·{" "}
                {root.binding.sourceBranch ?? "detached"}
              </p>
              <p className="break-words">
                Target: {machineName(root.binding.targetHostId)}:{root.binding.targetPath} ·{" "}
                {root.binding.branch}
              </p>
              <p className="break-words">
                History transport:{" "}
                {root.binding.remoteBase
                  ? "Approved published prerequisite; target-local Git/LFS authorization"
                  : "Bounded full Git bundle; no remote-base authorization supplied"}
              </p>
              <p className="break-words">Workspace {root.environmentId ? "prepared" : "not prepared"} · Writer {root.threadId ? "attached" : "not started"} · Transfer {root.transferOperationId ? "verified" : "not verified"}</p>
              {root.threadId && <Button size="sm" variant="outline" onClick={() => navigate.toThread(root.threadId!)}>Open repository writer</Button>}
              {root.error ? (
                <p role="alert" className="text-destructive">
                  {root.error}
                </p>
              ) : null}
              {root.attempts.map((attempt, index) => (
                <p key={index} className="break-words text-muted-foreground">
                  Preserved attempt: {machineName(attempt.targetHostId)}:{attempt.targetPath}{" "}
                  ·{" "}
                  {attempt.error}
                </p>
              ))}
              <details>
                <summary>Instructions and checkpoint handoff</summary>
                <pre className="whitespace-pre-wrap break-words">
                  {root.binding.instructions}
                  {"\n"}
                  {root.handoff}
                </pre>
              </details>
              <details className="text-xs text-muted-foreground"><summary className="cursor-pointer py-2">Copyable repository diagnostics</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(root, null, 2)}</pre><Button size="sm" variant="ghost" onClick={() => void act(() => navigator.clipboard.writeText(JSON.stringify(root, null, 2)))}>Copy diagnostics</Button></details>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={busy || checkpoint.state === "preparing"}
              onClick={() => edit(checkpoint)}
            >
              Inspect / retry preparation
            </Button>
            <Button
              disabled={
                busy ||
                checkpoint.state === "preparing" ||
                checkpoint.roots.some(
                  (root) =>
                    root.binding.required &&
                    !["ready", "spawning", "started"].includes(root.state),
                )
              }
              onClick={() =>
                void act(async () => {
                  await rpc.call("continueTaskRepositories", {
                    taskId,
                    checkpointId: checkpoint.id,
                  });
                })
              }
            >
              Continue verified repositories
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setRevision((value) => value + 1)}
            >
              Refresh
            </Button>
          </div>
        </article>
      ))}
      <ResponsiveDrawerShell
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
        srLabel="Prepare repository workspace"
        contentClassName="max-w-2xl"
      >
        <form
          className="min-h-0 flex-auto space-y-4 overflow-y-auto p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await rpc.call("prepareTaskRepositories", {
                taskId,
                bindings: repositoryBindingsSchema.parse(bindings),
                ...(checkpointId ? { checkpointId } : {}),
              });
              setOpen(false);
            });
          }}
        >
          <h3 className="font-semibold">Prepare repository workspace</h3>
          <p className="text-sm">
            Inspect each source first. Confirm its owner and scope; select all
            portable dirty files and required AGENTS/CLAUDE/MCP configuration.
            Native authentication/session storage and sensitive dirty or
            unpublished files are refused. Ordinary source code needs no
            per-file approval. Target MCP authentication must be configured
            separately. Preparation queues immediately; observe per-root
            progress here. Failed preparation remains inspectable; retry at
            fresh target paths.
          </p>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {(projects.error || machines.error || sourceEnvironments.error) && <div role="alert" className="text-sm text-destructive"><p>{projects.error ?? machines.error ?? sourceEnvironments.error}</p><Button type="button" variant="outline" onClick={() => { projects.refresh(); machines.refresh(); sourceEnvironments.refresh(); }}>Retry execution choices</Button></div>}
          {sourceEnvironments.isLoading && open && <p role="status" className="text-sm text-muted-foreground">Loading ready source workspaces…</p>}
          {bindings.map((binding, index) => {
            const receipt = checkpoints.data
              ?.find((checkpoint) => checkpoint.id === checkpointId)
              ?.roots.find((root) => root.binding.id === binding.id);
            const locked =
              !!receipt &&
              ["ready", "spawning", "started"].includes(receipt.state);
            const textFields = [
              ["role", "Role / scope"],
              ["owner", "Source owner"],
              ["targetPath", "Fresh absolute target path"],
              ["branch", "Isolated target branch"],
            ] as const;
            return (
              <fieldset
                key={index}
                disabled={busy || locked}
                className="space-y-2 rounded border p-3"
              >
                <legend className="font-semibold">
                  Repository {index + 1}
                  {index === 0 ? " · primary workspace" : ""}
                  {locked ? " · verified (read only)" : ""}
                </legend>
                <div className="space-y-1 text-sm"><span>Code project</span><ExecutionPicker label={`Repository ${index + 1} code project`} value={binding.bbProjectId} dialogOpen={open} options={(projects.data ?? []).map(project => ({ value: project.id, label: project.name }))} disabled={busy || locked} onChange={id => update(index, { bbProjectId: id, sourceEnvironmentId: "", sourceHostId: "", sourcePath: "", sourceHead: "", sourceBranch: null, remoteBase: undefined })} /></div>
                <div className="space-y-1 text-sm"><span>Source workspace</span><ExecutionPicker label={`Repository ${index + 1} source workspace`} value={binding.sourceEnvironmentId} dialogOpen={open} options={(sourceEnvironments.data ?? []).filter(environment => environment.bbProjectId === binding.bbProjectId).map(environment => ({ value: environment.id, label: `${environment.name} · ${machineName(environment.hostId)} · ${environment.path}` }))} disabled={busy || locked || !binding.bbProjectId} onChange={id => { const environment = sourceEnvironments.data?.find(entry => entry.id === id); if (environment) update(index, { sourceEnvironmentId: id, sourceHostId: environment.hostId, sourcePath: environment.path, sourceHead: "", sourceBranch: null, remoteBase: undefined }); }} /></div>
                <div className="space-y-1 text-sm"><span>Target machine</span><ExecutionPicker label={`Repository ${index + 1} target machine`} value={binding.targetHostId} dialogOpen={open} options={(machines.data ?? []).map(machine => ({ value: machine.id, label: machine.name }))} disabled={busy || locked} onChange={id => update(index, { targetHostId: id })} /></div>
                {textFields.map(([key, label]) => (
                  <label key={key} className="flex flex-col gap-1 text-sm">
                    {label}
                    <Input
                      value={binding[key]}
                      onChange={(event) =>
                        update(index, { [key]: event.target.value })
                      }
                      required
                    />
                  </label>
                ))}
                <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-8">
                  <input
                    type="checkbox"
                    checked={binding.required}
                    onChange={(event) =>
                      update(index, { required: event.target.checked })
                    }
                  />
                  Required before any writer starts
                </label>
                <div className="space-y-1 text-sm">
                  <span>Shared execution profile (same profile for every root)</span>
                  <ExecutionPicker label={`Repository ${index + 1} execution profile`} value={binding.presetId} dialogOpen={open} options={(presets ?? []).map(preset => ({ value: preset.id, label: `${preset.name} · ${preset.modelId}` }))} disabled={busy || locked} onChange={id => update(index, { presetId: id })} />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    void act(async () => {
                      const source = await rpc.call("inspectTaskRepository", {
                        taskId,
                        bbProjectId: binding.bbProjectId,
                        sourceEnvironmentId: binding.sourceEnvironmentId,
                        targetHostId: binding.targetHostId,
                      });
                      setRemoteCandidates((current) => ({
                        ...current,
                        [binding.id]: source.remoteBaseCandidates ?? [],
                      }));
                      setFlaggedPaths((current) => ({
                        ...current,
                        [binding.id]: source.files
                          .filter(
                            (file) =>
                              file.tracked &&
                              file.excludedReason?.startsWith("Sensitive"),
                          )
                          .map((file) => file.path),
                      }));
                      update(index, {
                        sourceHostId: source.sourceHostId,
                        sourcePath: source.sourcePath,
                        sourceBranch: source.sourceBranch,
                        sourceHead: source.sourceHead,
                        includePaths: source.files
                          .filter(
                            (file) =>
                              !file.tracked &&
                              !file.excludedReason?.startsWith("Sensitive") &&
                              (file.kind === "untracked" ||
                                /(^|\/)(AGENTS\.md|CLAUDE\.md|\.mcp\.json)$/u.test(
                                  file.path,
                                )),
                          )
                          .map((file) => file.path),
                        instructionPaths: source.files
                          .filter(
                            (file) =>
                              !file.excludedReason?.startsWith("Sensitive") &&
                              /(^|\/)(AGENTS\.md|CLAUDE\.md|\.mcp\.json)$/u.test(
                                file.path,
                              ),
                          )
                          .map((file) => file.path),
                      });
                      if (source.activeThreadIds.length)
                        throw new Error(
                          `Stop source writers before preparation: ${source.activeThreadIds.join(", ")}`,
                        );
                    })
                  }
                >
                  Inspect source and select portable dirty files
                </Button>
                <p className="break-words text-sm">
                  {machineName(binding.sourceHostId)}:{binding.sourcePath} ·{" "}
                  {binding.sourceBranch ?? "detached"} · HEAD{" "}
                  {binding.sourceHead || "not inspected"}
                </p>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!!binding.remoteBase}
                    onChange={(event) =>
                      update(index, {
                        remoteBase: event.target.checked
                          ? { url: "", ref: "refs/heads/main", head: "" }
                          : undefined,
                      })
                    }
                  />
                  Use an explicitly approved published Git base for a large
                  repository
                </label>
                <p className="text-xs text-muted-foreground">
                  Only unpublished commits and dirty overlays cross BB. The
                  target fetches published Git history and unchanged LFS using
                  its own authorization. No source fetch, push, credential
                  copying or automatic fallback. Cached candidates are not proof
                  of remote availability.
                </p>
                {remoteCandidates[binding.id]?.length ? (
                  <label className="flex flex-col gap-1 text-sm">
                    Approve a cached origin candidate
                    <select
                      value=""
                      onChange={(event) => {
                        const candidate =
                          remoteCandidates[binding.id]?.[
                            Number(event.target.value)
                          ];
                        if (candidate) update(index, { remoteBase: candidate });
                      }}
                    >
                      <option value="">
                        Choose explicitly, or enter an agreed base below
                      </option>
                      {remoteCandidates[binding.id]?.map(
                        (candidate, position) => (
                          <option
                            key={`${candidate.ref}:${candidate.head}`}
                            value={position}
                          >
                            {candidate.ref} · {candidate.head} · {candidate.url}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                ) : null}
                {binding.remoteBase ? (
                  <div className="space-y-2">
                    {(
                      [
                        ["url", "Approved credential-free Git origin"],
                        [
                          "ref",
                          "Published ref (refs/heads/... or refs/tags/...)",
                        ],
                        ["head", "Exact published prerequisite commit"],
                      ] as const
                    ).map(([key, label]) => (
                      <label key={key} className="flex flex-col gap-1 text-sm">
                        {label}
                        <Input
                          value={binding.remoteBase?.[key] ?? ""}
                          onChange={(event) =>
                            update(index, {
                              remoteBase: {
                                url: binding.remoteBase?.url ?? "",
                                ref: binding.remoteBase?.ref ?? "",
                                head: binding.remoteBase?.head ?? "",
                                [key]: event.target.value,
                              },
                            })
                          }
                          required
                        />
                      </label>
                    ))}
                  </div>
                ) : null}
                {flaggedPaths[binding.id]?.length ? (
                  <details className="text-sm">
                    <summary>
                      Ambiguous key/config files or excluded native storage
                    </summary>
                    <p>
                      Ordinary token/secret source modules are not sensitive
                      storage. Review ambiguous key/config files with their
                      owner and list only approved repository files below; they
                      must already be unchanged in the approved published base.
                      Native authentication/session paths are forbidden even if
                      selected. No flagged file is selected automatically.
                    </p>
                    <pre className="whitespace-pre-wrap break-words">
                      {flaggedPaths[binding.id]?.join("\n")}
                    </pre>
                  </details>
                ) : null}
                <label className="flex flex-col gap-1 text-sm">
                  Repository instructions
                  <Textarea
                    value={binding.instructions}
                    onChange={(event) =>
                      update(index, { instructions: event.target.value })
                    }
                    required
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  Required instruction/configuration paths (one per line)
                  <Textarea
                    value={binding.instructionPaths.join("\n")}
                    onChange={(event) =>
                      update(index, {
                        instructionPaths: event.target.value
                          .split("\n")
                          .map((line) => line.trim())
                          .filter(Boolean),
                      })
                    }
                    required
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  Explicit files and approved published context (one per line;
                  never native tokens or sessions)
                  <Textarea
                    value={binding.includePaths.join("\n")}
                    onChange={(event) =>
                      update(index, {
                        includePaths: event.target.value
                          .split("\n")
                          .map((line) => line.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </label>
                {!checkpointId && bindings.length > 2 ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      setBindings((current) =>
                        current.filter((_, position) => position !== index),
                      )
                    }
                  >
                    Remove repository
                  </Button>
                ) : null}
              </fieldset>
            );
          })}
          <div className="sticky bottom-0 flex flex-wrap gap-2 bg-background py-3 max-sm:[&_button]:min-h-11">
            {!checkpointId ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy || bindings.length >= 32}
                onClick={() =>
                  setBindings((current) => [
                    ...current,
                    emptyBinding(current.length + 1, presets?.[0]?.id ?? ""),
                  ])
                }
              >
                Add repository
              </Button>
            ) : null}
            <Button type="submit" disabled={busy || bindings.some(binding => !binding.bbProjectId || !binding.sourceEnvironmentId || !binding.sourceHead || !binding.targetHostId || !binding.presetId)}>
              Prepare without starting
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              Close
            </Button>
          </div>
        </form>
      </ResponsiveDrawerShell>
    </section>
  );
}
