---
name: memory
description: "Retrieve bounded BB task/context decisions and their originals, or maintain explicit general notes."
---

# BB memory

Use official Memory, Tasks and their existing originals. Do not build another
memory store, vector database, execution queue, recorder or provider-history
index. Do not change provider-native memory or project/account defaults.

## Source acceptance gate

The task/context interfaces in this source require controller-owned integrated
checks, independent review and an actual OMP → native Claude runtime-change
scenario before activation or deployment. This skill is a command contract,
not evidence of an installed or accepted runtime. The artifact consumer uses
Source30's real Tasks `listTaskArtifacts` and `getTaskArtifact` RPCs; the
controller must integrate that Tasks implementation before artifact QA or
activation. Memory does not implement an alternative artifact archive.

## Scope and current summary

General notes and task notes are different selections. Task notes require an
existing BB task whose Tasks project is explicitly linked to a Core project,
and an explicit logical context name. A model, payer, account, tool identity,
most-recent thread or task attachment never supplies that context.

```sh
bb memory summary --task BBDEV-29 --context personal-research --json
bb memory catalog --task BBDEV-29 --context personal-research --json
bb memory search "storage decision" --task BBDEV-29 --context personal-research --json
bb memory get storage-choice --task BBDEV-29 --context personal-research --json
bb memory history storage-choice --task BBDEV-29 --context personal-research --json
```

Use `bb memory history <id-or-name> --version <inspected-version>` with the
same task/context selectors to read an exact retained revision. Omitting
`--version` uses the recent window (`--limit`, default 20, maximum 100); the
RPC returns the newest 100 revisions. An exact version remains retrievable
after it leaves that window. Replacement buttons request the stored canonical
ID and pinned version, not the latest revision.

Task selectors use a named task key, not a manually transcribed opaque ID.
Context names are 1–80 lowercase letters, digits, dots, underscores or hyphens.
Task selection never falls through to project/global notes, even when a name
is absent. Other contexts, tasks and projects are excluded from ordinary reads,
FTS search, history and mutations.

Awaited `bb.agents.configure` supplies only the explicitly bound, currently
eligible task summaries to all runtimes. General notes stay on the legacy
contributor and are excluded from Core-context instructions. Summaries include
classifications, source revisions, observation times and memory versions,
not details or chronological tool history. `summary`
returns the same single-task summary. The per-task budget is 3,000 characters;
all injected task summaries and the general catalog together stay within
3,900 characters. Multiple explicit bindings share that total budget. Use
catalog/search/get for omitted records instead of copying everything into a
prompt. Read time is not a new observation or evidence refresh.

## Explicit thread bindings

A thread can have no binding, one binding, or multiple bindings. Bindings are
independent of runtime and use their own optimistic version. Inspect before
changing them:

```sh
bb memory bindings
bb memory bind --task BBDEV-29 --context personal-research --expected-version 0
bb memory bind --task BBDEV-29 --context personal-research --expected-version 1 --remove
```

One explicitly saved binding can select ordinary task commands in that thread.
With multiple bindings, always pass `--task` and `--context`, or explicitly
select `--general`. Never select a most-recent binding. Detaching a binding does
not delete memory or its history. Bound threads must use `--general` to write a
general note; `add` does not silently move task content into a shared catalog.

Eligibility is rechecked through native Tasks RPC whenever configuration is
resolved. A task move, project relink/unlink or deletion withdraws its active
summary; it never migrates or erases the retained Memory revisions. History,
proposal inspection and explicit rejection remain scoped to the original Core
project/task/context. Historical CLI selectors use the retained task key in
that project; they do not infer a new project from a task's current location.

## Originals and evidence

First inspect the native original with `bb tasks show BBDEV-29 --json` or the
Task detail view. This existing command includes the task and its comments.
The Memory page, Settings → Memory, and the thread's Task memory panel use
named project/task selectors and provide an Open original task link.

A task source uses the task's `updatedAt` revision. A comment source uses its
native comment ID and `createdAt` revision and must belong to the selected
task. An observation time is the actual inspection time in epoch milliseconds,
not an invented historical timestamp. A source quote is optional, exact, and
at most 600 characters. The server validates the current source revision and
quote before persisting a fact/proposal and again before applying a proposal.
Stored provenance records which revision was inspected; it does not assert
that the live original can never change. Native task/comment references are
not an immutable artifact-version archive.

