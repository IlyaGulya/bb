# Tasks

Tasks is a Linear-style tracker inside bb for planning work, delegating it to
agents, and keeping the task record connected to the threads doing the work.
It provides projects and folders, task keys, statuses and priorities, labels,
subtasks, Markdown comments, attachments, agent presets, and a full CLI.

## Install

Install Tasks from the official plugins that BB includes:

```sh
bb plugin install tasks
```

The plugin adds the Tasks sidebar panel, the `bb tasks` command, and an agent
skill that teaches workers how to report progress back to tasks.

For readable UI evidence, the shipped Tasks skill includes a local OMP-recorder
timing adapter and FFmpeg caption/change-accent recipe. Read
[the video demo reference](skills/tasks/references/video-demo.md) for distributed
worker/CLI/SDK resource access, genuine action clocks, original/final provenance,
optional approved local narration, visual verification and existing attachments.
It adds no recording service, server encoding API, analytics transport, or Task
video schema.
Capture requires qualified native JavaScript Eval lifetime protocol v1, explicit
Eval-owned new-page acknowledgement and the executing SDK's source revision.
Older SDKs/session-owned captures are refused; default browser session lifetime
is unchanged. Local receipt/manifest v3 retains this ownership/source provenance.

## Quick start

Install the plugin with `bb plugin install tasks`. Then use the `bb tasks` CLI
to create a tracker project. Link it to the bb project where delegated agents
will run:

```sh
bb tasks project create \
  --name "Product" \
  --prefix PROD \
  --link-bb-project proj_your_bb_project

bb tasks create \
  --project PROD \
  --title "Ship task delegation" \
  --description "Implement the flow and run focused validation." \
  --priority high

bb tasks list --project PROD
bb tasks show PROD-1
bb tasks preset list
bb tasks delegate PROD-1 --preset "GPT-5.6 · high"
```

When the CLI runs inside a linked bb project, `create` and `list` infer the
tracker project, so `--project` can be omitted. Task keys are case-insensitive
at the CLI boundary. You can also delegate from a task's **Delegate** menu,
choose or create presets under **Manage → Presets**, and type `@` in the bb
composer to send a task mention to an agent.

The comment composer shows a **Notify last responding agent** switch. When the
task has an agent reply, leave it on to send the new comment to the thread that
authored the latest reply, resuming that thread when it is idle. Turn it off to
keep the comment in Tasks only. If no agent has replied, the disabled control
says so explicitly. Agents and scripts can use the same behavior with
`bb tasks comment PROD-1 --body "New context" --notify`.
The app and Tasks RPC return the saved comment before notification delivery,
with `notifiedCount` initially 0. Comment change events publish immediately and
again when delivery finishes. The CLI waits for delivery, so `--notify --json`
includes the final `notifiedCount`. Failed delivery leaves that count at 0.
When run from a thread, the CLI preserves that agent thread and any explicit
`--author`; notification still targets the prior latest responder rather than
the newly recorded agent comment itself.

## Inbox and Working

Open **Tasks → Inbox** for **New**, **Needs input**, and **Review**. Incoming
is a durable record independent of a task or thread. Capture a title, context,
and optional original source link before deciding whether it merits a task.
Work, Personal, and Unclassified are organization, not access control.

Create one native task from an incoming item, or link an existing key. Repeating
creation returns that same task; it does not spawn an agent. The incoming is
resolved, with its original context and decision history retained. Open the task
to configure its inherited/per-task execution route and use the existing dispatch
flow. Attachments, Jira synchronization, and continuation remain native Tasks
operations.

**Working** shows linked native threads that are starting or working, excluding
pending questions. **Needs input** links directly to the actual interactive
thread for native questions/approvals or current executor failures. Resolve
reminder never answers, approves, retries, or resumes a thread. Answer using
the native thread controls, or `bb thread interactions list <threadId>`, then
`show`, `answer`, `approve`, or `respond` with the interaction and thread IDs.
Use those commands' help for response options; the Inbox source key is the
native interaction ID. Do not answer a question by posting a task comment.

Failure reminders apply only to the newest non-retired executor attachment of
an open task. Older failed attempts and Done/Canceled task failures remain
history, not new blockers. Real unanswered native interactions are still
discovered on older attached sessions, and canonical running-thread discovery
keeps genuinely active older sessions visible in Working. Failure revisions
come from persisted native attempt/error events, so a later failed turn reopens
attention even if its intervening recovery happened between Inbox sweeps.
Unavailable failure-event reads preserve prior decisions and report a warning.

`in_review` creates a Review item pointing to the task and its result thread.
Managed build/review results point to the retained writer's package rather
than the newest reviewer link. Ordinary results use the latest non-retired
thread. Idle, completed and deleted threads never mark the task accepted.
Resolve dismisses only the reminder. Managed workflows require exact-revision
Accept; a generic status change to Done is rejected. Changed review content
reopens attention; priority/timestamp-only changes do not. A completed workspace
continuation's source is retained as history and excluded from current attention.

Snooze chooses a future local time in the UI, or an ISO-8601 timestamp with
timezone from the CLI. The server returns due entries within its 15-second
sweep (also on reads/startup), independently of an open browser. Return now
unsnoozes immediately. A meaningful new source revision wakes a snoozed item.
Resolved/snoozed views and History expose previous decisions. Unavailable
native reads are explicit warnings; they neither invent blockers nor silently
resolve existing questions.

