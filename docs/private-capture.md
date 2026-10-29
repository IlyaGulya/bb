# BBDEV-33 CPA-only source handoff

This is source-only, unactivated work in the original isolated checkout. The
existing CLIProxyAPI/CPA is the only network capture/data path. No new proxy,
network observer, CA/trust path, proxy environment override, Python dependency,
standalone wrapper, native hook installer or process-launch override remains.
No runtime/auth/model/provider/account/default/backups/Slack setting was changed.
The exact bound Personal Sol6.1/high/full/context/account is not substituted;
model payer never changes the immutable data scope.

## Frozen discarded evidence and integration boundary

`bd53c00` is preserved at `refs/bb-evidence/bbdev33-bd53c00`, with its original
stopped receipt. It is discarded-plan evidence, not an integration prerequisite.
Do not cherry-pick it wholesale. The source handoff identifies a separate CPA-only
integration commit based on `bd53c00^`, so parent can take applicable encryption
and CPA changes without introducing the discarded implementation in Main.

The removed additions are the process policy/evidence/status schemas, runner and
Python dependency, process/MCP/hook CLI preparation, native launch substitutions,
CA/trust/proxy configuration and their dedicated task/project/tests. The one
interrupted-prefix cipher test was tied solely to the removed open process spool;
managed body files now always require an authenticated terminal frame. Existing
Core/host privacy, receipt/replay, retention and filesystem assertions remain.

## Actual CPA contracts inspected

The source evidence read for this cutover is:

- `apps/server/src/services/gateway-logs.ts`: native file list, bounded complete
  `captureGatewayLogSource`, whole-file SHA-256 manifest and exact inbound header
  parsing; no network transport is created here.
- `apps/server/src/services/gateway-log-directory.ts`: `BB_CPA_LOG_DIRS` mapping
  selected by the frozen connection endpoint, never by a different payer/root.
- `apps/server/test/services/gateway-logs.test.ts`: existing synthetic CPA 8.0.44
  format contains REQUEST INFO, HEADERS, REQUEST BODY, API REQUEST, API RESPONSE
  and RESPONSE sections. Assertions cover exact case-insensitive header names,
  duplicate/foreign/body-spoofed headers, endpoint isolation, symlinks, settling,
  full bytes beyond preview limits and binary-tail whole-file hashing.
- `apps/server/test/services/gateway-logs-capture-bounds.test.ts`: existing complete
  source/budget/growth assertions; admitted source bytes are not a preview.
- `tests/integration/private-capture/cpa.test.ts`: authored CPA file-to-Core cases
  using those existing seams, a real migrated DB and encrypted files. This is a
  synthetic retained-file fixture, not a replacement CPA service or live proof.

These contracts justify preserving every admitted native file section, not
assuming model-request-only logging. They do not establish that CPA lacks SSE,
WebSocket, HTTP/3, gRPC, reasoning, tool/MCP or standalone coverage. Source
coverage now distinguishes reader evidence from CPA capability: no new native
semantic instrumentation is justified or added by this cutover. Existing optional
Core events, already-enabled bridge lanes and reviewed imports remain separately
labelled semantic/supplied evidence, not proof of an omission from CPA.

A live logger's completion/correlation/transport behavior is owned by the existing
CPA deployment and its native logger version/artifacts. Its implementation and
owned runtime receipts are not supplied in this checkout. Parent must use that
owner's actual artifacts before claiming completeness or a gap. No substitute
service, instrumentation plan or inferred protocol support is introduced.

## CPA-only acceptance contract

1. **Identity and authorization.** Explicit UUID, actual Core project, enabled
   execution context, selected execution host and frozen thread/model-connection
   binding. Current scope is rechecked at admission, delivery, preview/download
   and around asynchronous IO. Work data stays Work with a Personal model payer.
2. **CPA source selection.** `cpaLogs: true` requires the actual Core thread.
   `listGatewayLogs`/`captureGatewayLogSource` use its frozen endpoint mapping and
   exact inbound `x-bb-thread-id`; no path/time/account-based association or guard
   weakening. Per-run/native-session CPA correlation is not invented. Standalone
   automatic ingestion requires evidence of the existing CPA correlation contract;
   an owner navigation link alone is not execution provenance.
