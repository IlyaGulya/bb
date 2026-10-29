# BBDEV-33 private capture source handoff

This is unqualified, unactivated source for the authorized isolated worktree,
not deployment, task completion, full-capture certification or human acceptance.
The complete BBDEV-33 contract remains required. No runtime/model/account,
installed SDK, auth, CA, global defaults, live source43 or service configuration
was changed. No real raw log, credential, business payload or authentication
home was copied. The previously verified Personal Sol6.1/high/full binding is
not substituted by this work; capture data scope never follows the model payer.

## Existing owners and new source contracts

The implementation stays inside the existing Core server, SQLite/private-file
storage, host daemon and its authenticated `capture.exchange` RPC. The outbox
contains capture data only, not runnable tasks. There is no new execution queue,
supervisor, orchestrator, recording service, proxy or browser service.

- `packages/domain/src/private-capture.ts` defines explicit consent/policy,
  immutable subject, versioned manifest, chunk, committed ACK and gap schemas.
- `packages/process-utils/src/private-capture-files.ts` confines POSIX private
  roots, uses owner-only directories/files, rejects symlink/hardlink sources,
  bounds file reads, checks stable snapshots, uses atomic writes and fsync, and
  preserves a 64 MiB free-disk reserve before writes.
- `apps/server/src/services/private-captures.ts` owns current context/project
  authorization, actual frozen thread/account/runtime checks, manifest/index
  reservations, chunk integrity and committed receipts, source ingestion,
  retention, bounded flushes and expiry/shutdown IO fencing.
- `apps/host-daemon/src/private-capture.ts` owns the host-local private data
  outbox, source cursors, admission lease, persisted ACKs and periodic scanning.
  Collection does not begin until an explicit registration is delivered. Existing
  provider recorders are neither enabled nor reconfigured by registration.
- `apps/server/src/routes/private-captures.ts` and the shared server contract
  expose create/list/get/stop/sync, owner-association links, manifest staging,
  chunk receipt, artifact listing/metadata, preview and full download.
- `sdk.experimental_privateCaptures`, `bb captures` and the Thread Info private
  capture drawer use those same routes. The shipped thread-inspection guide,
  command index, JSON shapes, Plugin Guide and experimental API audit describe
  the public surfaces. The drawer uses the existing persistent responsive shell.

## Identity, permissions and provenance

A capture UUID is an explicit logical identity. Its project/context/host,
thread/run/native-session, runtime/version, model-connection and configured-model
subject is immutable. Thread captures must match the actual Core project and
frozen execution context/account/runtime and delivery host. A supplied run/native
session pair must exist together in actual Core events. CPA and bridge capture
cannot be asserted to have per-run/native-session correlation when only thread
ownership is available; such registration is refused rather than guessed.

Standalone registration has `threadId: null`, no asserted Core run or model
connection, and its own UUID. Owner-reviewed evidence can later be associated
with an actual same-project, same-context thread/run using `link`. This is a
bounded, idempotent owner association for navigation; it does not rewrite origin
or prove native execution provenance. Cross-context association is refused.

Current context enablement/project membership and actual thread binding are
checked at admission, reads and delivery. Preview/download recheck access around
file IO; download also checks each chunk hash. Scope is not inferred from paths,
timestamps, project labels, another account or a successful model request.
These are guards on the existing owner-authenticated Core API, not a new
per-agent/per-user ACL or a claim of regulatory authorization. Explicit Work
export permission, encrypted disks and an approved encrypted transport remain
operator prerequisites. A Personal model payer never converts Work data into
Personal data. Owner imports are explicit owner assertions, not attested origin.

Manifest source host/run/native-session IDs are separate from the selected
capture subject and nullable when not observed. Native events preserve actual
Core turn/provider-session IDs and a resolvable event-environment host. CPA
retained files have no invented run/session/host association. Bridge/export
host attribution identifies the enrolled machine that supplied the file, not
an inferred original network endpoint. Model labels are parsed source-reported
labels, not billing, routing or availability certification. The index contains
at most 32 labels/destinations; a bound is exposed by `indexLimited`, never by
truncating the stored source body.

## Actual ingestion and remaining coverage gaps

