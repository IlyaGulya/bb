# Workflows built-in plugin

Workflows is an opt-in built-in plugin (`builtin:workflows`) and is disabled on
fresh BB installations. It runs provider-independent JavaScript orchestration
inside QuickJS while delegating actual reasoning to ordinary BB threads.

The author-facing native surface is intentionally one tool:
`bb_workflow_run`. Validation, inspection, listing, and cancellation use the
`bb workflows` CLI documented below. Provider and model discovery uses BB's
built-in `bb provider` commands. Structured workers separately
receive only `bb_workflow_result`; ordinary authoring agents never receive that
worker tool.

## Progress UI

A successful `bb_workflow_run` result includes a trusted
`previewDirective` such as:

```text
::workflow-preview{run="wfr_…"}
```

The authoring agent emits that returned value exactly once on a standalone
line. BB replaces the directive with a compact live run card in chat. The card
shows run state, declared phases, the active phase's workers, elapsed time, and
an action that opens the full workflow inspector in the thread's right panel.
While a thread has queued or running workflows, the plugin also contributes a
status card above that thread's composer. It lists every active run with its
current phase and agent-call progress and lets the user stop a run in place;
the card disappears when the thread has no active runs.
The panel shows every phase and worker, links attached workers to their BB
threads, reports cache and result state, and can stop an active run. It may also
be opened directly from the thread panel action, in which case it shows that
thread's latest run.

Both surfaces are implemented by the plugin app with bb's registry components
and BB theme tokens. Directive attributes and restored panel parameters are
treated as untrusted input. The backend additionally binds every requested run
to the directive message or panel thread, so a run ID from another thread
cannot be inspected or stopped through these UI RPCs. The service publishes a
`workflow-runs` realtime signal for the origin thread when a run starts, is
claimed, settles, or is cancelled, and whenever its phase or one of its agent
calls changes, so the composer status surface and the message cards follow a
run from signals instead of a standing poll. While the page is visible they
refresh on each signal (a burst folds into one follow-up request), refresh once
when the page or the realtime connection comes back, and keep only a 15-second
fallback poll while a run is active. A failing refresh retries with backoff from
2 seconds up to one minute, and everything stops when the run is terminal.

The security boundary is the QuickJS context: workflow code has JSON data and
explicit orchestration capabilities, but no Node, filesystem, shell, network,
imports, clock, or randomness. The QuickJS WASM is embedded in the plugin's
single-file server bundle so packaged built-ins need no sidecar asset.
JSON Schema compilation and result validation necessarily run in the Node host,
not inside QuickJS, so every metadata and agent-output schema is restricted
before Ajv sees it. The supported subset covers boolean schemas plus common
structured-output keywords: `type`, `properties`, `required`,
`additionalProperties`, `items`, scalar `enum`, `const`, numeric/string/array/
object size bounds, `nullable`, and annotation keywords. Regex and format
validation, references, combinators/conditionals, `uniqueItems`, `contains`,
dependent/unevaluated schemas, unknown keywords, structured enums, and excessive
property or enum fanout are rejected with the schema path and safety reason.
Schemas also retain the 64 KiB, 4,096-node, depth, cycle, and prototype-safety
limits. This deliberately conservative subset keeps host-side validation
bounded and preserves ordinary object/array structured results.

Metadata may declare an ordered literal `phases` array. Every entry has a
required non-empty, unique `title` and an optional non-empty `detail`; unknown
fields and malformed entries are rejected. Declaration order is preserved.
`phase(title)` changes the current phase, and later agent calls inherit it.
An agent-level `phase` applies only to that call and does not change the current
phase.

Workflow input follows the native Claude source modes: provide exactly one of
an inline `script`, a workspace `scriptPath`, or a workflow `name`. The older
`source` field remains an explicit alias for inline `script`; `script` and
`source` cannot be supplied together. Name lookup is project-local at
`.bb/workflows/<name>.js`. There is no plugin-bundled workflow discovery.

File and name sources are resolved on the workflow origin environment's host,
not on the bb server machine. BB reads them through the environment `hostId`
with `rootPath` confinement to its workspace. Traversal and outside absolute or
UNC paths, missing workspace roots, non-UTF-8 content, and sources larger than
512 KiB are rejected. QuickJS receives only the resolved source text and never
receives a filesystem capability.

