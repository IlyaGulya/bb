# Private product analytics

BBDEV-38 / `agentos-nfa.24` adds owner-controlled feature metadata to the existing
BB server, database, HTTP/SDK/plugin entrypoints and client lifecycle. It does
not enable PostHog, modify anonymous vendor telemetry, install a payload proxy,
change a model/account binding, or grant business-tool access.

## Data and scope

The event boundary is a strict allowlist: stable feature/action/version,
operation UUID, logical scope, bounded actor/surface/mode/stage/outcome/error
codes, nullable pseudonymous actor-session UUID, timestamp and bounded duration.
The server supplies release and a private persisted instance identity. It hashes
actor sessions separately per instance and project before storing them.

Do not submit task, prompt, chat, Slack, Jira, provider or MCP content; commands
or arguments; filenames, paths, URLs or searches; headers, cookies, credentials;
arbitrary properties; or raw exception messages. A registered route template
or code-declared action is catalog metadata, not a captured request path.
The structured result observer reads only bounded success/failure/discriminator
signals before JSON serialization; it does not copy or parse response bodies.

Scope is one existing Core project, resolved from actual project/thread/
environment references or explicit Core project context, or instance-only
activity. Plugin-domain project identifiers are not Core project identifiers.
Missing plugin scope yields a visible instance-level diagnostic gap. Model
subscription/account names do not choose scope. There is no implicit
cross-project aggregate or new authorization model: the existing owner-facing
API gate still applies, and an absent/deleted project is not an available
report scope.

Request observation does not read or clone the incoming body. Scope selectors
are observed only when the guarded product consumer parses JSON; raw-body
handlers retain the original bytes. Actual project/thread/environment/terminal
ownership takes precedence over ambient client context. Explicit observe intent
does not become an attempt merely because the request uses POST or plugin RPC.
Queued delivery is accepted admission, and a stale-hash write conflict is a
failed conflict outcome rather than successful completion.

Shared browser RPC calls use the same app-surface request wrapper as the SDK.
The central TanStack mutation cache captures bounded provenance when a mutation
is built, before asynchronous `onMutate` preparation. Each mutation-function
attempt reuses that capture, including retries and observer option updates, so
a later view change cannot replace the originating project or operation UUID.
The binding is restored as soon as the mutation function returns its promise;
it is not left ambient while asynchronous work settles.

## Collection and delivery

The server appends validated events in an independent committed SQLite
transaction before acknowledging admission. It refuses to acknowledge an
uncommitted caller transaction. A periodic bounded projection makes admitted
rows reportable; the report computes targeted SQL aggregates for one scope and
mode rather than loading raw events into JavaScript.

Idempotency is the logical scope, operation, feature, action, semantic version
and stage. Changing a retry's QA mode cannot create a second logical action.
The first admitted lifecycle attribution remains authoritative for its paired
start/completion. An already committed replay remains a duplicate even after
its action declaration is retired; new retired-action events are rejected.
Receipt identity echoes the submitted scope/mode and logical operation so the
outbox can match its queued envelope; the report's stored plane is authoritative
for normalized QA attribution. A receipt's echoed production tag does not mean
a smoke/preview server stored production popularity.

Plugin declarations stay local to the candidate handle until activation.
Disposal retires only the declaration owned by that handle; a failed candidate
cannot replace the active generation's completion authority. Live framework
catalog reconciliation retires removed RPC/HTTP/CLI entries without deleting
their committed history or changing duplicate delivery receipts.

The browser uses IndexedDB and the shared SDK outbox. It retains pending
records across reload, retries after reconnect, checks per-stage receipt
identity, and retains missing/mismatched/retry receipts. An accepted or duplicate
receipt removes that queued record; a terminal rejection becomes a gap.

Bounds:

- Server: 30-day event retention, 100,000 events, 10,000 pending; project at most
  500 pending records per sweep. Instance identity and cumulative delivery
  counters are diagnostic state, not a retained payload/event history.
- Native and queued dispatch retain only validated QA modes under hashed
  pending-thread and queued-message keys in existing Core key-value storage.
  The two marker kinds share a 10,000-entry cap and 30-day expiry in the existing
  collector sweep. A queued marker is committed with its queue row; its mode is
  transferred to the pending-thread marker in the existing consumption/admission
  transaction, including the fast, hook-driven and provisioning paths. An
  admitted native start consumes the thread marker; paired completion uses the
  existing durable event attribution across restart. Consumed queue markers are
  retired. If existing business grouping combines modes, the first non-production
  mode wins and a gap is exposed, never production popularity for mixed QA work.
  Marker storage failure remains a visible gap and does not fail the primary
  dispatch. No request content, new queue or wire field is stored.
