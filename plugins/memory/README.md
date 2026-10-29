# bb-plugin-memory

BB's official plugin for durable, progressively disclosed agent memory. It
provides:

The task/context additions are a source checkpoint, not runtime or deployment
acceptance. Controller-owned integrated checks, independent review, native
runtime-change QA and source-version integration remain required before
activation. This feature does not change provider memory, model/account
bindings, project defaults or global settings.

- plugin-private SQLite storage with append-only migrations;
- explicit general global/project notes and isolated task/logical-context records;
- a shared bounded task summary through awaited `bb.agents.configure`, with
  live Tasks linkage checks; general-note catalogs stay on
  `bb.agents.contributeInstructions` and out of Core-context instructions;
- CLI-only agent access through `bb memory` (no native agent tools);
- FTS5 search followed by full-record reads;
- explicit provenance, tags, kinds, importance, pinning, and version history;
- optimistic update/forget operations and soft deletion;
- diff-first reflection with explicit apply/reject and canonical revision links;
- retained Memory history and proposal rejection even after a task is moved,
  unlinked or deleted; this is not an immutable archive of the task original;
- basic prompt-injection and secret-pattern rejection;
- a bundled `memory` skill that teaches agents retrieval and write policy.
- native scoped Memory pages, settings and thread controls with paginated
  browsing, provenance, revision history and reviewed reflection controls.

## Install

Install Memory from the BB Official catalog:

```bash
bb plugin install memory
bb plugin list
```

## Try it

```bash
bb memory add \
  --general --scope project \
  --name turbo-validation \
  --summary "Use Turbo for builds and typechecks" \
  --details "Run pnpm exec turbo run typecheck --filter=@bb/<pkg>." \
  --kind procedure \
  --tag build \
  --tag testing \
  --importance 80 \
  --reason "Durable repository validation convention" \
  --json

bb memory search "Turbo typecheck" --general --scope all --json
bb memory get <id> --general --scope all --json
bb memory catalog --general --scope project --limit 100 --offset 100 --json
```

Project writes take the invoking CLI's BB project context. Global writes must
explicitly pass `--scope global`. The injected catalog refreshes at every
thread start / turn submission, so a successful CLI write is visible on the
next turn.

Task selectors, source validation, bindings and reflection commands are
specified in `skills/memory/SKILL.md`. Retained revisions keep their original
project/task/context scope; a task move or relink does not migrate them into
another project's catalog. Persisted replacement and reflection targets are
canonical IDs, never names that can redirect a reviewed write.

The typed `listMemories` RPC takes
`{projectId,task,executionContextId,offset}` and returns
`{memories,total,previousOffset,nextOffset}`. Offsets are explicit and native
pages are bounded to 100 rows. FTS search remains a bounded ranked lookup;
clear search to browse all retained active records in the selected scope.
`memoryHistory` accepts a nullable `version`; CLI `history --version N` and
replacement controls read that exact retained revision even beyond the newest
100 revisions.
Scoped RPC requests use top-level Core `projectId`, `task` and nullable
`executionContextId`, plus method fields. The boundary fills a missing
execution context once; internal routes receive explicit values. Source38
reads the existing Core selector boundary, not Memory payloads. There is no
legacy nested-`selection` request alias.

Artifact sources consume Source30's native Tasks `listTaskArtifacts` and
`getTaskArtifact` RPCs. `bb memory contexts`, `sources`, `artifacts` and
`artifact` expose discovery and inspection; settings use named context choices,
and thread panels use their authoritative Core execution-context binding.
References persist the artifact ID, actual context, raw-text SHA-256 and
bounded inspected excerpt, never another artifact store. Reads validate the
selected Core project and actual execution context. Server-owned
`lineage.evidenceContextIds` retains originating evidence restrictions
independently of the current source kind. Reflection preserves those
restrictions; replacements inherit them. Catalog, FTS, reads, version-specific
history, proposals and injected summaries require every retained restriction
to match the reader's permitted actual context. A task/comment provenance
change is not declassification. Independently native task/comment evidence
retains its existing logical-context scope.

An append-only private Memory migration reconstructs existing restrictions
from retained revisions and pinned replacement ancestry, including proposal
before-snapshots. Earlier native-only snapshots remain native-only; later
provenance changes cannot erase acquired restrictions. Conflicting historical
origins fail closed rather than choosing a wider context. No new archive,
Core database migration or governance action is introduced.

Stored-original controls pass the persisted artifact ID, execution context,
raw-message hash and bounded source excerpt to `readMemoryArtifact` as `pin`.
The raw hash identifies the containing message, not its retained selection.
Before returning evidence, the server requires every nonempty stored excerpt
to occur exactly within the native retained selected quote, not merely within
the containing message. A valid bounded subset is accepted; a different
selection lacking that excerpt is rejected even when UUID and raw hash match.
The returned source preserves the validated excerpt.

Fresh inspection still uses a null pin. CLI `artifact --revision <stored-hash>
--quote '<stored-excerpt>'` uses the same guard; `--quote` requires `--revision`.
An explicitly empty excerpt means no selected text was persisted: only the
ID/context/container hash can be verified, not full selection identity.
Native original status and URL still come from Tasks; the inspector reads
retained selected text/metadata, not image bytes or full transcripts.

The consumer schemas in `tasks-consumer.ts` project native RPC outputs through
the SDK. Runtime modules do not import sibling plugin source or weaken
source-loader boundaries. The integrated build requires the real Source30
implementation. These security changes are a source checkpoint: unchanged
regression after-proof, migration qualification, compiled UI/native proof and
independent review remain required. No after-pass or activation is claimed.

`memoryAnalytics` returns the identities supplied by the shared Source38
declarations. The UI submits those identities through
`useSdk().experimental_productAnalytics.record`; it does not guess a plugin
namespace or treat a local opening as a successful write. Actual framework
mutation scope/actor attribution and collector delivery still require the
controller's Source38 after-proof. No second collector or execution queue is
introduced.

## Limitations

- CLI calls require loopback access to the local server. Claude's macOS
  workspace sandbox permits this; Linux and other provider sandboxes may
  still block it.
- Retrieval is FTS5 keyword search in this first version; embeddings and
  background reflection are deliberately deferred.
- The safety scanner is a guardrail, not a substitute for avoiding sensitive
  memory content.

## Develop

```bash
pnpm exec turbo run test typecheck --filter=bb-plugin-memory
bb plugin dev ./plugins/memory
```
