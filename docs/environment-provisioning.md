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

For preparation without a model turn, the existing Core thread-create route and
`BbSdk.threads.spawn` accept `preparationOnly: true` with `input: []`, an explicit
title and a provider-selected or reused environment. Source/fork/parent seeds,
scheduled messages and nonempty input are refused. This creates a real native
preparation context, performs the same Core execution-binding and dispatch
admission, provisions through the normal environment engine, and settles idle
without a client turn request or `thread.start`. A provided title also prevents
metadata-inference model work. No provider session or conversation is imported.
The field is server-side only; no daemon wire field or permission policy changes.

Tasks uses this operation for observable, receipt-fenced single-root workflow
preparation and independent role admission. Its task/owner-scoped draft survives
client close/reload; project/template settings are explicit saves. Start is a
separate action and reuses the same owned workspace. An uncertain preparation
response is reconciled from native ownership metadata, never by creating a
second worktree. Human Accept/Return remain separate from preparation and Start.


## Provider runtime retirement and bounded cleanup

Runtime retirement closes admission before taking its cleanup snapshot. New
environment ensures and thread-command retention refuse an entry while it is
retiring; an already-obtained runtime handle also refuses new execution. The
entry remains reachable until shutdown succeeds. Failed cleanup does not reopen
that runtime for another thread or another attempt.

For bounded provider sessions, a deferred bridge replacement acquires cleanup
ownership before teardown. An expected bridge exit is not proof that its owned
descendants stopped: the startup receipt remains blocking until process-tree
termination is confirmed. Replacement waits for that physical quiescence without
waiting on the replacement control operation itself. Unverified cleanup records
`provider_startup_stop_unverified`; Core retry remains blocked after a database
reopen rather than trusting the earlier ready receipt.

Stopping the parent of a completed bounded rewind lease also waits for confirmed
owned-process cleanup. If native discard rejects or times out, the runtime stops
the owned process tree before acknowledging stop. If that termination cannot be
confirmed, it retains ownership and the retry blocker instead of reporting
successful cancellation or treating a scheduled background retry as cleanup.

An explicit interrupt can reach a bounded startup that already owns its thread
but has not established a provider session. It bypasses the per-thread command
lane and the active-turn wait, rather than waiting behind the startup it must
cancel. The existing runtime stop still waits for confirmed owned-process cleanup
before acknowledgment. Legacy startup handoff ordering, release requests, and the
five-second active-turn wait outside that owned startup state are unchanged.

Normal runtime shutdown still aborts and drains the owned processes of an already
ready provider, but it preserves the completed startup result instead of creating
a false startup-cancelled attempt. Pending startup and prepared rewind cleanup
retain their cancellation diagnostics. If ready-provider termination cannot be
confirmed, a separate allowlisted cleanup-failure receipt durably blocks retry and
continuation after a daemon restart or cold database reopen. The completed startup
receipt remains unchanged; ownership remains held until operator verification.

Startup diagnostics retain the coordinator's last known stage in `failureStage`
before switching to `stopping`/`stopped`: `initializing`, `hook`, `capabilities`,
or `ready`. It is `null` before interruption and when parsing older receipts
without a captured stage. The existing failure code remains allowlisted; no
provider-supplied stage or arbitrary exception code is copied into diagnostics.
The original caught exception remains available by identity as non-enumerable,
internal `Error.cause`, not as serialized metadata or transcript content. Public
failure messages remain generic. Composed daemon protocol 246 carries the enriched
startup diagnostic.

At the host RPC logging boundary, recognized startup failures are projected to
the command type and allowlisted error code instead of passing the error object
to Pino. This applies in every environment: Pino's cause-aware serializer can
traverse even non-enumerable causes. The original error and cause are not
mutated; known stage details remain in the existing startup diagnostic. Other
error logging policy is unchanged.

## Project preparation and transfer API

The core SDK exposes these methods under `BbSdk.projects`. Each input also
accepts an optional abort `signal`. Preview and transfer additionally accept
per-call `timeoutMs`; this is SDK transport metadata, not an HTTP JSON field.
The default Node request timeout remains 75 seconds; callers may explicitly
allow longer transfers without changing other requests' deadlines.

