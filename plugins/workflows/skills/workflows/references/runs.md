# Workflow run lifecycle

## Running and resuming

`bb_workflow_run` and `bb workflows validate` accept exactly one source mode:

- `script`: inline JavaScript.
- `scriptPath`: a relative path or an absolute path confined to the workflow
  origin environment's workspace.
- `name`: a lowercase kebab-case name resolved as
  `.bb/workflows/<name>.js` in the current project workspace.

The existing `source` field remains a supported alias for inline `script`, but
do not provide both. File and name resolution happens through the origin
environment's `hostId` and workspace root. Traversal, outside absolute/UNC
paths, missing workspace roots, non-UTF-8 files, and sources over 512 KiB are
rejected. QuickJS receives source text only; it never gets filesystem access.
Plugin-bundled workflow discovery is not supported.

`bb_workflow_run` also accepts optional JSON `args` and optional `resumeRunId`.
It returns a durable run ID immediately. Use the compact `bb workflows status`
summary, paged `bb workflows history`, `bb workflows list`, and
`bb workflows stop` afterward. Completion is sent back as an agent-only input:
it steers an active origin immediately or starts a turn when the origin is idle,
without rendering a user-facing message. Delivery is duplicate-tolerant
at-least-once because `threads.send` has no idempotency key. CLI status polling
remains authoritative.

`list` also returns compact summaries; it is safe for discovery but is not a
substitute for the redirected detailed history.

Detailed history can contain every prompt, critique, result, and call record,
so never print it directly into the agent transcript. Materialize one bounded
JSONL page on the execution host, then use normal file-navigation tools:

```bash
run=<run-id>
mkdir -p "$BB_THREAD_STORAGE/workflows"
bb workflows history "$run" --cursor 0 --limit 100 \
  > "$BB_THREAD_STORAGE/workflows/$run.jsonl"
jq -c 'select(.type == "page")' "$BB_THREAD_STORAGE/workflows/$run.jsonl"
```

The last `page` record supplies `nextCursor`; fetch that cursor and append the
next page. Pages are snapshots, so rewrite from cursor `0` to refresh an active
run. Redirection is performed by your shell, which places the file in the
correct local or remote thread storage without giving the plugin arbitrary
host filesystem access.

To resume after a pause, stop, restart, or script edit, relaunch with the same
current source and `resumeRunId`. Resume requires a terminal prior run in the
same project and environment workspace and always creates a new run. The
longest unchanged prefix of successful `agent()` calls returns cached results;
the first edited or new call and everything after it runs live. The cache key
includes call order, prompt, resolved provider/model/reasoning/permission,
output schema, and worker protocol semantics. Display-only phase, label, and
title changes do not invalidate it.

Parallel calls receive cache identities in deterministic invocation order, so
concurrency alone does not stop replay. Successful calls that edited files or
performed other writes are cached too: resume is restricted to the same
environment workspace, where their side effects remain. Failed, cancelled,
incomplete, and null-result calls are not reusable; the first such call and the
entire suffix run live. Legacy runs without replay-safety metadata replay
nothing. A plugin restart applies the same longest-prefix rule.

Each ordinary, non-Task-managed `agent()` call retries transient provider failures twice with bounded
backoff before surfacing the error to `parallel()`/`pipeline()` or the script.
Overload, rate-limit, provider 5xx, and recognized network failures retry;
authentication, configuration, and schema failures do not. The retry count is
persisted and visible in workflow history.

The CLI equivalents are:

```bash
bb workflows validate --script '<javascript>'
bb workflows validate --file .bb/workflows/review-change.js
bb workflows validate --name review-change
bb workflows run --script '<javascript>' --args '<json>'
bb workflows run --file .bb/workflows/review-change.js --resume <run-id>
bb workflows run --name review-change
bb workflows status <run-id>
bb workflows history <run-id> --cursor 0 --limit 100
bb workflows list --limit 20
bb workflows stop <run-id>
bb provider list --environment "$BB_ENVIRONMENT_ID" --json
bb provider models <provider-id> --environment "$BB_ENVIRONMENT_ID" --json
```

The CLI's `--file` maps to the agent tool's `scriptPath`, but a relative CLI
path starts at the invoking CLI's current directory. Both that directory and
the resolved file must remain inside the origin workspace. `--source` remains
an inline alias for `--script`. Run and validate require exactly one of
`--script`, `--file`, or `--name` (counting `--source` as `--script`).