- Browser: 500 pending events, seven-day expiry, 50 events per batch, at most
  ten batches per flush. Reconnect and periodic delivery reuse the same outbox.
- Storage failures, projection failures, capacity limits, expiry, rejected
  declarations, missing scope and device loss can leave gaps. The primary
  product action is not rolled back or failed because collection failed.
- A process dying before admission, a lost device, or an unavailable local
  store can lose events. This is not an exactly-once or lossless guarantee.

`BB_PRODUCT_ANALYTICS_MODE` selects production, preview, smoke or test at the
server boundary. CLI requests also forward an explicit value from their process
environment, including MCP's inherited CLI environment. A non-production server
does not accept client production tags as production popularity. Reports keep
those planes separate. A test suite or replayed workload is not production demand.

MCP semantic search/read/run observers receive the original HTTP request from
the existing per-request server factory. They retain its bounded operation,
Core project, actor/session and QA metadata, and use the actual MCP surface.
Explicit observation intent is not counted as use. Requests without an explicit
project remain instance-scoped; the existing Core admission gate validates scope
and the complete event. No request body, tool arguments or results are copied
into analytics, and no shared mutable request context is introduced.

Authenticated native plugin tools bind deliberate agent intent, agent surface,
and the owning thread's actual Core project. Their QA mode is read from the
accepted root-turn start using the existing hashed operation identity and event
primary key; it is not selected from tool arguments, model accounts or an
unrelated process environment. The tool and its Core SDK child requests share
that operation context. Unrecorded/legacy turns use the instance plane; storage
lookup failure records a diagnostic gap without failing the primary tool.

## Coverage inventory

The report is the runtime matrix; labels, coverage, availability, limitations,
entrypoints and metrics are returned together. Instrumentation is not inferred
from a nonzero counter or the mere existence of an endpoint.

| Entry surface | Instrumented boundary | Meaning and limitations |
| --- | --- | --- |
| Core HTTP, SDK and CLI | Typed public route definitions plus the existing raw plugin/catalog/marketplace/install-job/skills-registry routes | Explicit read intent and mutations; bounded actual handler result, denial, failure, cancellation or asynchronous acceptance. Admission is not downstream job completion. |
| Unmapped runtime Core routes | Actual Hono registration inventory | A coverage gap with unknown availability, never fabricated zero popularity. |
| Bundled/installed/custom plugin RPC and HTTP | Live registered handlers, including unpublished RPC | Shared server outcome observation, not request payloads. Calls require an actual Core project context when scoped. |
| Plugin CLI | Declared command paths, not argv values | One logical invocation, stable action selection before positional arguments; source CLI/MCP/SDK provenance remains distinct. |
| Native plugin tools | Actual authenticated native tool execution | Deliberate agent result and bounded duration; Core SDK children share provenance and QA follows the recorded root turn. External business effects require their own completion declaration. |
| Plugin services and schedules | Shared service lifecycle and claimed schedule execution | System/background activity, separate from intentional human use and separately scoped Core child actions. |
| Native execution/provider | Accepted root-turn start/completion effects | Actual execution result; runtime system attribution is not inferred human/provider choice. Observed admission-to-completion time can include delivery delay. |
| Core UI | Workspace host acknowledgement, committed split/navigation state, palette opening and deferred command selection, settled intentional search, timeline expansion, interaction resolution, execution selection, attachment and voice lifecycle, appearance and onboarding | Initiating project/actor/QA metadata is captured before asynchronous work. Committed local state and returned asynchronous admission remain distinct from downstream completion. No search strings, selections, filenames, audio or transcript content are collected. |
| Registered local plugin controls | Shared slot callback invocation and committed component consumption | Code-declared `ui.plugin.<id>` / `slot.<kind>.<id>.run` or `.mount`; callback completion is local handler completion, not downstream business success. Mounts are unknown-actor observations, not registration, visibility or inferred clicks. Thread-owned components resolve the actual Core thread project. |
| Custom semantic plugin actions | Existing explicit private analytics declarations | Client-local versus server completion authority is explicit; plugin disposal retires availability. Component consumption does not imply coverage of every internal control. See the Plugin Guide. |
| MCP discovery/read/run | Existing MCP semantic handlers and their CLI subprocess boundary | Source MCP remains distinguishable; no tool arguments, business payloads or outputs enter analytics. |