| SDK method                 | HTTP route                                             | Input                                                                                                          |
| -------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `prepareMachine`           | `POST /api/v1/projects/:id/prepare-machine`            | `{projectId, hostId, targetPath, sourceHostId?, copyPaths?}`                                                   |
| `previewWorkspaceTransfer` | `POST /api/v1/projects/:id/preview-workspace-transfer` | `{projectId, sourceEnvironmentId, targetHostId}`                                                               |
| `transferWorkspace`        | `POST /api/v1/projects/:id/transfer-workspace`         | `{projectId, sourceEnvironmentId, targetHostId, targetPath, branch?, includePaths, remoteBase?, operationId?}` |
| `getWorkspaceTransfer`     | `GET /api/v1/workspace-transfers/:operationId`         | `{operationId}`                                                                                                |

Project IDs are route parameters, not JSON body fields. Preparation returns
`{source, copiedFiles: [{path, sha256}], readiness: {ready, checks: [{name, ok,
detail}]}}`. Readiness reports actual checks, including failures. Explicit copy
paths are confined relative files from a source host belonging to this project;
there are no implicit secret-file copies or silent overwrites.

Preview returns `{sourceEnvironmentId, sourceHostId, head, branch, files,
activeThreadIds, remoteBaseCandidates?}`. Each file has `{path, kind, tracked,
selectedByDefault, excludedReason?}`. Branch is nullable. Cached origin/ref/SHA
candidates are suggestions requiring explicit approval, not proof of remote
availability.

Inspect exclusions before selecting portable untracked/ignored files. Ordinary
token/secret source modules, action code and project instructions are not
credential storage and need no per-file approval. Ambiguous key/config-shaped
tracked files use `kind: "sensitive-tracked"`: review with the source owner,
select exact approved paths, and provide a published `remoteBase`. Their HEAD,
index and worktree content must be unchanged at that prerequisite. Sensitive
untracked, staged, dirty or unpublished historical blobs are refused. Native
authentication/session storage is forbidden even when explicitly selected.
These are path-based safeguards, not a semantic secret scanner.

Transfer returns `{operationId, status: "ready", environmentId, hostId, rootPath,
head, branch, handoff}` only after verification. The durable query returns
`operationId`, `projectId`, `sourceEnvironmentId`, `sourceHostId`, `targetHostId`,
`targetPath`, `createdAt`, `updatedAt` and status. Status is `pending`,
`capturing`, `transferring`, `verifying`, `ready`, `failed` or `interrupted`.
Ready includes the transfer result fields and optional `continuationThreadId`;
failure exposes an `error` string. Captured payloads have durable byte-count and
SHA-256 receipts (`checkpointBytes`, `checkpointSha256`). Use the operation ID
to inspect a transfer after a lost client connection. A caller-provided
`operationId` is claimed exclusively; resubmission does not overwrite or replay
an existing operation.

The source environment and its threads must be idle and remain unchanged during
capture. The target path must be new; transfer preserves the source and registers
a new environment of the same project. Staged/unstaged tracked changes, deletes,
binary files and modes are preserved. There is no live native session migration:
continuation starts a new session using the returned handoff.

For a published base, supply `remoteBase: {url, ref, head}`: a credential-free
HTTPS or SSH origin, explicit `refs/heads/...` or `refs/tags/...`, and exact
prerequisite commit SHA. The source verifies locally available ancestry without
fetching or changing its refs. The target fetches the approved ref using its
**own** Git authentication, verifies that it contains the prerequisite, and
applies only unpublished commits through a bounded incremental bundle. When
source HEAD itself is the approved published commit, no bundle is needed.
Tracked dirty overlays and explicit extra files remain independently verified.
Missing refs, authorization or prerequisite objects fail visibly: no other
account, origin, push or full-history fallback is attempted.