3. **Complete admitted bytes.** Read only canonical finalized/settled native files
   through the existing Linux read-only CPA mount. Read exactly the inspected
   size within 64 MiB, recheck stable file identity/size/times, and reject growth,
   instability or oversize instead of truncating. Preserve the complete request,
   upstream, response, tool/result and stream text actually present in the file.
4. **Private content and fidelity.** Preserve exact approved source bytes, including
   header credentials, nested JSON, binary bytes and private-key content. No
   automatic redaction, secret-based rejection, cleaning toggle or assembled-body
   secret audit remains. Fresh manifests are version 2 / `source-preserved-v2`,
   with equal source/stored sizes and SHA-256. Native normalized events remain
   honestly normalized. Bodies never enter diagnostics, Git, CI or analytics.
   Historical version-1 artifacts retain their original bytes, labels and IDs;
   they are read-only, are not relabelled as original, and do not qualify fresh
   coverage. Their old CPA completion stamps cannot skip a fresh raw capture.
5. **Durable delivery.** Deterministic immutable manifest and contiguous 262144-byte
   chunks. Authenticate/encrypt and fsync body files plus every ancestor-directory
   entry through the canonical data root before SQLite receipt commit; retry also
   syncs retained file entries. This is not an executed power-loss qualification.
   ACK identity describes plaintext chunk size/hash and the committed receipt;
   full artifact completion separately verifies its stored plaintext SHA-256.
   Duplicate delivery verifies retained bytes and reuses the committed receipt.
6. **Replay and failure.** CPA stamps are skipped only when the referenced artifact
   completed under manifest version 2. A partial write/lost stamp is re-admitted
   through the same manifest
   and receipts, not silently skipped. Missing/corrupt bytes are failures. Recovered
   sync clears the current error without erasing cumulative gap counts. No success
   is inferred from an empty index, mapped root or absent activity.
7. **Bounded storage and retention.** At most 64 MiB/artifact, 256 MiB/512 artifacts
   per capture, 64 Core registrations and 2 GiB Core plaintext reservation plus
   bounded ciphertext framing overhead. Existing host optional-data outbox has
   a 512 MiB physical ceiling/32 registrations, leases and private retention.
   Admission reserves growing ACK metadata plus its atomic replacement alongside
   ciphertext; ACK publication also checks actual retained outbox bytes before
   writing. Quota failure retains the unacknowledged ciphertext for safe retry.
   Sync processes at most eight new CPA artifacts per call; existing periodic Core
   sweep performs later batches. Disk pressure/source errors remain explicit.
8. **Original CPA durability.** CPA owns original file retention, offline capture,
   finalization and rotation. BB does not delete or reconfigure those files, nor
   send an invented native CPA deletion ACK. Parent must prove original retention
   exceeds outages and drain time; Core receipts certify only committed BB bytes.
9. **Encryption and access.** Managed Node Core/optional-host body files are
   authenticated ciphertext; no plaintext fallback or filesystem-attestation flag.
   Existing authenticated owner routes plus per-scope checks are reused, not a
   stronger invented per-agent ACL. Approved transport and Work export permission
   remain prerequisites. Download authenticates/checks bounded chunks before
   releasing plaintext and rechecks current authorization.
   Download authenticates its first bounded chunk before constructing binary
   headers, so missing key access returns generic JSON `503
   capture_storage_unavailable`. Later chunks remain authenticated and scoped;
   failure after streaming starts terminates the stream, never emits plaintext
   fallback or buffers a whole artifact.
10. **Surfaces and meaning.** Existing Core routes, `sdk.experimental_privateCaptures`,
    `bb captures` and Thread Info drawer share creation/list/get/stop/sync, manifest,
    chunk/ACK, metadata, verified download and reviewed import paths. Stop denies
    new intake; it does not change CPA or another independent native recorder.
    `captured` means completed retained evidence, not full live channel qualification.

No activation, deployment, full completion, Done/Accept or human acceptance is
claimed. The full original acceptance remains required under the CPA-only design.

## Protected keys, applicable storage and unavailable prerequisites

`packages/process-utils/src/private-capture-crypto.ts` reuses Node AES-256-GCM and
existing private atomic-write/fsync primitives. HKDF-SHA256 derives role/capture/
immutable-subject keys; each bounded frame authenticates its role, scope, object,
sequence and length, with a random 96-bit nonce and authenticated terminal frame.
Moving/tampering/truncating ciphertext fails closed. Hashes, exact source-byte
fidelity, receipts and full download checksum remain plaintext contracts.