| Source | Real seam used | Boundary |
| --- | --- | --- |
| Retained CPA files | `services/gateway-logs.ts`, selected via the frozen endpoint and `BB_CPA_LOG_DIRS` | Existing confined read-only root and exact inbound BB thread-header ownership. Stable, settled whole-file snapshots are read and redacted. Source-file bytes are not proof of lossless network/SSE capture, retry accounting or per-run correlation. Original CPA source retention is not changed. |
| Existing bridge recorder | `packages/provider-bridge-protocol/src/bridge-kit/bridge-recorder.ts`; host reader of runtime/provider direction NDJSON | Only an already-enabled owner-private host/thread recorder root. Process-wide unknown-scope lanes are excluded. Bounded complete-line snapshots retain original process run/sequence inside the evidence. Missing, oversized or unterminated lanes remain gaps; recorder append failures are not retroactively repaired. |
| Actual Core native events | SQLite events plus the existing retained-output hydration functions | Available normalized messages, tools, approvals/results and retained outputs are archived. Oversized/unhydratable output and retained truncation are explicit gaps. This is normalized evidence, not an independent raw network or stdio-MCP tap. |
| Explicit host exports | Existing thread-storage root, or standalone `private-capture-input/<captureId>`, with owner-registered relative paths | Stable owned private regular files only. Raw text/transcript/binary representation is explicit; no auth home, arbitrary-root discovery or timestamp matching. Supplied evidence retains `owner-import` provenance. |
| Explicit SDK/CLI/UI import | Reviewed Blob/private invoking-machine file through shared redaction, manifest, chunk and ACK routes | No browser payload outbox. Retrying identical evidence resumes committed chunks; binary requires owner review. This does not instrument the originating terminal/process. |

Native transcript discovery, terminal/cmux/tmux automatic capture, independent
local-tool/MCP I/O, bypass HTTP/3/gRPC/WebSocket traffic, pinning/application
encryption, provider-internal retries and unavailable provider reasoning remain
uninstrumented or unsupported unless a real source supplies evidence. Tool
schemas or replayed tool results in CPA requests do not prove independent tool
execution. `captured` means retained evidence exists for that source, not that
all its channels are complete. Empty indexes/unknown backlog are not zero
activity or full coverage. Existing gateway coverage/manifest inspection remains
separate and cannot certify the new delivery chain.

## Bytes, privacy, ACKs and resource limits

Core bytes live under `<dataDir>/private-capture/core/<scope-digest>/<captureId>/`
and artifact directories. Host bytes/ACKs/cursors live under
`<dataDir>/private-capture/host/<captureId>/`. SQLite stores private metadata,
immutable manifests and committed receipts, not body blobs. These paths are
application data and must be outside Git, CI artifacts, analytics and ordinary
diagnostic logs. Existing provider source files have their own separate policy.

Known HTTP/JSON credential forms, bearer/basic values and token query values are
redacted; PEM private keys are rejected. Complete JSON documents and individual
records are parsed before inspecting decoded keys, including Unicode-escaped
credential names and nested JSON strings. A 64-level structured-redaction bound
fails explicitly rather than bypassing the redactor. Invalid UTF-8 text is a
source gap; opaque binary requires owner review and the host rejects recognized
private-key markers before publishing any outbox payload. This is not universal
secret detection: payload secret absence remains `not-guaranteed`.

Core audits owner-import completion across chunk boundaries. Privacy-denied
artifacts retain a rejection record, deny body access and purge Core staged
bytes. The existing authenticated `capture.exchange` command also accepts an
optional terminal `rejection`, bound to capture ID, artifact ID, stored hash and
the literal `privacy_rejected` reason. Absence means no rejection disposition.
The host validates it against the immutable manifest, durably records a private
rejection marker, and purges the artifact payload before continuing delivery.
Replays and recovery repeat cleanup; a rejected artifact is not a successful
ACK. A lost disposition is rediscovered from the still-pending host artifact and
Core's persisted rejection decision. Core cleanup failures do not erase that
decision; failed Core and host cleanup stays a visible failure/recovery gate.
Rejected metadata still consumes its bounded reservation until expiry.

