Keep bounded task/context decisions and explicit general notes in BB's native Memory SQLite store across threads and providers. These task/context additions are a source checkpoint; integrated checks, independent review, actual native-runtime QA and source-version integration remain controller gates before activation.

## What you get

- Explicit global/project general notes, kept separate from task/logical-context records.
- Observations, decisions and assumptions with source revisions and retained Memory history.
- Task-only bounded summaries through awaited agent configuration; Core-context threads do not import the legacy general catalog.
- Scoped Memory pages, settings and thread controls with Previous memories / Next memories browsing and reviewed reflection controls.
- Kinds, tags, importance, pinning, provenance, and version history for each record.

## How it works

Use `bb memory summary`, `catalog`, `search`, `get` and `history` with an explicit task key and logical context, or select general notes explicitly with `--general`. Catalog pages support `--limit` and `--offset`. Task changes use a reviewable proposal followed by explicit apply/reject; replacements and obsolescence retain their original revisions.

Live task linkage controls new writes and active injection, not retained historical scope. Moving, relinking, unlinking or deleting a task does not migrate its Memory evidence into another project or global notes. Native task/comment revision references are not an immutable source-artifact archive; Source30 integration must use its real API.

## Requirements

Provider memory, model/account bindings and defaults are not changed by this feature. The CLI connects to the local BB server and remains subject to the provider sandbox. Collector delivery, actual mutation attribution and the OMP → native Claude runtime-change scenario require controller after-proof; no source-only acceptance or automatic rewriting/deletion is implied.