- `BB_PRIVATE_CAPTURE_CORE_KEY_REF`: Core owner must supply a dedicated protected
  key reference for CPA ingestion/reads/replay. No host key is needed for CPA-only
  Core ingestion.
- `BB_PRIVATE_CAPTURE_HOST_KEY_REF`: separate enrolled host owner supplies this
  only when optional host semantic/export data is actually collected.
- Mac reference `keychain:<service>:<account>`: existing dedicated generic password
  with 32 random bytes encoded as 64 hex digits. No browser/provider secret is
  borrowed and no item is created. OS approval/restoration is operator-owned.
- Linux reference `memory-file:/absolute/path`: existing canonical owner-only,
  single-link regular key file on ramfs, or tmpfs with no active swap. Ordinary
  ext4/LVM or adjacent disk keys are refused. Key provisioning/restoration from
  the operator's protected store remains external; no key is auto-generated.

The existing machine-environment adjacent key and secret-plugin dotenv files do
not meet this requirement on an unencrypted disk and are not reused as capture
masters. Internal data-dir/role-scoped resident key providers let isolated Node
fixtures use actual random in-memory keys; they prove no OS-store restoration.
Keys/references are separate from public capture policy and immutable data scope;
key bytes never enter RPC/SQLite/manifests/analytics. Keep the same material across
restart for every pending/retained ciphertext. No online rotation/lost-key fallback
is implemented. Missing key access refuses body storage/read.

Parent confirms Personal Mac FileVault is on. Linux Core/root ext4/LVM has no
verified at-rest encryption; 0600 is not encryption. Applicable Node body storage
is encrypted by this source, but existing original CPA logs/native events/index
metadata and intentional downloads require their own proven protection. No CA,
runner-specific key, ephemeral-runner directory or Python prerequisite remains.

Exact unsupplied/unqualified values and owners:

| Value/evidence | Existing owner/value source |
| --- | --- |
| Core protected key reference and restored master | Core service operator's dedicated key store and `BB_PRIVATE_CAPTURE_CORE_KEY_REF`; no value was fetched or provisioned here. |
| Optional host key | Only the separately enrolled semantic/export host's protected store and `BB_PRIVATE_CAPTURE_HOST_KEY_REF`. |
| Endpoint-to-read-only-root mapping | Existing Core deployment `BB_CPA_LOG_DIRS`, selected by actual frozen `modelConnection.gateway.baseUrl`; never guessed or set globally here. |
| Finalization, rotation, offline horizon, native transport and standalone correlation | Existing deployed CPA/native logger version/configuration and owned request artifacts; no replacement daemon/service or new header bypass. |
| Test project/context/host/thread/model/account values | Parent's existing owned QA thread, its frozen Core binding and execution host; not the source writer's model login. |
| Source38/migration/host composition | Parent's existing analytics contracts and ordered 0146/0147 Drizzle composition; protocol 249 admits version-2 exact-byte manifests and removes the old remote privacy-rejection command. No old-host/plaintext-store compatibility is claimed. |

## Parent-only qualification commands — not executed here

Run after parent composition in its owned QA environment; all output files must
be private, outside Git/ordinary CI logs. These commands select existing test
projects through Turbo and install/launch no second proxy:

```sh
pnpm exec turbo run test --filter=@bb/process-utils -- test/private-capture-crypto.test.ts test/private-capture-files.test.ts
pnpm exec turbo run test --filter=@bb/domain -- private-capture
pnpm exec turbo run test --filter=@bb/host-daemon -- test/private-capture.test.ts
pnpm exec turbo run test --filter=@bb/server -- test/services/gateway-logs.test.ts test/services/gateway-logs-capture-bounds.test.ts
pnpm exec turbo run test --filter=@bb/integration-tests -- '--project=@bb/integration-tests:private-capture*' private-capture/
```

The final command includes real Core/SDK/host consumer cases, focused storage
failure boundaries and synthetic CPA-to-Core cases. They assert exact multichunk
bytes (including credentials/tool/SSE/upstream/tail text), correct endpoint/header
ownership, ciphertext storage, unchanged CPA source, committed replay, historical
stamp separation, unsettled-source recovery and current-scope denial of output.
It uses a real migrated database, no database mock or provider/network substitute.
Fixture resident keys do not qualify the real operator key store.

