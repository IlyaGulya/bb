# BBDEV-33 private capture source checkpoint

This is an unqualified source checkpoint, not full-capture implementation,
activation, deployment, task completion or human acceptance. The complete
BBDEV-33 contract remains required. The immutable execution context and model
connection stay independent; model payer identity never selects data scope.
No global runtime, SDK installation, defaults, auth, CA or service is changed.

## Implemented read-only inspection contract

The existing gateway-log routes now expose:

- `GET /api/v1/gateway-logs/coverage?threadId=...`: frozen context/connection
  references and source-contract gaps. No raw file/body is read by this route.
  Missing context is null rather than inferred. Configuration is not capture
  evidence. The report is explicitly `source-contract-only`.
- `GET /api/v1/gateway-logs/:logId/manifest?threadId=...`: the SHA-256 and byte
  count of the entire retained CPA file. It uses the existing confined Linux
  read-only-root and exact inbound thread-header ownership boundary, checks
  file identity/size/timestamps before and after hashing, reads in bounded
  blocks and refuses an unstable file. Completeness/redaction are unverified
  and `deliveryAck` is null. Neither file age nor checksum proves source
  finalization, every streamed chunk or server-acknowledged offline delivery.

The existing SDK `experimental_gatewayLogs`, CLI `gateway-logs coverage` and
`gateway-logs manifest`, and Thread Info request-log drawer all use this same
backend. Existing list/read/full-download behavior remains separate. Hashing
is explicit, not automatically repeated with the directory preview. No raw
store, event outbox, capture loop or new process is introduced by this patch.

## Actual inspected source seams

| Source | Actual seam | Capability and boundary |
| --- | --- | --- |
| Native CPA request logs | `apps/server/src/services/gateway-logs.ts`; endpoint selection in `apps/server/src/routes/gateway-logs.ts` | Confined retained-file list/preview/download and full-file hash. Only the frozen CPA endpoint and exact inbound BB thread header associate a file. No per-run ACL, universal redaction, lossless stream claim or raw-delivery ACK. |
| Provider bridge recorder | `packages/provider-bridge-protocol/src/bridge-kit/bridge-recorder.ts` | Existing explicit host-local opt-in. Runtime/provider directions, process run and sequence in NDJSON. Process-wide records can have no thread. Appends are not a durable server outbox; oversized partial lines and append errors prevent a lossless claim. No recorder is enabled or changed here. |
| Recorder reader | `packages/provider-bridge-protocol/src/testing/recording.ts` | Existing replay/fixture lane reader. A test fixture parser is not a production authenticated raw ingestion interface. |
| Provider-normalized thread events | `apps/host-daemon/src/event-sink.ts`; `apps/server/src/internal/events.ts` | Actual event post, retry and server transaction/accepted-event response. The client queue is in memory and disposal clears it. Those ACKs concern normalized events, not raw files. This is not restart-safe raw-body delivery. |
| Native session data | Existing provider bridge/session implementations under `plugins/provider-claude-code/src/bridge`, `plugins/provider-codex/src/bridge`, `plugins/provider-pi/src/bridge` | Provider-owned session/reopen and reported tool events are distinct from raw network facts. No auth home, native transcript or standalone process is scanned/imported by this patch. |
| Project attachment storage | Existing `apps/server/src/routes/projects.ts` attachment endpoints | Existing project file upload is not automatically a private capture ledger: its scope, access, retention and ACK semantics cannot be substituted for the full raw-capture contract. It is not repurposed silently. |

The full `bb tasks show BBDEV-33` description and comments, plus BBDEV-6 CPA
integration receipts and BBDEV-38 contract/comments were read. Earlier CPA
qualification in those receipts is historical evidence, not a new runtime
observation. Task attachment names were seen; raw attachments/logs, credentials
and external source URLs were not fetched or copied.

## Coverage and privacy boundary

The response exposes separate CPA, bridge recorder, native normalized events,
native transcript, bypass network, standalone, stdio MCP and local-tool rows.
A configured CPA mount is not promoted to `captured`; normalized events/tools
are `metadata-only` relative to the full raw contract. The other independent
sources remain explicitly uninstrumented, or CPA is unsupported when there is
no compatible frozen gateway binding. These labels describe inspected source
contracts, not observed host/runtime/version/transport qualification.

Schema/tool metadata or replayed results in a model request do not prove that a
local tool or MCP call was made or that raw stdio I/O was captured. Unknown
raw backlog bytes/events, last-sync and last-ACK remain null. Work-context data
with a Personal payer still belongs to Work context. The existing owner API
is identified honestly; this patch adds no per-context/per-run ACL and does
not certify privacy isolation. Source-owned retention and unverified redaction
are visible; no auth headers, tokens or CA keys are copied for this work.

## Contract checkpoint needed before integration

The authorized isolated checkout has no source38 analytics implementation or
API manifest. Parent must provide the immutable source38 checkpoint and the
existing API's module/symbol, declaration identity, context/actor/surface/QA
provenance, completion authority, bounded outcomes and operation/dedupe rules.
No alternative tracker or invented analytics contract is installed. Analytics
must receive only allowlisted feature metadata, never raw capture payloads,
paths, request headers, prompts, tool arguments or credentials.

That safe analytics checkpoint is not a raw-body backend. A raw ingestion
binding separately requires the actual existing permitted durable raw store,
node/source admission and context permission interface, manifest/chunk ACK and
retention/quota contract. The inspected CPA files, bridge recorder, normalized
event sink and attachment API do not establish that interface. There is no
fictional collector, fallback ACK, new queue or supervisor in this checkpoint.
These missing interfaces must be resolved rather than reducing the acceptance
contract to this report or treating metadata-only paths as full capture.

## Full contract still requiring implementation and parent proof

- Explicit per-process/per-source opt-in/off with immutable host/runtime/version,
  context/account/model and task/project/thread/run/native-session/capture IDs;
  standalone identity and subsequent explicit authorized binding.
- Private raw-body/large-body/binary storage outside the index; safe boundary
  redaction, redaction/truncation/gap markers, source/stored checksums and
  authenticated inspect/download, with enforceable Work/Personal permissions,
  retention, quotas and encrypted storage/transport.
- Real ingestion from the existing CPA/bridge/native sources, stable chunk/event
  identities and sequence, persisted receipt/index/ACK/dedupe, restart-safe
  offline accumulation and periodic/manual flush through the existing delivery
  infrastructure, without a second runnable queue or recording service.
- Measured raw request/response and SSE/WebSocket/cancellation/retry coverage,
  independent tool/MCP I/O/approvals and bypass transport facts. Pinning,
  application encryption, HTTP/3/gRPC and inaccessible provider reasoning remain
  explicit limitations, never hidden bypasses.
- Full owned OMP/native Claude/Codex, macOS/Linux and BB/standalone matrix;
  unrelated-process exclusion, no model/account substitution, shutdown behavior,
  disk pressure, collector restart/reconnect, logical dedupe and access/privacy.
- Task/thread navigation, full source filters and safe source38 feature analytics
  through actual Core/CLI/SDK/UI consumers after the agreed contracts are bound.

No build, test, typecheck, lint, formatter, install, runtime smoke, browser,
network/model/auth/business probe or capture activation was run for this source
checkpoint. The added synthetic retained-file test is authored only, not a
passing-test claim. Parent owns qualification/review after freeze, including
full-file mutation/ownership tests and actual UI/CLI/SDK exercise; the original
full-capture acceptance cannot be met by these inspection checks alone.