Visible, explicitly retained Source30 thread decisions are another source,
not an automatic transcript import. Discover permitted actual execution
contexts with `bb memory contexts`, then use:

```sh
bb memory sources --task BBDEV-29 --context personal-research --execution-context '<id returned by contexts>'
bb memory artifacts --task BBDEV-29 --context personal-research --execution-context '<id returned by contexts>'
bb memory artifact '<id returned by artifacts>' --task BBDEV-29 --context personal-research --execution-context '<id returned by contexts>'
```

These commands emit JSON. A threaded caller uses its authoritative Core
execution-context binding; a conflicting override is rejected. Outside a
thread, choose a permitted context explicitly. A logical context name or model
account is never an execution-context identity. The UI offers named context
choices and locks thread panels to their actual binding. Without an actual
context, task/comment sources remain available but artifact facts are excluded.

`artifact` reads native metadata, retained selected text, raw source hash,
source status and the native original URL, not image bytes or a full thread
archive. For attached images or annotations, inspect the original task.
Artifact source JSON is `{kind:"artifact",commentId:null,artifactId,
executionContextId,revision,observedAt,quote}`. Use the returned `source` as the
base; `revision` is the retained raw-text SHA-256, not a fabricated timestamp.
An optional quote must be an exact excerpt of the retained selected text,
at most 600 characters. Observation time must follow artifact retention.
The same native read, authoritative project/context checks, hash and excerpt
validation run for creation, proposal and apply. Original-message changes do
not rewrite the retained evidence. Native source status describes current
availability; deletion or revoked access to the artifact itself may prevent
inspection. Memory stores the source reference, not a second artifact copy.

Artifact-backed records and historical snapshots are visible only in their
permitted actual execution context, including catalog, FTS, history, proposals
and injected summaries. Task/comment-only history and proposals keep their
original project/task/logical-context scope. Moving a task does not move its
retained evidence to the destination project. Context permission checks are
repeated on reads; a stored reference does not grant access by itself.

Keep the evidence types explicit:

- `observation`: what was actually observed;
- `decision`: an explicit choice, with its source and rationale;
- `assumption`: an unverified premise, never presented as an observation.

Create a task fact using `remember --draft <JSON>`. The strict draft contains:

```json
{
  "name": "storage-choice",
  "summary": "Use the verified SQLite store",
  "details": "Bounded evidence, constraints and the next step belong here.",
  "classification": "decision",
  "source": {
    "kind": "task",
    "commentId": null,
    "revision": "<actual native source revision>",
    "observedAt": 0,
    "quote": "<optional exact inspected excerpt>"
  },
  "reason": "<actual decision rationale>",
  "replaces": null
}
```

Replace the illustrative revision/time/quote/rationale with inspected values;
zero is not a valid observation time for a newer source. Pass this JSON to:

```sh
bb memory remember --task BBDEV-29 --context personal-research --draft '<JSON>'
```

Names are unique within one task/context. Summary, details and reason limits
are 400, 16,000 and 500 characters. No artifact/source kind is accepted unless
its real implementation is present. Unknown fields are rejected, not ignored.

## Replacement, obsolescence and reflection

To replace a current decision, create a new named fact with `replaces` set to
`{"id":"<id from scoped get>","version":<inspected version>}`. The store creates
the new fact and marks the old record `replaced` atomically. Both links and the
old revision remain inspectable through history, including exact-version
reads beyond the recent window. A stale, replaced or cross-context replacement
base fails without creating an orphan fact.

Task changes use diff-first proposals, not ordinary `update`. A proposal never
changes current memory by itself. Do not use soft deletion to mean obsolete.
Propose `state: "obsolete"` and retain its original/history instead.

```sh
bb memory propose --task BBDEV-29 --context personal-research --changes '<JSON array>'
bb memory proposals --task BBDEV-29 --context personal-research
bb memory proposal --task BBDEV-29 --context personal-research --proposal '<returned proposal id>'
```

Each change contains `id` (a scoped memory name is accepted),
`expectedVersion`, `summary`, `details`, `classification`, `state`
(`current` or `obsolete`), `source`, and `reason`. A proposal has 1–20 unique
record changes and exposes actual before/after content and provenance.
Empty/no-change proposals are rejected. The list returns the latest 100
proposals; older returned IDs remain inspectable with `proposal`.
Persisted proposal and replacement targets use canonical IDs. A newer note
whose name happens to equal an ID cannot redirect an apply or replacement;
an unavailable canonical target fails rather than resolving to that name.