```sh
bb tasks inbox add --title "Investigate incoming" --body "Original context" --context work --json
bb tasks inbox list --state open --json
bb tasks inbox snooze <inbox-id> --until 2026-11-01T09:00:00+02:00
bb tasks inbox list --state snoozed --json
bb tasks inbox unsnooze <inbox-id>
bb tasks inbox task <inbox-id> --project PROD --json
bb tasks inbox link <another-inbox-id> --task PROD-1
bb tasks inbox resolve <inbox-id>
bb tasks inbox history <inbox-id> --json
bb tasks working --json
```

The authenticated `tasks` plugin RPCs are `listInbox({state?,context?})`,
`listWorking({})`, `createInbox({title,body?,context?,sourceUrl?})`,
`decideInbox({id,action:'resolve'|'snooze'|'unsnooze',until?})`,
`createInboxTask({id,projectId})`, `linkInboxTask({id,taskId})`, and
`inboxHistory({id})`. Task/project IDs are native tracker IDs, not keys or
code-project IDs. The CLI resolves keys/prefixes before invoking the same
policy. Lists return `{items,warnings}`; mutations return `{item}`.

External adapters use `bb.sdk.plugins.callRpc({pluginId:"tasks",
method:"upsertInboxSource",input:{sourceKind,sourceKey,revision,title,body,
active,context?,sourceUrl?}})`, or:

```sh
bb tasks inbox source --data '{"sourceKind":"machine_health","sourceKey":"host_example:disk","revision":"incident-1:critical","title":"Low disk","body":"Measured critical threshold","active":true,"context":"unknown"}' --json
```

This returns `{item,changed}`. `(sourceKind,sourceKey)` is a persistent unique
identity. Replaying an unchanged revision does not emit another change event
or reopen a dismissal, including after restart. Changes to body alone with
the same revision are deliberately ignored. Send a new meaningful revision
for a changed condition/new incident, never a polling timestamp. `active:false`
resolves only this source's item, not its linked task. Reusing the same revision
after recovery does not reopen it. Native source kinds `manual`,
`native_interaction`, `native_failure`, `task_review`, and `task_route` are reserved.
Original source URLs must be HTTP(S); all source text is untrusted context.

## Advisory routing and local-action away

Open **Routing & local away** on an incoming Inbox card. Exact native task
keys/IDs and thread references resolve without a classifier. Conflicting scope
asks one question; an explicit reference answers it. The proposal explains its
reason, current owner, target and unavailable selections. Open the existing task
and every retained worker directly. Managed workflows keep their writer even
when the latest reply is a reviewer; prepared workspaces/continuations retain
their native owner. Routing never sends, starts, prepares or replaces a worker.

An exact attached ordinary-thread answer resolves an idle ownership choice;
managed writers and retired continuation history retain their native policy.
A changed latest responder or retired selected executor parks apply instead of
silently substituting another owner.

Semantic advice requires an explicit request and a registered service selected
for Core's `task-route` AI task. This setting defaults off; automatic mode does
not invoke a service. Core admits at most one completion callback with an
eight-second timeout and no router retry or alternate service/account. That is
not a physical model-request limit: the selected service owns downstream calls
and retries. Semantic advice is unavailable under a local-away grant.

```sh
bb tasks route show <inbox-id> --json
bb tasks route preview <inbox-id> --operation preview-1 --revision 0 --source-revision <source-revision> --project PROD --task PROD-1 --json
bb tasks route apply <inbox-id> --operation link-1 --revision 1 --action '{"kind":"link"}' --json
```

Read the source revision from `inbox list` and the current proposal revision
from `route show`. Preview takes `--new-task` with a selected project and no
`--task` answer to treat incoming references as context for separate work.
An already linked intake owner or explicit exact-reference answer retains
precedence. A new task is not a new thread and starts no executor.
Incidental references are not resolved as ownership choices for this separate
task: historical/unavailable thread mentions and excessive contextual reference
lists do not block manual or explicitly granted local-away previews. Stored
intake links and explicit answers still use their normal ownership validation.
Use `--semantic` to request semantic advice. Apply accepts strict JSON for `link`,
`create`, `target` (with `target`, nullable to clear), or `workflow-draft` (with
`draftRevision` and `selection`). Target/draft saves reuse native execution and
workflow schemas, require an idle task without a retained workflow/preparation/
repository owner, and validate the real code
project, host, context membership, model account and provider compatibility.
Saving metadata never prepares a workspace or starts a workflow. Changed
source, task, profile, draft or ownership makes advice stale. Refresh and preview
again instead of replaying stale decisions.
The newly selected target profile is also fenced through the save transaction:
changes to its model, payer or other profile fields require fresh validation,
even when the task's previously saved profile did not change.

After a definitive parked preview, another Preview click starts a fresh attempt,
including after closing/reopening the drawer. Uncertain delivery retains both
the operation identity and the entire original request for receipt lookup,
even if refresh advances the proposal revision or the source/form choices change.
The drawer uses fresh choices only after receiving a terminal result and another
explicit Preview. CLI/SDK clients likewise retain the original source/proposal
revisions and all other inputs while resolving uncertain delivery; use a fresh
operation ID for a deliberate retry after a known terminal preview result.

```sh
bb tasks away enable --operation grant-1 --project PROD --inboxes <inbox-id> --tasks PROD-1 --actions preview,link --attempts 3 --seconds 300 --acknowledge-local-only --json
bb tasks route apply <inbox-id> --operation away-link-1 --revision 1 --grant <grant-id> --action '{"kind":"link"}' --json
bb tasks away revoke <grant-id> --json
```

