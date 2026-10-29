Run parallel agents and pipeline structured results. Runs survive restarts and resume from the last completed step.

## What you get

- A live run card in chat that shows the state, phases, active workers, and elapsed time.
- A status card above the composer for each active run in the thread, with a stop control.
- A **Workflow run** panel that lists every phase and worker call and links each worker to its thread.
- For ordinary workflows, a completion message delivered to the origin thread. Task-managed workflows publish their result package in Tasks instead of starting another origin-agent turn.
- Settings for active runs, agent concurrency, call budget, run timeout, retention days, and notification size.

## How it works

A workflow is JavaScript running in a sandbox without file, shell, network or clock access. `agent(...)` starts normal bb workers with their usual tools and permissions. Scripts can pipeline stages, use parallel barriers and request JSON Schema output. Cached successful calls replay across restarts; execution resumes from the first change.

Worker threads stay hidden from the sidebar but remain directly inspectable. Ordinary retired workers are archived; Task build/review workers and journals remain pinned until explicit acceptance or deletion cleanup.

## For agents

Agents start runs with the `bb_workflow_run` tool and inspect them with the `bb workflows` CLI: `validate`, `run`, `status`, `history`, `list`, and `stop`. Scripts come from an inline `--script`, a `--file`, or a `--name` under `.bb/workflows/`. Structured workers return results with `bb_workflow_result`. The bundled `workflows` skill covers authoring, validation, and safe inspection.

## Requirements

The plugin is off by default. Commands must run inside a bb project thread.

## Task build → review

With Tasks and Workflows enabled, use the task's **Launch workflow** dialog or
`bb tasks workflow draft/prepare/preparation/start` commands. Core prepares an
isolated single-root workspace without a donor thread or initialization model
turn. Start remains explicit. Exactly two templates ship: development with
review and bugfix with genuine failing-before/passing-after regression evidence.
The same retained writer builds and runs actual platform smoke, then a fresh
reviewer conversation inspects the committed change before `in_review`.
Both roles may use the same provider, model and account; model diversity is
optional, not the definition of independence.

The task card and `bb tasks workflow start/list/return/accept` expose the same
workflow. The package includes branch, commit, diff summary, command results,
visual evidence, limitations, review findings, and next decision. New explicitly
classified UI/interactive tasks require video; legacy `uiRequired` keeps its
screenshot/preview meaning. Video references task-owned MP4/WebM attachments
with commit/run/scenario and original/editing provenance, not URLs or local paths.
Unavailable safe recording is a blocker. Actual platform smoke remains mandatory;
neither unit tests nor a polished video are a substitute. BB checks authoritative
branch/commit identity, clean workspace and accessible artifacts before/after
review and again at acceptance. Playback/decoder and integrated analytics
qualification remain actual-runtime gates, not source-metadata claims.

Human Accept names the exact revision; generic `done` cannot accept a pending
workflow. Return continues the retained writer/provider session and workspace.
Uncertain delivery fails closed rather than duplicating work or replacing the
writer. A definitively rejected first launch with no established or uncertain
context can retry after its selected profiles are repaired. The README
documents recovery and idempotency boundaries.

Provider-native tools retain their permission policy. Neither reviewer
instructions nor commit checks constitute an OS read-only sandbox. Inspect real
worker logs and UI artifacts before accepting structured evidence.