Durability lives in the plugin-owned SQLite database. Runs and ordered agent
calls are persisted independently. On restart the source is evaluated from the
beginning and successful calls are replayed by a SHA-256 key until the first
divergence. Explicit resume uses the same longest-unchanged-prefix rule against
the selected prior run. Parallel calls receive identities in deterministic
invocation order, so concurrency does not stop replay. The first edited, new,
failed, cancelled, incomplete, or null-result call and the entire suffix run
live. Successful calls are reusable regardless of which tools they used,
including file edits and other writes, because resume is restricted to the same
environment workspace where those effects remain. Runs created before
replay-safety metadata existed replay nothing.

Ordinary, non-Task-managed agent calls retry transient provider failures twice with bounded backoff before
the failure reaches the workflow script. Retryability comes from an explicit
SDK `retryable` marker when available or conservative overload, rate-limit,
provider 5xx, and network-error signatures. Authentication, configuration,
schema, and other deterministic failures are not retried. Retry attempts are
persisted on the call so a plugin restart cannot reset the retry budget.

Worker output is either the final assistant text or an Ajv-validated value
submitted through `bb_workflow_result`. Structured workers receive two
corrective retries after their initial invalid attempt.

Workflow workers use BB's generic hidden-thread visibility. They remain
out of sidebar organization without contributing unread/pending favicon
attention. Retired ordinary workers are archived by durable cleanup; their
thread records remain inspectable. Task build/review workers are instead
retained until explicit acceptance or task-deletion cleanup. Ordinary search, prompt history,
lifecycle, and direct operations remain available. Workers are root threads,
so no parent notification applies; a hidden thread that does have a parent
still reports its turns and blockers to it. Workflows does not create a
temporary Workflow folder.

Workflows may invoke one child workflow level with
`workflow(nameOrRef, args)`. A string and `{ name }` resolve under
`.bb/workflows`, `{ scriptPath }` uses the same origin-workspace confinement as
top-level runs, and `{ script }` is inline source. Each child is parsed,
schema-validated, and evaluated in a separate QuickJS VM. Parent and child VMs
share one FIFO agent scheduler, call budget, cancellation signal, replay order,
and phase/progress record. A child cannot invoke a grandchild.

## Task build → review

Tasks can use this native engine for a bounded implementation workflow without
writing a separate script or installing another scheduler. Workflows must be
enabled, and the task's tracker project must link to the BB code project.
Tasks derives the code project from the task. Its responsive **Launch workflow**
dialog and draft/prepare/preparation/start CLI create an isolated single-root
worktree and internal contexts through Core's supported preparation-only thread
creation. No manual origin donor, imported session or initialization model turn
is required. Preparation remains observable and explicit Start is separate.
Multi-repository support is not a prerequisite and its manifest cannot be bypassed.

Select authorized role choices. The reviewer starts in a fresh separate native
thread/conversation, but may use the **same provider, model and account** as the
writer. Model diversity is optional. Core readiness, account/context/host
admission and actual checkout/evidence verification still apply without fallback.

The three sequential native calls are:

1. The writer produces the plan.
2. The **same writer thread/provider session** implements it, commits its owned
   changes, and executes the actual platform smoke commands.
3. A separate reviewer inspects the change and evidence.

The `bugfix` template replaces the first phase with genuine failing-before
reproduction and requires both passing-after evidence for that exact command and
an executed consumer regression before platform smoke/review. On human Return,
the first validated failing-before evidence is retained rather than fabricating
a new failure in the already-fixed checkout. Evidence must have a nonzero exit
code and a durable Fix-call receipt proving the reproduction gate advanced;
a succeeded reproduction agent call alone is not sufficient. An exit-zero
attempt can retry reproduction after corrected human feedback. Later unrelated
reproduction attempts are rejected and never replace the established original
command, exit code or output on another Return. Both templates keep the same
three managed role calls and quiescent transitions; no second orchestration engine exists.

For these managed calls, `bb_workflow_result` acknowledges a validated,
persisted result without stopping the native turn or waiting for it to finish.
Acceptance of that value is not successful call completion: only actual native
idle, observed by an event or reconciliation, settles the call and releases the
next phase. Plan therefore cannot deliver Build to a still-working/stopping
writer. Restart preserves a stored-but-unconfirmed result as pending; native
failure or workflow cancellation cannot turn it into success. Generic unmanaged
workflows keep their existing structured-result completion behavior.