Away is an explicit local-action allowlist, not an automatic runner. Select up
to 20 incoming entries and 20 existing tasks in one tracker project, 1–100
action attempts and 1–3600 seconds. Omitting `--tasks` admits no existing task;
allowed actions are `preview,link,create,target,workflow-draft`. Every admitted
attempt, including stale/failed attempts, consumes budget before the action.
Revocation and absolute expiry fence pending effects; restart never renews a
grant or replays uncertain delivery. Reuse an operation ID only with exactly
the same input to retrieve its receipt. `route show` exposes scope, expiry,
used/max attempts, stale state and the latest 50 journal entries.

Native execution, external/Jira actions, production, irreversible operations,
governance, Accept and unknown action shapes park in **Needs input**. Inspect
the attention card's original source; it is not new intake and cannot create
another task. Resolving its reminder never approves or executes the request.
Incoming text, Work/Personal labels and classifier output grant no authority.
Local-away grants govern these routing actions only; they do not sandbox
existing native sessions, full-access tools or full-trust plugins.

The UI and CLI share the authenticated Tasks RPCs `getInboxRoute`,
`previewInboxRoute`, `applyInboxRoute`, `enableLocalAway`, and `revokeLocalAway`.
SDK consumers call `bb.sdk.plugins.callRpc({pluginId:"tasks",method,input})`
with native tracker/task IDs, explicit nullable `grantId`, source/proposal
revisions, and the same typed inputs in `shared/routing.ts`. The local
`createTaskRoutingClient` supplies output schemas for these calls. Core semantic
advice uses `bb.sdk.system.experimental_classifyTaskRoute({text,candidates,projects})`;
it cannot choose an arbitrary thread or worker account.

## Changelog

### 0.4.0

- Bind multiple explicit code projects/roots to one task, prepare asynchronously,
  inspect per-root failures and resume preparation without replaying uncertain
  native operations. Continue with one coherent writer only after all required
  roots verify on the same host and execution profile.
- Preserve published Git/LFS prerequisites with target-native authentication,
  bounded unpublished/dirty overlays, selected portable files, confined tracked
  instruction symlinks and durable transfer receipts. No auth-home migration.
- Add native build → independent review with a retained writer, actual platform
  smoke evidence, authoritative commit checks, exact-revision human Accept and
  same-session Return. Project deletion preflights all retained groups atomically.
- Project workflow worker activity, writer result packages and failed/blocked
  workflow attention through the existing Working/Inbox views. Render Inbox
  context with BB's shared Markdown component and actionable links.
- Require fresh readiness on the actual selected provider/environment; a
  registered or cold provider is not silently treated as ready.

### 0.3.0

- Add persistent unified Inbox and Working, native question/review projection,
  manual intake, single-task conversion/linking, snooze/time return, history,
  and equivalent validated RPC/CLI surfaces.
- Add deduplicated external source revision ingestion and recovery, with
  dismissal surviving restart. Append inbox schema migration without rewriting
  existing task, attachment, Jira, or execution data.

## Multi-repository and reviewed execution

The task header has one primary **Launch workflow** action. The task card also
includes **Repository workspace**; ordinary single-agent dispatch remains
available under **Agent actions**.

The shipped Tasks skill documents the complete validated input and CLI/RPC
surface: `repositories inspect|prepare|show|continue`, workflow draft/settings
commands, and `workflow prepare|preparation|start|list|accept|return`. These are
explicit operations; moving a board card does not start either flow.

Workflow launch uses the shared persistent overlay: a centered panel on desktop
and a bottom drawer on compact screens. Opening starts the shell before its
deferred body is realized; closing retains that body for reopening. Close,
Escape and backdrop dismissal return focus to the launcher without making the
app root inert or hidden. A retained closed overlay does not consume Tasks
shortcuts. Detail refreshes keep the same workflow launcher and open panel.
Machine, code project, profile, context and model-account choices are named and
searchable; the selected actual model/version remains explicit. Context never
selects the payer. Routine execution summaries show names; internal IDs are in
collapsed copyable diagnostics. Core definition/account changes and reconnects
refresh open selectors without resetting unsaved drafts or silently replacing
an unavailable selection. Existing worker bindings remain frozen.

Repository bindings name each code project, source environment/owner/HEAD,
target path, isolated branch, role, instructions and permitted profile. The
first required root is primary. Preparation creates no executor; partial
readiness blocks continuation. All roots use one selected host/profile and
one native thread, not independent per-repository agents.

Build/review prepares an isolated single-root workspace in the tracker's linked
code project through Core, without a donor origin thread, session import or
initialization model turn. It intentionally refuses a task already bound to
the multi-repository execution path. Native Workflows must be enabled. Choose
the machine, context, model account and version for each role, and configure
the actual platform smoke commands before preparation. Explicit Start is separate.

Writer and reviewer may use the same provider, model and account. Independence
is a fresh separate reviewer conversation with review-only instructions and
inspection of the actual committed change, not mandatory model diversity.
`development-review` runs Plan, Build/platform smoke, Independent review;
`bugfix` requires genuine failing-before reproduction, fix/regression and
passing-after evidence before review. A published package is never acceptance.

Role selections retain independent `executionContextId` and `modelConnectionId`
snapshots. Legacy requests that omit overrides remain implicit; replay does
not add bindings from current project settings. Core admits workers against
their selected bindings. Once created, each worker's resolved context and
connection remain frozen across plan/build and Return, despite later
preset/default/definition edits; revocation still blocks its next native admission.

Start compares the expected task draft revision and selections in the same
SQLite transaction that reserves its first launch receipt. A successful draft
save during preparation/readiness rejects that Start, even if the choices were
subsequently restored. Retrying an already accepted identical receipt remains
idempotent and does not create another workspace or run.