For real-owned-CPA qualification, parent supplies these values from the owners
above, not defaults invented by this feature:
`CPA_THREAD_ID`, `CPA_PROJECT_ID`, `CPA_CONTEXT_ID`, `CPA_CAPTURE_ID`,
`CPA_POLICY_FILE` (reviewed CaptureCreate JSON using those exact frozen values),
`CPA_QA_OUT` (approved encrypted private synthetic-only output directory),
`CPA_LOG_ID` and `CPA_ARTIFACT_ID` (the exact entries emitted by list/index).
The policy selects `cpaLogs: true`, no other collector, and explicit reviewed
retention/quotas. The existing Core QA service must already have its read-only
CPA mapping and protected Core key. Do not reconfigure global auth or route a
different account/model. In the parent-owned CLI/session only:

```sh
umask 077
bb thread show "$CPA_THREAD_ID" --json
bb gateway-logs coverage --thread "$CPA_THREAD_ID" --json
bb captures create --file "$CPA_POLICY_FILE" --json
bb thread tell "$CPA_THREAD_ID" 'Return exactly SYNTHETIC_CPA_BBDEV33_OK. Do not use tools.' --mode auto --json
bb thread wait "$CPA_THREAD_ID" --status idle --timeout 2m
sleep 3
bb gateway-logs list --thread "$CPA_THREAD_ID" --json
bb gateway-logs manifest "$CPA_LOG_ID" --thread "$CPA_THREAD_ID" --json
bb captures sync "$CPA_CAPTURE_ID" --project "$CPA_PROJECT_ID" --context "$CPA_CONTEXT_ID" --json
bb captures artifacts "$CPA_CAPTURE_ID" --project "$CPA_PROJECT_ID" --context "$CPA_CONTEXT_ID" --source cpa-request-log --json
bb captures inspect "$CPA_CAPTURE_ID" "$CPA_ARTIFACT_ID" --project "$CPA_PROJECT_ID" --context "$CPA_CONTEXT_ID" --json
bb captures download "$CPA_CAPTURE_ID" "$CPA_ARTIFACT_ID" --project "$CPA_PROJECT_ID" --context "$CPA_CONTEXT_ID" --output "$CPA_QA_OUT/stored-cpa.body" --json
sha256sum "$CPA_QA_OUT/stored-cpa.body"
bb captures sync "$CPA_CAPTURE_ID" --project "$CPA_PROJECT_ID" --context "$CPA_CONTEXT_ID" --json
bb captures show "$CPA_CAPTURE_ID" --project "$CPA_PROJECT_ID" --context "$CPA_CONTEXT_ID" --json
```

Select the exact log/artifact IDs from the preceding metadata results before
running their commands; never choose another thread/root to make the gate pass.
Compare native manifest SHA/size with private manifest source SHA/size and the
saved download hash with stored SHA. Replayed sync must not add duplicate
committed chunks/artifacts or a new receipt for identical bytes. No raw preview
or native full-log download is needed. The tell uses the already-bound model/
reasoning/account with no override; it is a parent-only synthetic owned request,
not permission for this source writer to make one.

Parent additionally owns actual key-backed restart/restore, source/Core outage
and drain, lost-ACK/crash/fsync boundaries, tamper/quotas/retention, revoked
scope/Work-Personal isolation, secret absence in ordinary logs/analytics, existing
Core/CLI/SDK/UI and desktop/compact/iOS proof. Apply the same existing CPA path to
its full owned OMP/Claude/Codex × BB/standalone × Linux/Mac matrix. A transport/
semantic omission may be declared only from actual CPA artifacts/contracts; a
missing correlation value is not permission to add a wrapper or another proxy.
No real business payload, raw credential or live source43 is used by this work.

## Earlier parent evidence retained

Parent reported Domain 8 PASS, private filesystem 3 PASS, host 8 PASS and Core/CPA
7 PASS / 1 FAIL for earlier `534a3d8` in Main `71033a2`, with the real source38
composition. The failing real-host privacy consumer was diagnosed at the host RPC
success union; parent then reported Main `3631086` passed all five unchanged Core
privacy/receipt cases. The later compiler/placement amendment moved that complete
suite to the existing integration project without weakening assertions or changing
Server's compiler root. These are historical parent reports, not after-results for
this CPA-only/encryption source. They were not rerun or recharacterized as power-loss
or ancestor-fsync-order proof.