Without `remoteBase`, a bounded full bundle remains available without target
origin access. It must still satisfy the same checkpoint limits and sensitive
history restrictions. Source Git config, credentials and native sessions are
not copied. Remote mode creates only the explicitly approved target origin;
provider and MCP authorization remain target-local prerequisites.
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
Unchanged tracked files come from the approved target fetch or Git bundle,
not duplicate worktree blobs; any bundle's compressed bytes still count.
Staged and working versions can count twice. Preparation copy batches also
support 64 MiB combined.
Index metadata and preview lists support 100,000 entries. The decoded limit can produce
approximately 85.4 MiB of base64-encoded RPC JSON plus metadata. Each checkpoint
or `{files}` copy batch must also fit 96 MiB of UTF-8 JSON serialization,
including base64 and path/index metadata. Both limits apply. Oversized capture
and copy reads fail before returning data; restore and copy writes fail before
target processing or mutation. Transfers are not chunked or truncated.
Tracked symlinks preserve mode `120000` and pointer bytes, not dereferenced
contents. Targets must be existing, repository-confined relative paths that
avoid Git internals and sensitive storage. Source and target validation also
cover staged and unstaged pointer changes. Untracked/explicit-copy symlinks,
escaping links, submodules/gitlinks, sparse checkout/index,
unmerged entries, skip-worktree, assume-unchanged, in-progress Git operations
and custom non-LFS clean/smudge filters are refused. Shallow/partial/promisor
clones, grafts and replacement refs are also refused to avoid lazy network
fetches, incomplete history and source mutation. No whole-home archive
or automatic agent-session/auth/MCP-secret directory copying is performed.
Only exact extra files can be selected, including explicit nested relative
paths. Ignored directories appear as excluded directory entries in preview;
selection does not recursively copy directories.

Ordinary transfers require Node and Git. Git LFS source files must contain
materialized bytes, not unresolved pointers; materialize them separately before
capture, because transfer never fetches into the source. With an approved base,
unchanged published LFS content is fetched and materialized using target-native
Git LFS/authentication, rather than embedded in JSON. Its raw identity is then
verified against the source checkpoint. Dirty or unpublished LFS content still
counts toward the bounded dirty overlay.

The target must have `git-lfs` installed for LFS paths. Transfer configures only
standard target-local LFS filters, before materialization, and copies no network
credentials. The effective `filter=lfs` path set must match on the target.
Select required `.gitattributes` files explicitly when untracked/ignored;
source-only info attributes or attribute mismatches fail rather than changing
file interpretation silently.

## Coherent multi-repository Task preparation

Tasks exposes `repositories inspect`, `prepare`, `show` and `continue` through
its CLI and Task panel. The matching plugin RPC/SDK methods are
`inspectTaskRepository`, `prepareTaskRepositories`, `getTaskRepositories` and
`continueTaskRepositories`. Bind 2–32 explicit repositories with owner, role,
source host/path/branch/HEAD, target host/path, isolated branch, executor preset,
instructions and required instruction paths. Do not derive roots or ownership
from the default project. Tasks permits up to 10,000 explicit `includePaths`.

The first binding is required and becomes the primary environment; all targets
must share one host and executor profile and have distinct, non-nested roots.
Each keeps its own Git repository, environment, branch and dirty checkpoint.
One coherent native thread receives all ready folders' paths and instructions.
There is no synthetic umbrella repository or mandatory agent-per-root split.
Every required root must pass preparation and execution readiness checks before
any executor starts; the aggregate gate cannot be bypassed through single-root
delegation/continuation.

Task preparation persists reservations and returns a `preparing` checkpoint
immediately. The existing plugin lifecycle background service performs the work
and publishes per-root progress; this is not a synchronous multi-root RPC.
It opts into a 20-minute preview request and a 45-minute transfer request, while
native capture/restore phases retain their own 20-minute bounds. Cancellation
and plugin restart preserve explicit `interrupted`/unknown outcomes and native
operation IDs. `show`/get reconciles available ready receipts without replay.
Partial preparation never means overall migration success.

Retry a settled checkpoint with its ID, keep verified roots unchanged and
choose fresh target paths for failed/interrupted roots. Prior targets, payloads
and attempt history remain inspectable. Continue explicitly after agreement;
once continuation begins, the bound root set is fixed. Core
`threads.spawn` uses the primary `transferOperationId`, reused primary
environment and `repositoryTransferOperationIds`; native
`additionalWorkspacePaths` supplies the other roots and their write permissions.

The durable `workspace-repository-groups/<primaryEnvironmentId>.json` manifest
and transfer `.checkpoint`/operation receipts preserve scoped native ownership
and recovery state. They are not an OS sandbox: read-only inspection and human
Git controls remain available, and external host processes can still write
files. Coordinate human edits and stop native writers before intervention;
group-bound secondary executor/terminal admission remains fenced.

Backup work is explicitly deferred. Local manifest/payload durability neither
activates nor accepts a backup system, and no backup restore proof is required
in this wave.

CLI equivalents and all flags are in `bb guide projects`; see
[multiple-device usage](multiple-devices.md) for the operator workflow.