Return preserves the established writer/session and workspace. An uncertain
send is not blindly resent or replaced. Before the first writer is established,
a definitive launch rejection permits repairing the originally selected
profiles through an explicitly saved task draft and retrying with feedback.
Legacy workflows without that draft retain their persisted launch/role choices,
not current project/template settings. A failed reproduction without genuine
nonzero evidence can retry on Return; once the reproduction gate advances to
Fix, the original failing-before evidence is retained across all Returns and
later unrelated replacement attempts are rejected. Generic Done cannot bypass
pending workflow acceptance. Human Accept requires the exact latest revision
and an unchanged clean reviewed commit.

### Explicit video evidence policy

The evidence input contract is versioned independently of execution profiles.
For newly classified UI/interactive work, `workflow draft set TASK --task-kind ui`
selects `{version:1,requirement:"video"}`. `--task-kind backend` selects technical
smoke. `--evidence-policy technical|ui|video` is an explicit override (`ui` permits
screenshot/preview). The dialog and SDK draft use the same `evidencePolicy`.
Existing saved drafts/results and legacy `uiRequired` / `--ui` keep their old
meaning; classification is never inferred from prose, files, model or account.
Project/template saves and application are explicit. Return cannot lower policy.

First-class video evidence refers to an existing task/comment attachment, not
an arbitrary URL or temporary path. It carries the exact commit, source run,
scenario, original attachment and nullable editing disclosure. MP4 / H.264 and
WebM reuse Tasks storage and its 25 MiB limit. Ownership, availability, container
structure and reviewed-commit metadata are checked before review/publication/Accept.
Published recording claims are retained separately from the current result through
Return; a reused attachment cannot change its recorded commit/run or original/editing
binding. Upgrade backfill covers only currently retained published results, not
metadata already discarded by earlier Returns. These are consistency checks on
claims, not authenticated capture provenance, decoder support or real-scenario
proof. Actual playback and independent inspection remain required.

The task attachment and result controls use one responsive in-task HTML video
player, native controls, no autoplay, separate download, and explicit
loading/error/unsupported states. Closing releases playback and restores the
trigger without navigating the task. Delivery uses the existing authenticated
attachment path with bounded streaming, HEAD and single-byte Range support.
Unknown or unbounded initial duration is displayed as unknown, not treated as
corruption or playback readiness. Metadata/duration changes can supply a real
finite duration later; can-play/playing and actual media errors still govern
readiness and playback failure.
Core's shared acknowledged analytics outbox records local video outcomes without
video content, filenames, URLs, task/attachment IDs or raw errors.

Safe recording unavailability blocks a video-required result; screenshot/preview
is not a fallback. Technical smoke, independent review, human Accept and
merge/deploy remain separate. These source contracts are not a claim of observed
desktop/mobile/native-workflow or analytics acceptance on a deployed candidate.


## Lists, boards, and parent tasks

List and Board show all tasks in the selected tracker project, including
subtasks, grouped by each task's own status. A child in **In Review** remains
visible when its parent is **In Progress**. Each child has a clickable parent
key/title badge, even when the parent is outside the current filtered results.

**Parent/Epic: All** is the default. Select a top-level task to show only its
direct children; choose **All** to remove just the parent restriction or
**Clear** to clear every filter. Parent combines with status, priority, and
label filters. A parent with no children yields an empty result; a deleted
selected parent is shown as unavailable until the filter is cleared.

Project and sidebar **All tasks** totals include children, as do active-agent
indicators and the previous/next task pager. The visible task count respects
filters and can differ from the project total. Epic cards retain progress
across all their direct children, independently of the visible filters.

List and Board remain selectable on compact screens instead of silently
substituting List for Board. Board cards open with keyboard activation; change
status in the task editor when not using drag. Touch dragging uses the card's
grip so gestures elsewhere can scroll the board and its columns. Parent badges
have independent navigation and do not start a card drag. Filter chips scroll
separately from the visible result count and task navigation controls.

## Retained decision and annotation contract

Tasks owns retained decision metadata in `task_artifacts` and keeps screenshot
bytes in its existing attachment storage. The source reference is the real
`threadId` plus canonical message `eventSeq` (`experimental_messageSeq` in the
rendered message action), not the provider fork/acceptance anchor. Source text
is retained only as an explicitly confirmed quote of up to 4000 characters.
Quote verification uses the actual source message's role with the renderer's
shared GFM/math configuration and Markdown-to-render-tree semantics, so emphasis,
links, inline code and decoded entities do not require a raw Markdown substring
match. User-authored HTML remains literal display text; assistant-authored HTML
uses the existing sanitized rendering semantics. Visible line breaks and block
boundaries stay separated rather than becoming fabricated joined phrases. The
same shared text semantics feed ordinary-action prefill, identity-only restored
panels and server quote verification. The saved quote remains display text,
alongside a hash of the original raw message rather than a full prompt dump.

The typed `taskArtifactRpcContract` in `shared/artifacts.ts` defines
`taskArtifactTargets`, `inspectTaskArtifactImage`, `createTaskArtifact`,
`listTaskArtifacts`, `getTaskArtifact`, and `deleteTaskArtifact`. Existing SDK
plugin RPC calls and `bb tasks artifact list|show|image|create|remove` share the
same handlers. The Tasks skill documents their exact fields and retrieval
sequence. `bb_task_artifact_read({artifactId})` uses the existing native tool
image result contract to return actual screenshot bytes with the saved text
and original-image pixel coordinates. It derives scope from the invoking
thread's execution-context binding, independently of its model account.
Authenticated operator RPC/CLI context selection is organizational scoping,
not a new per-user security boundary. Artifact reads do not spawn, resume,
fork, dispatch, or accept work; the existing task execution owner is unchanged.