Registered plugin callbacks and component consumers publish at most 500 local
action declarations per active backend handle through the typed
`experimental_productAnalytics.declareLocalActions` path. These identities cannot
replace Core/server actions. The same outbox declares queued local identities
before delivery; disabled or removed apps cannot grant new completion authority.
Catalog delivery failures become visible gaps rather than failing a control.
Actual mention search/resolution, selected runtime skill injection and theme
resource consumption use the same collector. Skill injection is a system
observation, not evidence that a model read or followed instructions. Missing
asynchronous skill provenance is a diagnostic gap rather than guessed production
usage. Theme prefetch is not human selection. Provider/host readiness remains
unknown unless actually established. BBDEV-39 and BBDEV-42 remain separate
unavailable/pending capabilities until their owning source is integrated.

Local-only CLI guide/help, plugin new/types/build/dev and CLI diagnostics record
actual invocation/exit through the shared SDK outbox. A filesystem adapter uses
500 exclusive reservation directories, seven-day expiry and per-envelope identity
checks. A replayed receipt cannot remove a different queued action. The spool is
isolated by a hash of the configured server URL; events retain their actual Core
project, actor and QA plane. Exit recording uses synchronous filesystem admission;
it does not wait for network delivery. Subsequent local activity retries pending
delivery. `bb diagnostics product-analytics --json` exposes local health without
event payloads. A watch starting is not a successful build. Diagnostic totals are
bounded lower bounds after their 1 MiB log saturates; overflow, concurrent crashes,
expiry, unavailable storage and device loss can leave gaps. This is not a power-loss
or exactly-once guarantee. Production popularity cannot be inferred from these gaps.

## Owner report

Settings → Private analytics, `bb analytics --json` and the typed SDK report use
the same private projection. Filters select one logical scope, period, actor,
surface, release and QA mode. The owner sees exposure/open/attempt/outcome
funnels, denied/cancelled/accepted work, actor split, repeated actor sessions,
observed duration, last meaningful use, coverage, availability and delivery
freshness. Instance/browser delivery counters are not cross-project popularity.

The UI distinguishes unavailable, failing, not instrumented and covered with
no recorded use. Its unused view stays empty while delivery diagnostics have
gaps or pending records; missing collection cannot prove lack of demand.
Low use is evidence for an owner decision, never permission to delete a feature.

CLI filters are documented in `bb guide customization`; `bb guide json` and
`bb analytics --help` expose the report shape. Public plugin behavior is
documented only in the Plugin Guide's `private-analytics` surface.

## Runtime acceptance gate

The source checkpoint is not deployment acceptance. A controller must build the
integrated candidate, run its coordinated Turbo graph and independently review
it before starting the owned candidate collector. Do not substitute unit tests
or a source coverage list for these checks:

1. Use the actual UI, CLI, normal SDK and native agent entrypoints on an owned
   logical project. Read the private report and verify feature/action, actor,
   surface, QA mode, result, duration and original operation identity. Replay
   the same delivery and verify no extra action. Exercise refusal and accepted
   asynchronous work separately from genuine success.
2. In a real browser, go offline, use a declared feature, reload/restart the
   client and server, reconnect, and observe pending → committed → projected.
   Lose an ACK after commit and verify deduplication; exercise storage and
   projection failure, capacity and expiry, and visible gaps. Confirm an actual
   Core workflow still succeeds while collector admission fails.
3. Inspect the real Settings report at desktop and compact widths, including
   existing persistent drawers, keyboard access, loading/error/empty states,
   meaningful filters and freshness. Qualify representative iOS Safari drawers
   and app-root/deferred-realization behavior; no automatic UI audit pass.
4. Demonstrate populated, unused, unavailable, failing and uninstrumented rows
   without conflating them. Compare production with the explicit QA plane and
   human/agent/background attribution before drawing popularity conclusions.
5. Verify event admission/export contains no forbidden payload/properties,
   unauthorized or combined project scope, or raw errors. Demonstrate Work and
   Personal remain separate even when both use the same model subscription.
   Verify retention and bounded-queue behavior on the running candidate.
6. Record a short real video tied to the verified candidate version showing
   feature use → accepted event → updated analytics. A screenshot, test log,
   synthetic chart or queued event is not the video deliverable.

Record the exercised results against the integrated candidate before acceptance
or deployment. Authored regressions and source declarations are not a substitute
for the real UI/CLI/SDK/agent, delivery/privacy and video proofs above. Compose
deployment, stable integration and human Accept remain controller-owned.