The result package records the plan, branch, full commit, diff summary, command
text/output/exit codes, visual evidence, limitations, independent review
findings/verdict, and next decision. Every required smoke command must appear
in the evidence, and recorded commands must exit successfully. Unit tests and
video demos do not replace the requested platform smoke. New explicitly
classified UI/interactive work uses `evidencePolicy:{version:1,requirement:"video"}`;
legacy `uiRequired` still accepts screenshot/preview and saved results stay readable.
`technical` requires technical smoke only; explicit `ui` permits screenshot/preview.
Worker output schemas are structural projections of the canonical Zod evidence
fields into the existing safe workflow schema subset, not raw draft-schema
documents. They use bounded commit lengths, enum evidence kinds, and optional
per-kind fields without regexes, references, or schema combinators. Nullable
editing disclosure uses the subset's supported `nullable` keyword. Full canonical
Zod validation still enforces hexadecimal commits, strict per-kind fields and
required video/legacy evidence semantics after the writer and before independent
review and successful completion. The Tasks bridge uses that same full contract;
the generic workflow schema validator and its security limits are unchanged.
Video entries reference task-owned attachments with exact commit/run/scenario,
original attachment and truthful editing disclosure, never arbitrary URLs or
local paths. Safe recording unavailability is a blocker, not a screenshot fallback.
The artifact must be available and structurally valid before independent review,
and Tasks rechecks it before publication/Accept. Decoder support and real demo
content require actual playback/inspection; source validation is not live proof.
Human Accept and publication/deployment remain separate.

BB checks authoritative workspace status before the reviewer, after review,
before successful completion, and again on Accept. The reported branch and
commit must match the checkout, and the working tree must be clean. A changed
checkout cannot be accepted as the previously reviewed result.

Use the Tasks card's **Launch workflow** button or its CLI. Names and platform
commands below are illustrative:

```sh
bb tasks workflow draft set TASK --template development-review \
  --machine "Execution machine" --writer "Personal OMP Sol" \
  --reviewer "Personal OMP Sol" --checks '["./scripts/platform-smoke"]' --task-kind ui --json
bb tasks workflow prepare TASK --json
bb tasks workflow preparation TASK --json
bb tasks workflow start TASK --json
bb tasks workflow list TASK --json
bb tasks workflow return twf_receipt --revision 1 --feedback "Fix the observed layout defect" --json
bb tasks workflow accept twf_receipt --revision 2 --json
```

Retry Start against the same prepared task. Its server-owned durable receipt
prevents duplicate native runs. Completed result publication is
transactional and once per revision: the task becomes `in_review`, not `done`,
including when the independent reviewer requests changes. Human **Accept**
must name the exact current revision. Generic task status `done` is not an
alternative acceptance path. Review never authorizes external publication.

Human **Return** requires concrete feedback and creates another journal run
in the same workflow group while continuing the retained writer and its
workspace/provider session. This is not generic `bb workflows run --resume`
prefix replay and never silently substitutes a new writer. The card links the
native worker threads. Working follows actual worker activity even if the
origin stays idle; Inbox review uses the writer's package, and launch/run
failures appear in Needs input.

Retained workers and journal records stay pinned while human review is
pending. Acceptance releases the group for ordinary cleanup. Task/project
deletion preflights all affected groups and releases them in one native
transaction; an active group prevents release of the whole deletion set.
An unavailable, deleted, archived, or execution-changed established writer
must be repaired rather than replaced.

Each role has independent explicit context and model-account selections; the
context never implicitly chooses the payer. Tasks stores copied role choices
in a server-side task/owner-scoped revisioned draft. Project/template settings
are saved or applied only by explicit actions, never as global last presets.
Older managed requests that omit binding overrides remain implicit on replay.
The managed request stores IDs only. Native Core spawn/send admission owns
binding resolution, connection-specific model/readiness validation, and denial
of missing, disabled, revoked, or incompatible selections without fallback.
Managed workers are not prevalidated against the origin/native default catalog
or login. Generic unmanaged workflows retain their existing selection policy.

Plan/build and Return reuse the native writer and its resolved binding; an
existing reviewer retains its own binding too. Preset/project-default changes
and later definition edits cannot retarget these workers. Continuation checks
the retained thread's execution options rather than a mutable/default catalog;
Core still checks live revocation/authorization at the next native admission.
Only a definitive first-launch rejection with no established or uncertain
context permits repairing the original presets, including these selectors.