Retention pins the original BB code project and logical context. Moving the
task or relinking its tracker project does not rewrite that provenance or grant
the destination context access. List/read/remove use the original project
membership; new retention still requires the task's current linked project.
The Artifact context picker can recover permitted original history even when
the current task project is unlinked. The legacy attachment list/download CLI
also checks retained-image provenance before disclosing metadata or writing
bytes; the compatible original thread and authenticated operator remain usable.
Revoked original context/project permission denies retained image downloads.

The source UI entry is **Save decision to task** on a source message or
selected passage. It uses readable task/image pickers and a bounded rectangle
selection over an uploaded/existing screenshot, with equivalent keyboard pixel
fields. No canvas/editor engine or capture mechanism is added. Live element
picking remains in the native desktop Agent Annotations plugin; uploading a
task screenshot does not require that desktop-only capability or enabling a
different plugin. PNG/JPEG/WebP/GIF inspection fully decodes pixels with strict
warning rejection, bounded to 32768 pixels per dimension, 64 megapixels, the
existing 25 MB attachment limit and a ten-second decode timeout. Animated images
and non-identity EXIF orientations are explicitly refused: export a static,
orientation-applied screenshot before selecting coordinates. Originals are not
rewritten. Inspection, creation and native image reads share that decoder; old
header-only records cannot bypass it even when the retained hash matches.
Other image types may remain ordinary task attachments, but are not accepted
as coordinate-bound screenshots by this contract.

The decoder is Sharp `0.34.5` (Apache-2.0), declared as a Tasks, server and
packaged `bb-app` runtime dependency rather than relying on the app's development
dependency. Plugin/server bundling leaves the native module external, and the
plugin runtime resolves it from the host runtime alongside SQLite. Production
packaging must retain Sharp's platform-specific optional `@img` dependencies;
source work alone does not prove a packaged native load.

