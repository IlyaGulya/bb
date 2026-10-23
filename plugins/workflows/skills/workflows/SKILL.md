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
bb tasks workflow start TASK --key unique-launch-key --origin thr_origin \
  --writer writer-profile --reviewer reviewer-profile \
  --smoke '["./scripts/platform-smoke"]' --ui --json
bb tasks workflow list TASK --json
```

The identifiers and command above are illustrative. Choose an idle origin in
the task's linked, clean, committed single-root workspace and two already
authorized profiles. The reviewer must differ by provider/runtime or model;
reasoning level alone is insufficient. Catalog membership alone does not prove
environment readiness. Do not reconnect accounts or bypass readiness checks.

The native sequence is plan → same writer implementation and actual platform
smoke → independent reviewer → `in_review`. Required smoke commands must really
run and succeed; unit tests alone are not a platform smoke. UI tasks need
inspectable screenshot/preview evidence. Inspect native worker logs and the
result package, not merely a model's claim. BB checks the package's branch and
commit against authoritative checkout status and requires a clean working tree.

Do not accept automatically. Only after the human's explicit decision, use
`bb tasks workflow accept twf_receipt --revision N --json`. A generic task
status change to `done` cannot accept a pending result. For requested
corrections, use `bb tasks workflow return twf_receipt --revision N --feedback
"concrete correction" --json`. Return continues the same retained writer and
provider session; generic workflow `--resume` is not a substitute.

Reuse the launch key and identical input after a launch retry. Uncertain
delivery fails closed; inspect the retained worker before another explicit
Return. A definitively rejected first launch may use repaired selected profiles
only when native state proves no established or uncertain context exists.
Never replace an established writer to evade an error. See references/runs.md
for the distinct retention and recovery rules.

QuickJS confines orchestration code, not native worker tools. Explicit profile
permissions apply, but reviewer prompts and commit checks are not an OS
read-only sandbox. Review is not permission to publish externally.
