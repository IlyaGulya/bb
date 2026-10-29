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

The browser uses IndexedDB and the shared SDK outbox. It retains pending
records across reload, retries after reconnect, checks per-stage receipt
identity, and retains missing/mismatched/retry receipts. An accepted or duplicate
receipt removes that queued record; a terminal rejection becomes a gap.

Bounds:

- Server: 30-day event retention, 100,000 events, 10,000 pending; project at most
  500 pending records per sweep. Instance identity and cumulative delivery
  counters are diagnostic state, not a retained payload/event history.
- Browser: 500 pending events, seven-day expiry, 50 events per batch, at most
  ten batches per flush. Reconnect and periodic delivery reuse the same outbox.
- Storage failures, projection failures, capacity limits, expiry, rejected
  declarations, missing scope and device loss can leave gaps. The primary
  product action is not rolled back or failed because collection failed.
- A process dying before admission, a lost device, or an unavailable local
  store can lose events. This is not an exactly-once or lossless guarantee.

`BB_PRODUCT_ANALYTICS_MODE` selects production, preview, smoke or test at the
server boundary. A non-production server does not accept client production tags
as production popularity. Reports keep those planes separate. A test suite or
replayed workload is not production feature demand.

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
| Native plugin tools | Actual native tool execution | Semantic result and bounded duration; external business effects require their own completion declaration. |
| Plugin services and schedules | Shared service lifecycle and claimed schedule execution | System/background activity, separate from intentional human use and separately scoped Core child actions. |
| Native execution/provider | Accepted root-turn start/completion effects | Actual execution result; runtime system attribution is not inferred human/provider choice. Observed admission-to-completion time can include delivery delay. |
| Core UI | Visible route entry, meaningful navigation, shared command dispatch | Exposed/opened/started/terminal navigation; accepted command dispatch is not downstream completion. Trusted input/automation provenance is separate from background exposure and unknown opens. |
| Bundled local plugin commands | Monaco command identities and Prompt Library composer command | Backend-declared identities and the existing shared Core command path, not a second tracker. |
| Custom local plugin actions | Explicit private analytics declarations | Client-local versus server completion authority is explicit; plugin disposal retires availability. See the Plugin Guide. |
| MCP discovery/read/run | Existing MCP semantic handlers and their CLI subprocess boundary | Source MCP remains distinguishable; no tool arguments, business payloads or outputs enter analytics. |

UI-only controls without a declared semantic action remain explicit coverage
gaps. Skills, themes and thread integrations without a semantic lifecycle
contract are inventoried as gaps. Provider/environment/machine registration
does not prove current host installation or project readiness; availability
remains unknown where that cannot be established. BBDEV-39's player/gate and
BBDEV-42's demo pipeline are separate unavailable/pending capabilities until
their owning changes supply actual instrumentation. None of these gaps may be
interpreted as unused features or silently called accepted coverage.

Local-only CLI guide/help, plugin-authoring commands and CLI error diagnostics
are also explicit gaps: a server request observer cannot prove their use.

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