`bb workflows --help` and `bb workflows <command> --help` print the arguments,
option limits, and rules for a command and exit 0. Command output is JSON;
adding `--json` also reports a failure as `{"ok":false,"error":{…}}` on stdout,
alongside the readable message on stderr.

Workflow worker threads use hidden visibility and are plugin-attributed. They
stay out of sidebar organization without contributing unread/pending favicon
attention. Ordinary search, prompt history,
lifecycle, and direct operations remain available. Workers are root threads,
so no parent notification applies; a hidden thread that does have a parent
still reports its turns and blockers to it. Workflows does not create a
temporary Workflow folder.

## Settings

Change limits with `bb plugin config workflows set <key> <value>`; no plugin
reload is needed.

| Key                    | Default  | Range           |
| ---------------------- | -------- | --------------- |
| `maxActiveRuns`        | 4        | 1–32            |
| `maxConcurrentAgents`  | 8        | 1–64            |
| `maxAgentCalls`        | 100      | 1–1000          |
| `totalRunTimeoutMs`    | 86400000 | 60000–604800000 |
| `retentionDays`        | 7        | 1–3650          |
| `maxNotificationBytes` | 16384    | 1024–262144     |

`maxActiveRuns` is live plugin-global dispatch policy. Shared parent/child agent
concurrency and call count, total run timeout, retention, and UTF-8
completion-message size are snapshotted per run. `status` is bounded
to compact progress and call counts. Paged JSONL `history` carries ordered
call-level execution, cache, child-thread, repair, result, and error details.

Ordinary workers are hidden and owned by the workflow plugin across every retry
attempt. Finished, replaced, cancelled, and unattached ordinary workers are
stopped and archived by maintenance without waiting for history retention.
Cleanup retries across restarts and survives history expiry. Archiving or
deleting an origin cancels its outstanding workflows. Ordinary completion
notification becomes `abandoned` for an archived or deleted origin; unrelated
send conflicts and transient failures retry.
Upgrades recover existing call references; older attempts already missing from
those references require a separate historical audit.

## Task build/review is not generic resume

Tasks uses the same QuickJS engine, journal, worker calls, and bounded settings,
but owns a durable task receipt and human review transitions. Inspect with
`bb tasks workflow list TASK --json`; use the returned native `runId` for
`bb workflows status` or bounded history, and the `twf_` receipt ID for Tasks
Accept/Return. The task card links the retained writer and reviewer.

The plan and implementation/smoke calls use one writer thread/provider session.
The reviewer uses a different allowed provider/runtime or model. Real platform
smoke is mandatory, with command/output/exit-code evidence and screenshot or
preview evidence when UI is required. Authoritative branch, commit, and
clean-tree checks must pass before the result becomes `in_review`.

Launch retries reuse an identical launch key/input. Completion publication is
once per revision and does not send an origin-agent completion turn. Only an
explicit human Accept of the exact current revision moves the task to `done`;
Accept rechecks checkout identity. A reviewer verdict alone is not acceptance.

Return creates a new native journal run in the same group, sends the human
feedback to the **same retained writer**, and reruns independent review. It
does not use generic `--resume` to replace that session. Existing writer model,
permissions, workspace, and provider context must remain unchanged. Idle or
error-state retained workers can resume; busy, deleted, archived, unavailable,
or execution-changed workers cannot be silently replaced.

Task-managed calls do not blindly apply generic provider retries to uncertain
delivery. A lost send acknowledgement fails closed and retains the worker.
Initial launch reconciliation searches native ownership metadata; uncertainty
does not authorize another writer. A definitive rejected initial creation is
recorded separately. If there is no established or uncertain context, repair
the originally selected execution profiles and Return to retry the first
writer. The card labels this case separately and can retry a blocked launch
using its original receipt.

Pending Task review groups pin both worker threads and native journal rows.
Accept releases the group. Deleting tasks preflights and releases the whole
deletion set in one native transaction; an active member prevents any member
from being released. Do not release a group manually to evade human review.

Worker tool permissions remain the selected provider/plugin policy. The
QuickJS orchestration sandbox, reviewer instructions, and stable commit checks
do not establish an OS read-only sandbox. Inspect real logs and artifacts
before making an acceptance decision.
