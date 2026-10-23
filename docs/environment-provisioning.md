# Environment and thread startup

An environment row exists before its provider creates the workspace. Its
`status` moves from `creating` through `provisioning` (daemon attachment and
setup) to `ready`, or to `error`. Environment routes, the SDK, and the CLI
show reservations with `status: creating`; `statusMessage` holds current
progress or the terminal creation error. A server restart resumes the same walk.

- Creation failures are terminal; there is no automatic create retry. An
  explicit retry cleans the previous attempt and reuses the row. A failed setup
  script can be retried on the same environment without recreating its
  workspace.
- A provider that returns an existing project checkout keeps that checkout's
  identity and retires the unused reservation. A rejected foreign path records
  an error and is never handed to removal.
- A path is claimed before the provider mutates it, so concurrent threads
  cannot take it, and a claim survives failed cleanup until removal succeeds.
- Cancellation waits for the active create to settle before removing its
  resources. Shared environments remain until their last live thread leaves,
  then retire after the provider's grace period. Pending cleanup survives
  provider unavailability and server restart.
- The environment provider SDK reports a failed create as
  `{ status: "failed", message }`; the Plugin Guide documents this contract.

A thread's first message stays queued while its environment is prepared, and
is consumed when provisioning is admitted. Once agent start has been handed to
the daemon, recovery never resends an uncertain start automatically; use the
normal interruption and retry behavior.

## Project preparation and transfer API

The core SDK exposes these methods under `BbSdk.projects`. Each input also
accepts an optional abort `signal`.

| SDK method | HTTP route | Input |
| --- | --- | --- |
| `prepareMachine` | `POST /api/v1/projects/:id/prepare-machine` | `{projectId, hostId, targetPath, sourceHostId?, copyPaths?}` |
| `previewWorkspaceTransfer` | `POST /api/v1/projects/:id/preview-workspace-transfer` | `{projectId, sourceEnvironmentId, targetHostId}` |
| `transferWorkspace` | `POST /api/v1/projects/:id/transfer-workspace` | `{projectId, sourceEnvironmentId, targetHostId, targetPath, branch?, includePaths}` |
| `getWorkspaceTransfer` | `GET /api/v1/workspace-transfers/:operationId` | `{operationId}` |

Project IDs are route parameters, not JSON body fields. Preparation returns
`{source, copiedFiles: [{path, sha256}], readiness: {ready, checks: [{name, ok,
detail}]}}`. Readiness reports actual checks, including failures. Explicit copy
paths are confined relative files from a source host belonging to this project;
there are no implicit secret-file copies or silent overwrites.

Preview returns `{sourceEnvironmentId, sourceHostId, head, branch, files,
activeThreadIds}`. Each file has `{path, kind, tracked, selectedByDefault,
excludedReason?}`. Branch is nullable. Inspect exclusions before selecting
untracked/ignored files; tracked secret exclusions require explicit
`includePaths` consent rather than silently losing changes.
Ordinary tracked secret-like files use `kind: "sensitive-tracked"` and can be
explicitly selected for consent; unsupported file types are hard refusals.

Transfer returns `{operationId, status: "ready", environmentId, hostId, rootPath,
head, branch, handoff}` only after verification. The durable query returns
`operationId`, `projectId`, `sourceEnvironmentId`, `sourceHostId`, `targetHostId`,
`targetPath`, `createdAt`, `updatedAt` and status. Status is `pending`,
`capturing`, `transferring`, `verifying`, `ready`, `failed` or `interrupted`.
Ready includes the transfer result fields and optional `continuationThreadId`;
failure exposes an `error` string. Use the operation ID to inspect a transfer
after a lost client connection.

The source environment and its threads must be idle and remain unchanged during
capture. The target path must be new; transfer preserves the source and registers
a new environment of the same project. A Git bundle carries unpublished commits
without requiring private remote access on both machines. Staged/unstaged tracked
changes, deletes, binary files and modes are preserved. There is no live native
session migration: continuation starts a new session using the returned handoff.
The target is created from the source bundle without origin access. Git config,
authentication and remote configuration are not automatically transferred.
Ordinary files retain their POSIX `rwx` permission bits, independently of Git's
executable bit. Checkpoints include permissions metadata for unchanged tracked
files without retransmitting their contents. Ownership, ACLs, extended
attributes and special permission bits are not migrated.

`targetPath` must be canonical and absolute: no `~`, dot segments or trailing
slash. Preparation copies only into the registered project source checkout;
subsequent isolated worktrees do not inherit copied untracked/ignored files.

To continue safely, call `BbSdk.threads.spawn` with `transferOperationId`, the
same `projectId`, and `environment: {type: "reuse", environmentId}` using the
ready target ID. The server validates readiness/project/environment, atomically
checks and locks the idle source through thread creation, and persists
`continuationThreadId`. Retrying the operation returns the linked thread instead
of creating another. A durable symmetric source/target active-dispatch fence
survives server restarts. The CLI equivalent is `bb thread spawn --project <id>
--environment <target-environment-id> --transfer-operation-id <operation-id>
--prompt "Continue from the handoff"`.

Checkpoint payloads support 64 MiB of combined decoded bytes across bundle,
changed staged-index blobs, changed tracked working files and selected extras.
Unchanged tracked files travel in the Git bundle rather than duplicate worktree
blobs; the bundle's compressed bytes still count. Staged and working versions
can count twice. Preparation copy batches also support 64 MiB combined.
Index metadata and preview lists support 10,000 entries. The decoded limit can produce
approximately 85.4 MiB of base64-encoded RPC JSON plus metadata. Each checkpoint
or `{files}` copy batch must also fit 96 MiB of UTF-8 JSON serialization,
including base64 and path/index metadata. Both limits apply. Oversized capture
and copy reads fail before returning data; restore and copy writes fail before
target processing or mutation. Transfers are not chunked or truncated.
Symlinks, submodules/gitlinks, sparse checkout/index,
unmerged entries, skip-worktree, assume-unchanged, in-progress Git operations
and custom non-LFS clean/smudge filters are refused. Shallow/partial/promisor
clones, grafts and replacement refs are also refused to avoid lazy network
fetches, incomplete history and source mutation. No whole-home archive
or automatic agent-session/auth/MCP-secret directory copying is performed.
Only exact ordinary files can be selected, including explicit nested relative
paths. Ignored directories appear as excluded directory entries in preview;
selection does not recursively copy directories.

Ordinary transfers require Node and Git. Git LFS transfers preserve materialized
working bytes alongside pointer index entries; unresolved pointer-only files
are refused: fetch/materialize actual source bytes before retrying. When LFS
paths exist, the target must have `git-lfs` installed;
transfer configures only standard local LFS filter commands and copies no
network credentials or authentication. The effective `filter=lfs` path set must
match on the target. Select required `.gitattributes` files explicitly when
untracked/ignored; source-only info attributes or attribute mismatches fail with
actionable errors rather than changing file interpretation silently.

CLI equivalents and all flags are in `bb guide projects`; see
[multiple-device usage](multiple-devices.md) for the operator workflow.
