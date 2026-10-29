---
name: workflows
description: "Author or run durable BB workflows when the user requests workflow execution or multi-agent orchestration."
---

# BB workflows

Use a workflow when the user explicitly asks for multi-agent orchestration.
Ordinary tasks do not authorize a workflow run.

A workflow puts deterministic control flow around normal BB worker threads. The
script can fan out work, pipeline stages, verify results, and return structured
data. Worker threads retain normal workspace tools and permissions.

The plugin is disabled on fresh installations; `bb plugin enable workflows`
turns it on. `bb workflows` commands must run from a BB project thread.

## Start safely

1. Inspect the task and repository before you choose the work list.
2. Confirm the provider, model, and reasoning tuple from the live catalog.
3. Write the smallest workflow that gives the requested coverage.
4. Validate the exact source before execution.
5. Start the background run.
6. Emit the returned workflow preview directive exactly once.
7. Use compact status for progress and paged history for details.

Check an explicit model selection with:

```sh
bb provider list --environment "$BB_ENVIRONMENT_ID" --json
bb provider models <provider-id> --environment "$BB_ENVIRONMENT_ID" --json
```

Do not guess model identifiers or partial selection tuples.

## Read only the required detail

- Read references/authoring.md when you write or change workflow source,
  schemas, agent options, or nested workflows.
- Read references/orchestration.md when you design pipelines, barriers,
  verification, panels, loops, or other quality controls.
- Read references/runs.md when you validate, start, inspect, stop, or resume a
  workflow, or change the plugin's run limits.

## Minimal source

Every script starts with a literal meta object:

```js
export const meta = {
  name: "review-change",
  description: "Review a change and verify the findings",
  phases: [{ title: "Review" }, { title: "Verify" }],
};
const results = await pipeline(
  args.items,
  (item) => agent("Review " + item, { phase: "Review" }),
  (review, item) =>
    agent("Verify this review for " + item + ":\n" + review, {
      phase: "Verify",
    }),
);
return results;
```

Workflow source is JavaScript, not TypeScript. The script has no filesystem,
shell, network, import, clock, or random access. Worker agents can use their
normal tools.

Use pipeline for independent multi-stage items. Use a parallel barrier only
when the next stage needs all prior results.

Use an agent schema when later stages need reliable structured data. A
structured worker must return its value through the workflow result tool.

## Execute

Validate and run with the same source selector:

```sh
bb workflows validate --file .bb/workflows/review-change.js
bb workflows run --file .bb/workflows/review-change.js --args '{"items":[]}'
```

The agent tool accepts script, scriptPath, or name. The CLI accepts --script,
--file, or --name.

After a successful agent-tool call, copy its previewDirective into the
assistant response as one standalone line. Do not edit or repeat it.

Use bb workflows status for compact progress. Redirect bounded history pages
into BB_THREAD_STORAGE before inspection because history can contain full
prompts and results.

## Quality check

- The user explicitly requested workflow orchestration.
- The source passes bb workflows validate.
- Every explicit provider tuple exists in the live catalog.
- Each phase name matches its meta entry.
- Independent items use pipeline without an unnecessary barrier.
- Bounded coverage logs what it omits.
- Structured consumers receive schema-validated results.
- The final response uses status or inspected history, not assumptions.

## Task-managed build → review

For an explicitly authorized Task build/review, use the existing Tasks surface
instead of composing another scheduler or an open-ended agent council:

```sh
bb tasks workflow draft set TASK --template development-review \
  --machine "Execution machine" --writer "Personal OMP Sol" \
  --reviewer "Personal OMP Sol" --checks '["./scripts/platform-smoke"]' --task-kind ui --json
bb tasks workflow prepare TASK --json
bb tasks workflow preparation TASK --json
bb tasks workflow start TASK --json
bb tasks workflow list TASK --json
```

Names and commands above are illustrative. The task derives its code project;
Core prepares an owned clean single-root worktree and internal contexts without
an origin donor or initialization LLM turn. Both roles may use the same provider,
model and account. Independence is a fresh reviewer thread/conversation, retained
separately across Return. Readiness and native Core admission remain mandatory;
do not reconnect accounts, change payers implicitly or bypass readiness checks.

The native sequence is plan → same writer implementation and actual platform
smoke → independent reviewer → `in_review`. Required smoke commands must really
run and succeed; unit tests and human-demo videos do not replace platform smoke.
New explicitly classified UI/interactive work defaults to the version-1 video
policy through `--task-kind ui`; backend work uses `--task-kind backend` and
technical evidence. `--evidence-policy technical|ui|video` is an explicit override.
Saved legacy `uiRequired` / `--ui` keep their screenshot/preview meaning and
existing results stay readable. Never infer task type from text/model/account.
When video is required, attach a real short MP4 / H.264 or WebM scenario to the
owning Tasks task (25 MiB maximum), identify the exact reviewed commit, source
run and scenario, retain the original server attachment and disclose editing or
speed changes. Video evidence uses attachment IDs, not arbitrary URLs or /tmp
paths. Unavailable approved safe capture is an honest blocker, not a fallback to
screenshots or previews. Exclude secrets and unrelated work from the recording.
The writer/reviewer receive the explicit policy, and Return cannot weaken it.
Inspect actual playback, native worker logs and the technical result package,
not merely model claims or successful structural validation. BB verifies the
authoritative clean checkout and accessible task-owned artifacts before review.
Decoder/playback, desktop/mobile/auth/Range and analytics acceptance require
observed candidate-version qualification; source contracts are not live proof.

Do not accept automatically. Only after the human's explicit decision, use
`bb tasks workflow accept twf_receipt --revision N --json`. A generic task
status change to `done` cannot accept a pending result. For requested
corrections, use `bb tasks workflow return twf_receipt --revision N --feedback
"concrete correction" --json`. Return continues the same retained writer and
provider session; generic workflow `--resume` is not a substitute.

Retry Start against the same prepared task; its launch key is server-owned.
Uncertain delivery fails closed; inspect the retained worker before another explicit
Return. A definitively rejected first launch may use repaired selected profiles
only when native state proves no established or uncertain context exists.
Never replace an established writer to evade an error. See references/runs.md
for the distinct retention and recovery rules.

QuickJS confines orchestration code, not native worker tools. Explicit profile
permissions apply, but reviewer prompts and commit checks are not an OS
read-only sandbox. Review is not permission to publish externally.