Source and stored byte counts/SHA-256 are distinct. Redaction/normalization is
explicit; only unchanged source bytes receive `source-bytes` fidelity. Each
262144-byte chunk has sequence/size/hash and a deterministic receipt identity.
Core verifies and fsyncs private bytes before committing its SQLite chunk receipt;
ACK is returned only after that transaction boundary. Replays verify the retained
bytes and return the same receipt. Full artifact completion separately verifies
the assembled stored hash. The host persists matching committed ACKs before
removing acknowledged local chunks. Exchange and daemon recovery reconcile
already-persisted ACKs with leftover raw files before treating them as removed.
Only a recognized same-directory UUID `.pending` hardlink to the same owned
private inode may be normalized after interrupted publication; generic or
foreign hardlinks remain integrity failures. Full host artifacts have a durable
`ready` marker. Interrupted staging is validated/recovered, incomplete artifacts
remain private with an explicit gap, and a later complete artifact can proceed.
Missing/conflicting receipts do not permit raw deletion. These are source
corrections, not runtime proof of every crash boundary or power-loss durability.

Each artifact is at most 64 MiB; a capture reserves at most 256 MiB/512 artifacts.
Core has a 2 GiB/64-capture ceiling; the host has a 512 MiB retained-artifact-byte/
32-registration ceiling. Host accounting includes physical staged files and
metadata, including leftovers, rather than excluding ACKed-but-not-removed raw
files. Resumed writes reserve their missing bytes before publication. The policy
further bounds captures, source exports,
retention (1–720 hours), sync (30–3600 seconds) and offline admission lease
(30–3600 seconds, at least the sync interval). Disk pressure, source instability,
quota or inaccessible files produce explicit gaps/backpressure, not hidden
sampling, smaller-body success or a normal-log fallback.

The existing Core periodic sweep performs bounded flushes and expiry cleanup;
manual sync flushes one bounded batch, not an unbounded catch-up job. The host
uses its existing daemon lifecycle for 30-second private-outbox ticks. A lease
permits bounded local collection during disconnection; expiry stops collection
without pretending an ACK occurred. Stop immediately denies new Core intake;
a disconnected host stops by its lease, while unacknowledged local data remains
subject to retention. Stop does not disable independent provider recorders.
Host raw copies are removed at expiry without making deletion conditional on
decoding artifact manifests/ACKs or successfully reading/writing mutable state.
Each registration has an isolated sweep failure boundary, so corrupt metadata
or a denied write in one does not starve another's retention. Unreadable immutable
session grants cannot supply an invented expiry; they remain explicit failures.
Bounded host metadata receipts may remain for a further 24 hours and count
against registration capacity. Core expired records/bytes are pruned. Deletion
by retention is not delivery. Dropped-byte figures are known counts only; corrupt
metadata makes accounting incomplete rather than proving zero loss. Status is
the last reported snapshot, not a live observation during outage. Clocks, leases,
shutdown and recovery ordering still require parent qualification.

Preview is explicitly bounded and marked truncated/base64 as appropriate. Full
SDK download verifies the whole stored checksum; CLI writes a new mode-0600 file
and never defaults to body stdout. Explicit previews must not be run against
real payloads in CI or agent/tool transcripts. CLI input errors are generic and
do not forward private paths or malformed policy snippets to diagnostics.

## Native source38 integration and ordered parent composition

No alternative analytics service/schema/store is introduced. Consumers call the
existing `experimental_productAnalyticsRequestInit` and forward the existing
actor/surface/mode/QA/session/project context. Capture/create, import and link use
opaque logical operation UUIDs retained on retry, never payload hashes. Automatic
polls, intermediate chunk transport and upload reconciliation are observations,
not new feature-use intents. Source38's existing catalog discovers declared
public routes as `core.privateCaptures` actions; its existing server middleware
is the admission/result authority. Create/stop/staging are bounded admissions,
not claims of full-capture or downstream/client-save completion. Raw delivery
ACKs and feature analytics are separate contracts.

The isolated checkout intentionally does not copy the parent source38 analytics
implementation. Ordered integration must provide its SDK helper, shared header
contracts, UI provenance helper and native server/CLI metadata plumbing. The
actual existing parent helper/catalog/result contracts were read; no new tracker
or made-up feature ID is needed. Parent must prove native metadata admission,
retry dedupe, completion authority, QA exclusion and that no payload, path,
header, prompt, tool argument, credential or payload hash reaches analytics.

