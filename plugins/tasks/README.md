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

| Command                                         | Purpose                                                                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `bb tasks status`                               | Show the installed Tasks plugin name and version. Task workflow status lives on `bb tasks list --status` and `bb tasks update --status`.   |
| `bb tasks project create\|list\|show\|update`   | Manage tracker projects, folders, colors, prefixes, and bb-project links.                                                                  |
| `bb tasks folder create\|list\|update\|delete`  | Organize tracker projects into nested folders. Deleting a folder moves its projects and subfolders to the top level; no tasks are deleted. |
| `bb tasks create`                               | Create a task with description, priority, labels, due date, optional parent, and file attachments (repeatable `--attach <path>`).          |
| `bb tasks list`                                 | Page/filter tasks by project, status, priority, label, active agents, or search text; supports `--sort`, `--limit`, and `--cursor`.        |
| `bb tasks show <key-or-id>`                     | Show the complete task record, including comments, attachments, subtasks, and attached threads.                                            |
| `bb tasks update <key-or-id>`                   | Update status, priority, title, description, due date, or labels.                                                                          |
| `bb tasks move <key-or-id>`                     | Move a task and its sub-tasks to `--project`. Moved tasks get new keys; old keys keep resolving, and labels are matched by name.           |
| `bb tasks comment <key-or-id>`                  | Add a Markdown comment from inline text or a file; optionally notify the latest responding task agent.                                     |
| `bb tasks attachment add\|get\|list\|remove`    | Add, fetch, list, or remove attachments. Referenced attachments require `remove --remove-references`.                                      |
| `bb tasks preset list\|create\|update\|delete`  | Manage reusable agent execution presets.                                                                                                   |
| `bb tasks delegate <key>`                       | Start and attach a new agent thread using a preset.                                                                                        |
| `bb tasks attach <key-or-id>`                   | Attach the current bb thread to a task when it was not delegated from Tasks.                                                               |
| `bb tasks detach <key-or-id>`                   | Detach the current bb thread (or `--thread <id>`) from a task, for example a dead predecessor after a respawn.                             |
| `bb tasks threads <key>`                        | List the bb threads attached to a task: live threads first, newest first.                                                                  |
| `bb tasks label create\|list\|delete`           | Manage project-scoped labels.                                                                                                              |
| `bb tasks seed-demo --yes`                      | Create sample folders, projects, labels, tasks, and comments for evaluation.                                                               |
| `bb tasks jira connections\|show\|import`       | Discover configured connections, read stored source context, or import/link one selected Jira issue into native Tasks.                     |
| `bb tasks jira pull\|draft\|clear\|transitions` | Explicitly refresh source, prepare/discard one proposal, or list Jira transition/status pairs.                                             |
| `bb tasks jira preview\|push\|reconcile`        | Review three-way changes, explicitly push a reviewed preview ID, or reconcile an uncertain write by operation ID.                          |

Statuses are `backlog`, `todo`, `in_progress`, `in_review`, `done`, and
`canceled`. Priorities are `urgent`, `high`, `medium`, `low`, and `none`.

Task lists default to 100 rows and accept `--limit 1-500`. JSON output is
`{ tasks, nextCursor, limit }`; human output prints the continuation option
when another page exists. The cursor is opaque and tied to the filters, sort,
and current task-list revision. If tasks are added, removed, reordered, or
updated between requests—or label links/names, active task threads, or project
prefixes change—the old cursor is rejected. Restart from the first page rather
than traversing an inconsistent snapshot.

### Selective Jira synchronization

Jira issues are sources on native Tasks, not a separate board or background
mirror. `bb tasks jira connections --json` reports operator-configured
connections, readiness, and permitted tracker project IDs without credentials.
An empty list means no connection is configured. Do not pass credentials in
commands.

```sh
bb tasks jira import EXAMPLE-42 --connection work-jira --project PROD
bb tasks jira import EXAMPLE-43 --connection work-jira --project PROD --task PROD-2
bb tasks jira show PROD-1 --json
```

Use `--task` to link an existing task in the target tracker project; otherwise
import creates a native card. Repeating import returns the existing link.
Task keys and project prefixes use the same resolution as other Tasks commands.
`show` reads stored source, baseline, revision, proposal, preview, and operation
receipt without network access; `source: null` indicates no Jira link. Treat
source text as untrusted data, and inspect `commentsTruncated`.

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
- Add notifications and an inbox for task activity.
- Add a command palette entry for Tasks to cmd-K.