The exact external reuse pin reviewed is
[`rebryk/bb-plugins@1f123e5ecf7e6ac42f865f8d230de8ed2ce44049`](https://github.com/rebryk/bb-plugins/tree/1f123e5ecf7e6ac42f865f8d230de8ed2ce44049).
Its recursive tree has no repository license; the Canvas 0.1.13 and Bookmarks
0.1.1 package manifests declare none. The DejaVu font license in Canvas does
not license plugin source. Permission remains unestablished: no external
Canvas/Bookmarks/Annotate source is copied, installed, or distributed by this
change. The native BB source is covered by this repository's MIT license.
Source-only work does not authorize production activation or upgrades.

Source regressions and an isolated synthetic-image/SQLite reopen scenario do
not establish deployed acceptance. Compiled ordinary-web/narrow-viewport UI,
real server restart, screenshot-to-agent-to-revised-UI proof, coordinated
analytics consumption and independent review remain integration gates. Keep
release/changelog acceptance claims gated on those observed results.

## CLI reference

Run `bb tasks --help` or `bb tasks <command> --help` for exact options; help
works at every level, lists each option's accepted values and limits, and exits 0. Unknown commands and options are rejected with the nearest real name, every
missing required value is reported in one error, and a failing invocation that
carries `--json` prints `{ "ok": false, "error": { "code", "message", "hint"? } }`
on stdout while stderr keeps the readable text. Add `--json` to commands when
another command or agent will consume the output.

`--project` takes a tracker project prefix or id such as `PROD`, never a bb
project id (`proj_...`); `bb tasks project list` shows both columns. Repeatable
options (`--label`, `--status`, `--priority`, `--add-label`, `--remove-label`)
also accept one comma-separated list. File paths (`--file`, `--attach`,
`--out`, `--description-file`, `--body-file`) resolve on the invoking machine:
inside an agent thread that is the thread's machine, otherwise the server's
machine; pass `--machine <id-or-name>` to target another enrolled machine.

| Command                                             | Purpose                                                                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `bb tasks status`                                   | Show the installed Tasks plugin name and version. Task workflow status lives on `bb tasks list --status` and `bb tasks update --status`.   |
| `bb tasks project create\|list\|show\|update`       | Manage tracker projects, folders, colors, prefixes, and bb-project links.                                                                  |
| `bb tasks folder create\|list\|update\|delete`      | Organize tracker projects into nested folders. Deleting a folder moves its projects and subfolders to the top level; no tasks are deleted. |
| `bb tasks create`                                   | Create a task with description, priority, labels, due date, optional parent, and file attachments (repeatable `--attach <path>`).          |
| `bb tasks list`                                     | Page/filter tasks by project, parent (`--parent <key-or-id>`), status, priority, label, active agents, or search; supports `--sort`, `--limit`, and `--cursor`. |
| `bb tasks show <key-or-id>`                         | Show the complete task record, including comments, attachments, subtasks, and attached threads.                                            |
| `bb tasks update <key-or-id>`                       | Update status, priority, title, description, due date, or labels.                                                                          |
| `bb tasks move <key-or-id>`                         | Move a task and its sub-tasks to `--project`. Moved tasks get new keys; old keys keep resolving, and labels are matched by name.           |
| `bb tasks comment <key-or-id>`                      | Add a Markdown comment from inline text or a file; optionally notify the latest responding task agent.                                     |
| `bb tasks attachment add\|get\|list\|remove`        | Add, fetch, list, or remove attachments. Referenced attachments require `remove --remove-references`.                                      |
| `bb tasks preset list\|create\|update\|delete`      | Manage reusable agent execution presets.                                                                                                   |
| `bb tasks delegate <key>`                           | Start and attach a new agent thread using a preset.                                                                                        |
| `bb tasks execution get\|set\|clear <key>`          | Inspect, persist, or clear task execution routing independently of tracker defaults.                                                       |
| `bb tasks execution environments --bb-project <id>` | List existing environments, optionally filtered by `--machine`.                                                                            |
| `bb tasks continue preview\|start\|list <key>`      | Preview, start, or inspect durable idle-workspace continuations into new native sessions.                                                  |
| `bb tasks attach <key-or-id>`                       | Attach the current bb thread to a task when it was not delegated from Tasks.                                                               |
| `bb tasks detach <key-or-id>`                       | Detach the current bb thread (or `--thread <id>`) from a task, for example a dead predecessor after a respawn.                             |
| `bb tasks threads <key>`                            | List the bb threads attached to a task: live threads first, newest first.                                                                  |
| `bb tasks label create\|list\|delete`               | Manage project-scoped labels.                                                                                                              |
| `bb tasks seed-demo --yes`                          | Create sample folders, projects, labels, tasks, and comments for evaluation.                                                               |
| `bb tasks jira connections\|show\|import`           | Discover configured connections, read stored source context, or import/link one selected Jira issue into native Tasks.                     |
| `bb tasks jira search\|links`                       | Page read-only Jira discovery via JQL, or resolve native links by immutable Jira issue IDs.                                                |
| `bb tasks jira pull\|draft\|clear\|transitions`     | Explicitly refresh source, prepare/discard one proposal, or list Jira transition/status pairs.                                             |
| `bb tasks jira preview\|push\|reconcile`            | Review three-way changes, explicitly push a reviewed preview ID, or reconcile an uncertain write by operation ID.                          |

Statuses are `backlog`, `todo`, `in_progress`, `in_review`, `done`, and
`canceled`. Priorities are `urgent`, `high`, `medium`, `low`, and `none`.

Task lists default to 100 rows and accept `--limit 1-500`. JSON output is
`{ tasks, nextCursor, limit }`; human output prints the continuation option
when another page exists. The cursor is opaque and tied to the filters, sort,
and current task-list revision. If tasks are added, removed, reordered, or
updated between requests—or label links/names, active task threads, or project
prefixes change—the old cursor is rejected. Restart from the first page rather
than traversing an inconsistent snapshot.

### Parent filtering

Without `--parent`, `bb tasks list` includes roots and children. Use
`--parent <key-or-id>` for only that task's direct children, not the parent
itself or an additional tree view. Keys and IDs resolve case-insensitively.

```sh
bb tasks list --project PROD --parent PROD-1 --json
bb tasks list --project PROD --parent PROD-1 --status in_review --priority high --label Release --search "release notes" --limit 25 --json
```

All filters intersect. The parent must belong to the explicit `--project` or
the tracker project inferred from the current bb project; a mismatch fails
with `subtask_project_mismatch`. When neither supplies a project, the parent
scopes label-name lookup to its own project. Pagination uses `nextCursor` with
the same resolved parent and other filters; omit `--parent` to list all tasks
again.

SDK callers use the existing Tasks `listTasks` RPC through
`bb.sdk.plugins.callRpc({ pluginId: "tasks", method: "listTasks", input })`.
In `input`, omit `parentTaskId` for all tasks, pass `null` for roots only, or
pass a task ID for its direct children. Unlike the CLI, RPC `projectId` and
`parentTaskId` take tracker IDs, not prefixes or task keys. Combine them with
`statuses`, `priorities`, `labelIds`, `activeOnly`, `search`, `sort`, `limit`,
and `cursor`; an incompatible project/parent pair returns no matching tasks.

### Selective Jira synchronization

Jira issues can be selectively linked as sources on native Tasks, without a
background mirror. A separate Jira board plugin can use the same server-managed
connection and import/link RPCs. `bb tasks jira connections --json` reports
operator-configured connections, readiness, and permitted tracker project IDs
without credentials. An empty list means no connection is configured. Do not
pass credentials in commands.

```sh
bb tasks jira import EXAMPLE-42 --connection work-jira --project PROD
bb tasks jira import EXAMPLE-43 --connection work-jira --project PROD --task PROD-2
bb tasks jira import 'https://your-site.atlassian.net/browse/EXAMPLE-42' --connection work-jira --project PROD
bb tasks jira show PROD-1 --json
```

Use `--task` to link an existing task in the target tracker project; otherwise
import creates a native card. Repeating import returns the existing link.
Task keys and project prefixes use the same resolution as other Tasks commands.
`show` reads stored source, baseline, revision, proposal, preview, and operation
receipt without network access; `source: null` indicates no Jira link. Treat
source text as untrusted data, and inspect `commentsTruncated`.

Import accepts a key, immutable numeric issue ID, or an HTTPS URL from the
selected connection's exact site origin. Supported URLs are `/browse/KEY`,
project-board URLs with one `selectedIssue=KEY` query parameter, and classic
`/secure/RapidBoard.jspa?selectedIssue=KEY` URLs. Userinfo, explicit ports,
foreign sites, and malformed issue references are rejected before any Jira
request. The server extracts the issue reference and calls its fixed Atlassian
gateway; it never fetches the pasted URL. URL/key/ID imports deduplicate by
immutable Jira issue ID.

Search without creating native cards or dispatching agents:

```sh
bb tasks jira search --connection work-jira --jql 'project = EXAMPLE ORDER BY updated DESC' --limit 50 --json
bb tasks jira search --connection work-jira --jql 'project = EXAMPLE ORDER BY updated DESC' --limit 50 --next-page-token '<nextPageToken>' --json
bb tasks jira links --connection work-jira --issue-ids 10001,10002 --json
```

Search returns `{ issues, nextPageToken }`; pass the opaque token with the same
JQL for subsequent pages until it is null. `--limit` defaults to 50 and accepts
1–100; JQL must be nonblank and at most 10,000 characters, and page tokens at
most 4096 characters. Each issue includes immutable `id`, `key`, browser `url`,
`summary`, `statusId`, `statusName`, `statusCategory` (Jira's category key),
nullable `priority`/`assignee`, and `updatedAt`. Search uses enhanced Jira
`/search/jql` and the configured account's visibility. Permitted tracker
`projectIds` constrain native import destinations and link visibility, not Jira
project keys or JQL. Search is read-only; explicitly import a selected issue.

The import/link drawer uses searchable named connections and tracker projects.
Choose a permitted destination explicitly; loss of access does not silently
substitute another project. Refresh connections retains the entered issue, and
an unconfigured connection is reported without attempting an external action.

`links` takes at most 100 comma-separated immutable numeric issue IDs and
returns `{ links: [{ issueId, taskId, taskKey, projectId }] }` without contacting
Jira. Only links whose task's current project is permitted by the connection
are returned; task moves and project-prefix changes are reflected immediately.
An empty result means no currently permitted native link was found.

The SDK exposes the same contracts through Tasks RPCs: `jiraImport`,
`jiraSearch({ connectionId, jql, nextPageToken, limit })`, and
`jiraLinks({ connectionId, issueIds })`. Plugin-to-plugin callers use
`bb.sdk.plugins.callRpc({ pluginId: "tasks", method, input, outputSchema })`;
the shared `jiraRpcContract` defines the input and output schemas. Credentials
remain server-side, and Jira requests do not follow redirects.

`pull`, `draft`, `clear`, and `preview` require `--expected-revision` from the
latest `source.revision`. Stale values are rejected rather than overwriting a
newer edit. Pull preserves a draft's original baseline for conflict detection.

```sh
bb tasks jira pull PROD-1 --expected-revision <revision>
bb tasks jira draft PROD-1 --expected-revision <revision> --summary "New Jira summary"
bb tasks jira transitions PROD-1
bb tasks jira preview PROD-1 --expected-revision <revision> --json
```

Draft exactly one operation: `--summary` and/or `--description`, OR `--comment`,
OR `--transition <id> --to-status <id>` using a pair from `transitions`.
Description is an explicit whole-field plain-text replacement; omit the flag
to preserve Jira rich text, or pass an empty string to clear it.
`bb tasks jira clear PROD-1 --expected-revision <revision>` discards the draft.
Native task edits never implicitly become Jira proposals.

Transitions expose required field metadata, allowed values, and supported
operations. `show` exposes captured values in `transitionFields`. Pull before
drafting so required-field baselines are captured; a missing baseline is not a
Jira null and blocks overwrites. Clear an existing draft, pull, and review again
if the baseline was not captured. Supply required values with
`--transition-fields <json>` (only with `--transition` and `--to-status`); omitted
JSON defaults to `{}` and only works when no fields are required. For example,
with synthetic IDs returned by `transitions`:

```sh
bb tasks jira transitions PROD-1 --json
bb tasks jira pull PROD-1 --expected-revision <revision>
bb tasks jira draft PROD-1 --expected-revision <revision> --transition finish --to-status done --transition-fields '{"summary":"Reviewed synthetic work","resolution":{"id":"fixed"}}'
bb tasks jira preview PROD-1 --expected-revision <revision> --json
```

Use your workflow's actual IDs and allowed values, not these example IDs.
Only the selected transition's required fields are accepted. Fields without a
`set` operation or a supported option format must be completed in Jira; an
`unsupportedReason` blocks only the affected transition, not import or pull.
Push sends status
and supplied fields atomically in one transition request, detects conflicts
per field, and verifies every supplied field plus the target status by readback.

Review the preview's `changes`, `canPush`, and `reason`, then explicitly run
`bb tasks jira push PROD-1 --preview-id <reviewed-preview-id>` only with approval
for that external write and a credential with sufficient Jira permissions.
Stale previews are rejected and must be regenerated and reviewed. Push never
changes native task status or marks it Done. Local planning fields, workspace,
comments, and threads remain independent.

Always inspect `operation.state` and `message`: a returned receipt is not
necessarily an applied write. Repeating an applied preview returns the prior
receipt. An uncertain result must not be blindly retried; use
`bb tasks jira reconcile PROD-1 --operation-id <operation-id>` for readback
without replay. Unknown outcomes remain visible and may remain uncertain.
All commands support `--json`; human output presents the same state as indented
JSON. `bb tasks jira --help` lists the complete command group.

## Task execution routing and native continuation

```sh
bb tasks execution set PROD-1 --bb-project proj_code --machine laptop \
  --workspace managed-worktree --base-branch main --preset "Codex high"
bb tasks execution get PROD-1 --json
bb tasks delegate PROD-1
bb tasks execution environments --bb-project proj_code --machine laptop --json
bb tasks execution clear PROD-1
bb tasks continue preview PROD-1 --thread thr_source --machine workstation --json
bb tasks continue start PROD-1 --thread thr_source --machine workstation \
  --target-path /work/new-task --preset "Codex high" \
  --include-path notes.txt --include-path assets/sample.bin \
  --instructions "Finish the acceptance criteria" --branch task-continuation --json
bb tasks continue list PROD-1 --json
```

`execution set` requires `--bb-project`, `--machine`, `--workspace`, and `--preset`.
Workspace choices are `managed-worktree` (optional `--base-branch`),
`project-checkout`, and `existing-environment` (required `--environment <id>`).
The code-project id is not a Tasks tracker prefix. Machine and preset arguments
accept names or ids. `execution get` accepts optional `--preset` to resolve an
invocation profile. A persisted task override wins over inheritance; an explicit
dispatch `--preset` selects the invocation profile. `delegate` is an alias of
`dispatch`; both work without `--preset` when a saved target supplies it.
Clearing removes the task override and restores tracker-project/profile routing.
`dispatch` and `delegate` also accept `--execution-target '<json>'` for an
invocation-only target with `bbProjectId`, `hostId`, `workspace`, and `presetId`
using exact ids, validated by the same shared RPC schema; this does not persist it.

Continuation is not a live session move. Preview reports the source environment,
host, HEAD, branch, active threads, and files with default selections and exclusion
reasons. Only an idle source can transfer; the source thread remains attached.
All tracked changes transfer according to core safety policy; repeat
`--include-path` for explicitly selected relative untracked/ignored files, or to
consent to an exact tracked file whose preview kind is `sensitive-tracked`.
Ignored directories remain collapsed in preview so dependency trees are not
enumerated. To copy a file inside one, enter its exact relative path in the
dialog's **Additional exact file paths** field or repeat
`--include-path local-config/settings.json`. Only the named ordinary file is
captured; directory selection, symlinks and traversal remain forbidden.
Sensitive tracked files block continuation until each is explicitly selected or
resolved at the source; they are never silently dropped. Review warnings before
selecting secrets or `.env` files; none are selected implicitly. The target path must be new and
is never overwritten. A successful transfer starts a new native session with task
and stored Jira context plus verified code handoff; it does not complete the task
or write to external Jira. The retained source is labeled as the previous executor;
continue further work from the new attached executor, not from that source again.

`continue list` exposes durable `ready`, `spawning`, and `started` records.
If spawning fails after transfer, a `ready` record and `lastError` remain.
Retry `continue start` with the same task/source/target/profile arguments and
`--operation <operationId>` to reuse that prepared environment without overwriting
or retransferring it. The original selected files and branch are retained; omit
`--include-path` and `--branch` on this explicit operation retry. A `spawning`
record means the outcome needs reconciliation; retry queries the operation's
thread metadata before creating another session.

The validated delegation RPCs are `getTaskExecution`, `setTaskExecution`
(`target: null` clears), `listTaskExecutionEnvironments`,
`previewTaskContinuation`, `continueTask`, and `getTaskContinuations`, alongside
`delegate` (optional `presetId` and optional invocation `executionTarget`).
Continuation uses the shared core `projects.previewWorkspaceTransfer`,
`projects.transferWorkspace`, and `projects.getWorkspaceTransfer` APIs;
machine preparation uses `projects.prepareMachine`. These are not alternate
Tasks-specific filesystem operations.

The target native spawn supplies `transferOperationId` so core atomically checks
the ready transfer and source idleness during target creation. Source and target
dispatch are mutually gated while the counterpart is running; this is not a
permanent source-session freeze.

## Agents, delegation, and presets

Linking a Tasks project to a bb project enables delegation. Open a task, choose
**Delegate**, select a preset, and optionally add instructions. A preset
defines the provider, model, reasoning level, optional service tier, permission
mode, and reusable instructions. Presets are user-defined, so create the worker profiles your team
uses repeatedly before dispatching work.

With the **Project default** environment, delegation uses the linked bb
project's default local-path source: both its machine and its directory.
It does not route through the server's primary machine or pick the first
source. Set the default with
`bb project source update <project-id> <source-id> --default`.
Without a default source, dispatch fails before starting a thread or changing
the task's status.

For isolated work, choose **New worktree** and configure its machine and base
branch, or use `bb tasks preset create --environment worktree --machine
<machine-id> --base-branch <branch>` with the other required preset options.
This creates a separate worktree; Project default uses the existing checkout.

Delegation creates a worker thread in the linked bb project, attaches that
thread to the task, and advances a `backlog` or `todo` task to `in_progress`.
The worker receives the task description, subtasks, attachments, recent
comments, preset instructions, and a report-back contract. Its installed Tasks
skill tells it to inspect the task, leave substantive milestone comments,
attach artifacts, and move completed work to `in_review`.

If work begins outside the Delegate action, the agent can associate its current
thread with `bb tasks attach KEY`. The inverse is `bb tasks detach KEY
[--thread <id>]`, and each thread card on the task page has a detach control;
use either to drop a thread that died or moved on to other work. The task
page and `bb tasks threads` list live threads before completed or failed ones,
newest first.

## Task mentions

Type `@` in the bb composer and select **Tasks** to search by task key or title.
Sending the mention gives the agent the task's description, status, priority,
labels, subtasks, attachments, recent comments, attached threads, and CLI
action contract as context. Tasks linked to the current bb project rank first.

Inside a task description or comment, `@` also inserts a task pill. These
references are stored in Markdown as `[PROD-1](bbtask://PROD-1)`, so they remain
portable in task content.

Mentioning a task key such as `PROD-1` in an agent request also activates the
Tasks skill, which directs the worker to read and update the tracked task.

## Known limitations

- The **Auto** delegation preset is deferred; choose an explicit preset.
- List filters are local UI state and are not persisted in the URL.

## Fast follow

- Batch task-list enrichment for comments and attached-thread state.
- Add push notifications for task activity.
- Add a command palette entry for Tasks to cmd-K.
