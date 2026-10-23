Delegation presets are user-defined; Tasks ships with none. Before dispatching
work, use `bb tasks preset list` and create a preset if the required one does
not already exist. Dispatch requires an existing preset.

Create or update the same execution selection exposed in the Tasks UI with
`--provider`, `--model`, `--reasoning`, and optional
`--service-tier <tier>`. A tier is an id the provider lists for the model
(`default`, `fast`, or another such as Codex `ultrafast`; see
`bb provider models <provider> --json`):

```sh
bb tasks preset create --name "Codex high" --provider codex \
  --model gpt-5.6-sol --reasoning high --service-tier fast \
  --permission auto
```

`preset update` accepts the same flags; `--clear-service-tier` clears a tier.
Do not combine it with `--service-tier`; `none` is a literal tier id.

## Per-task execution routing

```sh
bb tasks execution set ABC-12 --bb-project proj_code --machine laptop \
  --workspace managed-worktree --base-branch main --preset "Codex high"
bb tasks execution get ABC-12 --json
bb tasks delegate ABC-12
bb tasks execution clear ABC-12
bb tasks execution environments --bb-project proj_code --machine laptop --json
```

`set` requires all of `--bb-project`, `--machine`, `--workspace`, and `--preset`.
Use a code-project id, not the tracker prefix. Workspace choices are
`managed-worktree` with optional `--base-branch`, `project-checkout`, or
`existing-environment` with required `--environment <id>`.
Machines and profiles resolve by name or id. A saved target allows dispatch
without `--preset`; legacy `delegate ABC-12 --preset "Codex high"` still works.
An invocation preset overrides the saved profile; clearing the task target
restores tracker-project/profile inheritance. `execution get --preset <profile>`
previews that profile's resolved routing.
For an invocation-only route, `dispatch`/`delegate --execution-target '<json>'`
accepts `{bbProjectId,hostId,workspace,presetId}` with exact ids, validated by the
shared RPC schema. Prefer `execution set` for reusable persisted routing.

## Continue idle work in a new native session

```sh
bb tasks continue preview ABC-12 --thread thr_source --machine workstation --json
bb tasks continue start ABC-12 --thread thr_source --machine workstation \
  --target-path /work/new-task --preset "Codex high" \
  --include-path notes.txt --include-path assets/sample.bin \
  --instructions "Finish the remaining criteria" --branch task-continuation --json
bb tasks continue list ABC-12 --json
```

Inspect preview file exclusions and active thread ids first. This is not a live
session move: the source must be idle and remains attached. The target path must
be new; never overwrite existing work. Tracked work transfers under core safety
policy. Repeat `--include-path` for explicit relative untracked/ignored files
or consent to exact `sensitive-tracked` files reported by preview. Every sensitive
tracked file requires explicit consent or resolution at source; none can be
silently dropped. Review warnings before selecting secrets or `.env`; nothing
sensitive is selected implicitly. Continuation seeds task context and
handoff into a new native session. It neither completes the task nor writes to
external Jira.

The source remains inspectable as the previous executor after handoff; use the
new attached executor for subsequent continuation. Native spawn carries
`transferOperationId` for core's atomic ready-transfer/source-idle admission
check. Source and target dispatch are mutually gated while the counterpart
is running, not permanently frozen.

If transfer succeeds but spawning fails, `continue list` retains a `ready`
operation with `lastError`. Repeat `continue start` with the original task,
source, target machine/path, and profile plus `--operation <operationId>` to
retry spawning into that prepared environment without overwriting or
retransferring it. Omit `--include-path` and `--branch` on explicit operation
retry: the prepared files and branch are retained. A `spawning` record first
reconciles operation metadata to avoid a duplicate session. Never start a second
independent transfer as a substitute for retrying the ready operation.

RPC equivalents in `DelegationRpcContract`: `getTaskExecution({taskId,presetId?})`,
`setTaskExecution({taskId,target})` (`target: null` clears),
`listTaskExecutionEnvironments({bbProjectId,hostId?})`,
`previewTaskContinuation({taskId,sourceThreadId,targetHostId})`,
`continueTask({taskId,sourceThreadId,targetHostId,targetPath,presetId,includePaths,
extraInstructions?,branch?,operationId?})`, and `getTaskContinuations({taskId})`.
`delegate` accepts optional `presetId` and invocation `executionTarget`.
Core workspace method names are `projects.prepareMachine`,
`projects.previewWorkspaceTransfer`, `projects.transferWorkspace`, and
`projects.getWorkspaceTransfer`.