`threads.send` has no idempotency key. An uncertain continuation delivery fails
closed, preserving the same worker for inspection and a subsequent explicit
Return; it does not blindly send again. A missing launch acknowledgement is
reconciled against native worker metadata, and an unresolved outcome cannot
create a replacement writer. A definitive rejected initial creation is
different: when native state proves there is no established or uncertain
context, repair the originally selected execution profiles and Return to retry
the first writer launch. Existing/uncertain contexts cannot change profiles.
Launch errors can also retry the same durable receipt from the card.

The QuickJS sandbox confines orchestration code, **not provider-native worker
tools**. Workers use explicitly selected permission modes and profiles.
Workflows grants its structured-result tool; other installed plugin and native
tools retain their existing policies. Reviewer instructions and unchanged
commit checks are not an OS read-only sandbox.

SDK callers use Tasks RPCs `getTaskWorkflowDraft`, `saveTaskWorkflowDraft`,
`getProjectWorkflowSettings`, `saveProjectWorkflowSettings`,
`prepareTaskWorkflow`, `getTaskWorkflowPreparation`, `getTaskWorkflowProject`,
`launchTaskWorkflow({taskId, preparationId})`, `taskWorkflows`,
`acceptTaskWorkflow`, and `returnTaskWorkflow` through
`bb.sdk.plugins.callRpc({ pluginId: "tasks", method, input, outputSchema })`.
Tasks owns its validated remote protocol schema; forked Tasks installations
do not import this plugin's private implementation. Task-managed completion
is consumed from the durable journal and does not start an extra origin-agent
turn.

## Settings

Workflows declares six plugin settings:

- `maxActiveRuns` limits runs dispatched at once across the plugin.
- `maxConcurrentAgents` limits live agent calls within one run, including its
  child workflow.
- `maxAgentCalls` bounds the shared parent/child call count.
- `totalRunTimeoutMs` fails a run independently of explicit cancellation.
- `retentionDays` controls terminal-run cleanup while preserving active runs,
  retained resume ancestors, and pending Task build/review groups. Retired
  worker archival has its own durable cleanup retries; releasing a Task group
  does not delete its workspace or imply acceptance of another revision.
- `maxNotificationBytes` bounds completion messages by UTF-8 byte length.

`maxActiveRuns` is live plugin-global dispatch policy: changing it immediately
changes how many queued runs the worker may claim. The other five values are
snapshotted into each new run and remain fixed for that run, including a resumed
run. Saving settings does not require a plugin reload.
Ordinary, non-Task-managed terminal runs send an agent-only completion input back to the origin thread. It
steers an active origin immediately or starts a turn when the origin is idle,
while remaining absent from the user-facing timeline and search. Polling the
compact `status` summary remains authoritative when a completion message is
truncated or temporarily cannot be delivered. Completion delivery is
at-least-once: a successful `threads.send` followed by a crash before its durable
acknowledgement may produce a duplicate because the API has no idempotency key.
Duplicates carry the same stable run ID marker. Failed attempts use durable,
capped exponential backoff. Status exposes notification outcome as `pending`,
`delivered`, or `abandoned`; a missing or deleted origin permanently records
`abandoned` so it cannot block retention.

Useful checks:

```bash
pnpm exec turbo run typecheck --filter=bb-plugin-workflows
pnpm exec turbo run test --filter=bb-plugin-workflows --force
bb plugin build plugins/workflows
```

User-facing commands (run these from a BB project thread) are:

```bash
bb workflows validate --script '<javascript>'
bb workflows validate --file .bb/workflows/review.js
bb workflows validate --name review
bb workflows run --script '<javascript>' --args '<json>'
bb workflows run --file .bb/workflows/review.js --resume <run-id>
bb workflows run --name review
bb workflows status <run-id>
bb workflows history <run-id> --cursor 0 --limit 100
bb workflows list --limit 20
bb workflows stop <run-id>
bb provider list --environment "$BB_ENVIRONMENT_ID" --json
bb provider models <provider-id> --environment "$BB_ENVIRONMENT_ID" --json
```

Every command accepts `--help` (printed from the declarative CLI spec, exit 0)
and `--json`. Output is JSON either way; `--json` additionally reports failures
as `{"ok":false,"error":{code,message,hint?}}` on stdout while stderr keeps the
readable message.

`status` is deliberately bounded: it returns run state, phase, call counts,
notification state, and only a small final result. It omits source, arguments,
and call history so polling cannot be truncated into invalid JSON.
`list` is likewise bounded and returns compact run summaries rather than source
or result bodies. Untrusted names, phases, and errors are capped by UTF-8 bytes;
the adjacent `*Truncated` fields report when a displayed value was shortened.

