Turn a plan into tracked tasks, hand each task to an agent, and see the worker's progress on the task itself.

## What you get

- A **Tasks** panel with list and board views showing roots and subtasks in their own statuses, clickable parent badges, a **Parent/Epic** filter, and a detail page for each task. Counts, active-agent indicators, and previous/next navigation include subtasks; epic cards retain their child progress.
- Projects with key prefixes such as `PROD-1`, nested folders, labels, priorities, due dates, subtasks, and file attachments.
- Markdown comments with a **Notify last responding agent** switch. The comment goes to the worker thread and resumes it when idle.
- A **Delegate** menu that starts a worker thread from a preset. A preset sets the provider, model, reasoning level, permission mode, and instructions.
- Live thread cards on each task and a **Task** panel action inside a thread.
- **Inbox** with independent manual incoming, New / Needs input / Review, source/context links, create-once or link-existing task actions, snooze/return, and retained decisions.
- **Working** separates current native agent activity from human attention. Questions open the original interactive thread; idle is not acceptance.

## How it works

Link a tracker project to a bb project. Delegation then creates a worker thread there, attaches it to the task, and moves the task to `in_progress`. The worker receives the description, subtasks, attachments, recent comments, and a report-back contract.

Type `@` in the composer and choose **Tasks** to send a task as context. Agents see a `::task{key="PROD-1"}` card when they reference a task.

## For agents

The `bb tasks` CLI covers the full tracker: `create`, `list`, `show`, `update`, `move`, `comment`, `attachment`, `preset`, `delegate`, `attach`, `detach`, `threads`, `label`, `project`, and `folder`. Add `--json` for machine-readable output. The bundled `tasks` skill tells workers to read the task, comment at milestones, attach artifacts, and move finished work to `in_review`.

`bb tasks list` includes subtasks by default. Use
`bb tasks list --parent PROD-1 --status in_review --json` to find only that
parent's direct children in review; parent filtering combines with the other
list options. An explicit or inferred tracker project must match the parent.

Use `bb tasks inbox --help` for intake, linking, resolution, snooze, source
revisions, and history; `bb tasks working --json` reports current native work.
External adapters can upsert durable source attention through the authenticated
`tasks` plugin's `upsertInboxSource` RPC. Work/Personal are organizational context,
not permissions. Dismissing an inbox item never answers a question or accepts a
task result.

Presets are user-defined. Create at least one before you delegate.