No check, build, test, formatter, runtime/browser/network/model/auth probe,
activation, install or nested actor was invoked for this cutover. Static source/
contract inspection and explicit Git evidence preservation/commits are the only
non-edit operations. Parent owns all qualification and Main UI/import/runtime
integration independently; this handoff does not mark the task Done or Accepted.

## Raw-preserving frozen candidate and focused BEFORE/AFTER gates

The source baseline before this amendment is
`bc03b043a4c27f59c54766cab6d22a26f92f1b68`. The final handoff supplies the AFTER
commit. This checkout authors source and regressions only: none of the commands
below was executed here. No prior PASS result qualifies this candidate.

For focused BEFORE proof, parent supplies a separate disposable checkout already
at that exact baseline as `RAW_BEFORE_ROOT`, and the integrated final candidate
checkout as `RAW_AFTER_ROOT`. Keep the baseline's production code and capture
fixtures unchanged: only transplant these two regression files from the final
candidate. The final fixture helper uses v2 and must not be copied into BEFORE.
The regex restricts BEFORE to the independent storage failures; it does not run
the new raw-import cases against the old policy.

```sh
RAW_AFTER_COMMIT=$(git -C "$RAW_AFTER_ROOT" rev-parse HEAD)
git -C "$RAW_AFTER_ROOT" show "$RAW_AFTER_COMMIT:apps/host-daemon/test/private-capture.test.ts" > "$RAW_BEFORE_ROOT/apps/host-daemon/test/private-capture.test.ts"
git -C "$RAW_AFTER_ROOT" show "$RAW_AFTER_COMMIT:tests/integration/private-capture/storage-boundaries.test.ts" > "$RAW_BEFORE_ROOT/tests/integration/private-capture/storage-boundaries.test.ts"
```

Run from `RAW_BEFORE_ROOT`, keeping output in private parent-owned files:

```sh
pnpm exec turbo run test --filter=@bb/host-daemon -- test/private-capture.test.ts -t 'does not exceed physical quota'
pnpm exec turbo run test --filter=@bb/integration-tests -- '--project=@bb/integration-tests:private-capture*' private-capture/storage-boundaries.test.ts
```

Expected source-based BEFORE failures, not executed observations: the quota case
publishes a growing ACK file beyond the limit; ancestor-fsync fault cases can
commit receipts; the unavailable-key download returns binary headers before the
stream fails. Parent already reported the latter real-route socket reset; this
writer does not repeat the incident as a probe. The regressions require generic
503 without payload/key/path leakage, retained metadata and bounded streaming.

Run AFTER from the fully composed `RAW_AFTER_ROOT` with all final source and
fixtures, then perform the actual owned runtime/UI gates separately:

```sh
pnpm exec turbo run test --filter=@bb/domain -- private-capture
pnpm exec turbo run test --filter=@bb/process-utils -- test/private-capture-crypto.test.ts test/private-capture-files.test.ts
pnpm exec turbo run test --filter=@bb/host-daemon -- test/private-capture.test.ts
pnpm exec turbo run test --filter=@bb/integration-tests -- '--project=@bb/integration-tests:private-capture*' private-capture/
pnpm exec turbo run typecheck --filter=@bb/domain --filter=@bb/process-utils --filter=@bb/host-daemon-contract --filter=@bb/server-contract --filter=@bb/sdk --filter=@bb/host-daemon --filter=@bb/server --filter=@bb/cli --filter=@bb/app --filter=@bb/integration-tests
pnpm exec turbo run build:types --filter=@get-bb/plugin-sdk
```

Parent owns both the 390-width compact CSS correction (44px hit areas and
artifact-action wrapping) and actual built UI smoke. This checkout changes only
semantic capture copy, not `fieldClass`, root button sizing or action-group layout.
The two original rendered audits covered the old e4 layout/accessibility only;
their review is not final approval of this raw-preserving semantic candidate.

Parent also reported an original Codex native session with a null execution
context refused capture admission. This is a scope prerequisite, not evidence of
a CPA/model capability failure. The original session was not rebound, modified
or rerun here. A separate explicitly scoped owned QA session is parent-owned;
there is no default context, payer/account substitution or historical-scope repair.

Final review and full raw body/stream/tool/MCP/bypass/standalone/Work-Personal/
offline-ACK/privacy acceptance remain open. Use fresh actual native CPA artifacts
with byte-equal source/stored hashes, not old redacted artifacts or their stamps.
No activation, deployment, Done/Accept or live source43 action is authorized by
this handoff.