`history` returns one strict JSONL snapshot page ordered by call index. Redirect
it before inspecting it so large prompts and results never enter the agent
transcript:

```bash
run=<run-id>
mkdir -p "$BB_THREAD_STORAGE/workflows"
bb workflows history "$run" --cursor 0 --limit 100 \
  > "$BB_THREAD_STORAGE/workflows/$run.jsonl"
```

The final `page` record reports `hasMore` and `nextCursor`. Fetch the next page
with that cursor and append it to the same file. A full `run` record appears on
the first page, later pages include a small `run-reference`, and every call
record includes requested options, resolved provider/model/reasoning/permission,
cache/live state, child thread ID, repairs, result, and error. Pages are
snapshots; while a run is active, rewrite the file from cursor `0` when a fresh
detailed view is needed.

This redirection intentionally happens in the invoking agent's shell. The
canonical state remains in the plugin's server-side SQLite database, while the
JSONL file lands in `$BB_THREAD_STORAGE` on that thread's execution host. The
same flow therefore works for local and remote environments without granting
the server arbitrary filesystem-write access.

Before selecting an explicit provider tuple, query only the relevant provider
with BB's built-in commands above. Never infer ACP model IDs from a provider
name: for example, an ACP provider can advertise `grok-4.5` even though neither
that model ID nor its reasoning options can be derived from `acp-grok`.

`--source` is retained as an inline alias for `--script`. `run` and `validate`
share source resolution and validation. Validation checks the 512 KiB limit,
hidden control characters, JavaScript syntax and unsafe constructs, literal
metadata and JSON Schemas, partial literal provider/model/reasoning tuples, and
every discoverable literal tuple against the live origin-host provider data.
Errors distinguish unavailable providers, model-load failures, model
mismatches, and unsupported reasoning levels.

For the CLI, a relative `--file` is resolved from the invoking CLI's current
directory. That directory and the final path must both remain inside the
origin environment workspace; absolute and traversal escapes are rejected.
Relative agent-tool `scriptPath` values remain rooted at the workspace root.

Agent options accept native `label`, `phase`, and `schema` alongside BB's
existing `title` and `outputSchema`. `label` resolves to canonical `title`, and
`schema` resolves to canonical `outputSchema`. Both spellings of an alias may
be provided only when structurally identical; schema object key order is
ignored.
`provider`, `model`, and `reasoningLevel` remain all-or-none. Title/label/phase
are display-only and do not participate in resume cache identity. The canonical
output schema does participate, regardless of which accepted spelling supplied
it.

Resume requires a terminal prior run from the same project and environment
workspace. Another origin thread may resume it only when that thread uses the
same environment. Successful writer calls are cached just like read-only calls;
their effects are not copied into another workspace.

## Worker lifecycle and upgrades

Each worker attempt has durable workflow ownership, including attempts replaced
by provider retries. New workers also carry ownership metadata in their core
thread record so maintenance can recover a successful creation whose response
was lost. Workers stay hidden and reuse the origin environment without a core
parent-thread relationship; this avoids core child routing and completion
notifications in addition to the workflow's own notification.

Maintenance stops and archives finished, replaced, cancelled, and unattached
workers independently of workflow history retention. Cleanup retries after
stop/archive failures and server restarts, with persisted exponential delays
from one second up to one minute. Recovery discovery scans every 30 seconds
(one page per second during a scan), and checks outstanding spawn attempts
promptly. Completed notification retries do not cause extra origin polling.
Transient origin lookups retry within the run timeout instead of failing the
run immediately. Pending worker cleanup survives
expiry of the run's history. Archiving or deleting an origin cancels its
outstanding runs and retires all owned attempts; retained history remains
available until its usual expiry. Missed origin events are reconciled from
current thread state. A worker being spawned when cancellation occurs is
recorded and retired when it returns or is rediscovered.

Notifications to archived or deleted origins are settled as abandoned. Other
send failures remain retryable, including unrelated HTTP 409 conflicts.

The upgrade backfills workers still referenced by `workflow_calls`. Older
replaced or unattached workers whose IDs were already lost have no ownership
metadata and cannot be safely attributed automatically. Recovering those
requires a separate evidence-based audit of historical records; this migration
does not guess ownership from titles or modify those threads. Discovery and
cleanup require a running plugin and available thread APIs; unavailable hosts
leave durable cleanup pending.