Only after a human/operator explicitly reviews the diff:

```sh
bb memory decide --task BBDEV-29 --context personal-research --proposal '<returned proposal id>' --decision apply
bb memory decide --task BBDEV-29 --context personal-research --proposal '<returned proposal id>' --decision reject
```

Apply validates all base versions and sources and commits all changes in one
SQLite transaction. A late conflict applies nothing and leaves the proposal
pending for inspection. Do not automatically rebase, overwrite, delete history,
apply governance changes, or turn a rejected proposal into a fresh automatic
write. There is no new scheduler/daemon: a separately authorized existing
workflow may call `propose`, but scheduling and automatic apply are not enabled
by this plugin.

## Explicit general notes

Legacy general notes retain their native global/project intent. Project notes
hold general repository knowledge, not task/context material. Global writes
must be an explicit broadly applicable preference/workflow, never Task or Work
content moved out of its context.

```sh
bb memory catalog --general --scope project --json
bb memory search "general convention" --general --scope all --json
bb memory add --general --scope project --name build-convention --summary '<summary>' --details '<details>' --reason '<reason>'
bb memory update build-convention --general --expected-version 1 --summary '<summary>' --reason '<reason>' --json
bb memory forget build-convention --general --expected-version 2 --reason '<explicit revocation>' --json
```

Use `--scope global` only for explicitly shared general notes. Existing
`kind`, tags, importance, pinning, CAS history and soft deletion remain the
native Memory surfaces. The plugin's `--help` describes their limits.
`history` accepts the task/context/general selectors and `--limit`, not a
`--scope` flag. New task/reflection commands have no aliases.

Catalog browsing is paginated: use `--limit` (1–100) and `--offset` (default 0)
with the same explicit task/context/general selection. For example:

```sh
bb memory catalog --general --scope project --limit 100 --offset 100 --json
```

Native Memory settings, task pages and thread panels expose Previous memories
and Next memories controls over the same scoped SQLite listing. FTS search
returns up to 100 ranked matches; clear it to browse every active record.

## SDK and safety

The typed `memoryRpcContract` uses the same store through native plugin RPC:
top-level `projectId`, `task` and `executionContextId` scope fields, scoped
get/search/history, bindings, task summary, creation and reflection methods.
A task is `{taskId,context}`; `task:null` means general notes. The boundary
normalizes omitted execution contexts to `null`; internal selections carry
an explicit value. `memoryHistory` accepts `name` and nullable `version`;
`null` selects the newest 100 revisions. `listMemoryExecutionContexts`,
`listMemoryArtifacts` and `readMemoryArtifact` are the artifact discovery and
inspection paths shared by UI and CLI. Settings RPC does not provide an
unscoped all-project read or ID-only mutation.
`listMemories` takes `{projectId,task,executionContextId,offset}` and returns
`{memories,total,previousOffset,nextOffset}`; `null` marks a page boundary.
`memoryAnalytics` returns the shared collector's declared action identities.
The UI sends those through `useSdk().experimental_productAnalytics.record`,
never a guessed plugin namespace. These declarations cover local openings,
not server-side write completion.
The local `source.inspect` action covers explicit artifact selection and
original-reader controls on facts, history and proposal diffs. It records an
opening only; native RPC/CLI result observation remains a separate boundary.
These events contain actual Core scope, never artifact/source/context data.
Scoped mutation requests carry their Core `projectId` at the same top-level
boundary Source38 already understands. Do not wrap requests in `selection`
or add a second tracker to infer scope from nested task/context content.
Persisted proposal selections retain `{projectId,task,executionContextId}`;
older task/comment-only snapshots normalize their absent context to `null`.

Never persist credentials/auth, raw configuration paths, provider prompts,
transcripts, tool/MCP payloads, sensitive raw data or large history dumps.
Known secret/prompt patterns are rejected in text, excerpts, names, tags and
logical-context names. The scanner is a guardrail, not perfect DLP or a new
per-user/OS security boundary. Keep bounded decision/source evidence only.

Private analytics contains stable declared actions and actual Core
project/instance scope only, never task/context/source/quote attributes or raw
errors. Local UI openings are not memory-write completions. A failed analytics
receipt is a delivery gap, not evidence of zero usage or a failed memory write.
Actual RPC/CLI attribution and delivery remain controller verification gates.
Do not activate a collector, change model/account routes, run business tools,
or claim acceptance based on source declarations or authored tests.