Migration `0147_private_capture.sql` and its Drizzle-generated snapshot are
reserved for these four private-capture tables. They were generated from this
isolated checkout's 0145 schema. Parent owns 0146: after composing its immutable
source38 schema/migration, regenerate/rebase the 0147 snapshot against the
combined schema with Drizzle; never hand-edit snapshot JSON or lose parent
analytics tables. The reserved journal index is 147, not an invented 0146 entry.
Host protocol is 245, reserved after parent's source40 protocol 244; parent must
compose the native host wire changes and qualify/update enrolled machines before
using the new required manifest fields. No old-host compatibility is claimed.

## Stopped verification and remaining parent proof

Parent integrated corrective source `534a3d8` in Main `71033a2`, with the real
source38 integration, both Drizzle 0146/0147 journal entries and protocol 245;
no activation was reported. Parent's unchanged after results were Domain 8 PASS,
private FS 3 PASS, host 8 PASS, and Core/CPA 7 PASS / 1 FAIL. Evidence:
`/tmp/bbdev44-ui-qa-Qz0y2M/artifacts/capture33-534a3d8-after.log`.
The failing consumer was `propagates a Core privacy rejection to the real host
and permits the next artifact to commit`, ending with `Private capture
artifact_not_found.` Both restarted ancestor/receipt fixture cases passed in
that run; these are not power-loss or ancestor-fsync-ordering proofs.

Static diagnosis: `capture.exchange` already has its command and result schemas
in the online RPC registry, but was missing from the successful response union
in `packages/host-daemon-contract/src/session.ts`. The authored real-host peer
parses that union and converts parse failures into RPC failures, preventing Core
from receiving the artifact. The narrow amendment adds only
`onlineRpcResponseSuccessSchemaFor("capture.exchange")` to the existing union.
It completes the unactivated protocol-245 contract without changing payload
fields, assertions, fixtures, controls, committed ACKs or durable privacy
disposition/cleanup. The amendment has not been executed or qualified here.

This agent has run no build, typecheck, test, lint, formatter, install, runtime
smoke, browser, network/model/auth/business probe or capture activation for this
amendment. Parent's results are accepted without rerunning them. There is no
after-pass, READY or full-acceptance claim for the amendment. Parent separately
owns Drizzle 0147 snapshot composition, including 0146 analytics and `prevId`;
that composition is not changed here. Full Tasks acceptance and its native,
offline-ACK and privacy matrix remain unchanged.

After ordered source38/source40 integration and source review, parent owns:

1. Native source gates and synthetic actual Core/CLI/SDK/UI execution, including
   desktop/compact drawer realization, no app-root inertness, and iOS Safari.
2. Real SQLite/file commit and lost-ACK/crash/restart/reconnect proof; duplicate,
   conflict, reordered/chunk-boundary, corrupt-state, missing-file, interrupted
   and large/binary behavior; no deletion before valid ACK except explicit
   privacy rejection or retention.
3. Actual context/project/account/host/run isolation, revoked permission between
   read and delivery, Work data with a Personal payer, denied cross-context links,
   owner export policy, encrypted storage/transport and absence of raw/credential
   leakage into diagnostics, analytics, Git or CI.
4. Offline leases, collector/daemon shutdown/restart, finite quotas, free-disk
   pressure, late/expired registrations, retention and bounded tombstone cleanup,
   plus measured CPU/RAM/disk/latency overhead without changing request streaming.
5. The complete owned OMP/native Claude/Codex, macOS/Linux, BB and standalone
   matrix with exact runtime/version/context/account/model identity, unrelated
   process exclusion, raw request/response/SSE cancellation/retry facts and
   independent tool/MCP/bypass coverage. Missing real source/machine/auth/export
   prerequisites stay explicit; no timestamp, normalized event or CPA success
   substitutes for them.

Full raw-body/stream/tool/MCP/bypass/standalone/offline-ACK/privacy acceptance
remains full. Unsupported/uninstrumented channels are visible gaps, not a reduced
acceptance contract or permission to enable MITM/CA/capture or probe real data.
