# Provider usage

With a focused thread, the sidebar opens on **Selected account**, resolved from
Core's persisted execution binding and the thread's actual environment machine.
It does not use composer drafts, project defaults, the last browsed machine, or
Account Pooler to choose a payer. Workflow workers use their own persisted thread
bindings through the same consumer.

The frozen connection name/provider and current definition availability remain
distinct: deleted, revoked, disabled, and unverifiable definitions suppress quota;
an edited definition never replaces the frozen snapshot. Loading, unknown,
unsupported, stale, unauthenticated, expired, and exhausted are distinct states.
Definition changes and reconnects invalidate selected observations; late replies
from an older thread or invalidated request cannot populate the selection.

The qualified association currently is native `claude-code`, gateway absent,
all `nativeAuth` references null, and the same actual execution host authorized by
both frozen and current definitions. A native MCP profile must also use the
default account directory. The canonical `provider-claude-code` source must publish
exactly its host-default resource for that host/provider pair. Only that resource
is fetched. This is a **host-default source observation for a logical connection**,
not proof of the physical credential used by a turn. Plan labels are explicitly
source-reported, not verified native session identity or readiness.

Gateway namespaces/account families, native `configDir`/`profile`/`hostEnv`
selectors, and other unproven provider mappings return metadata-only unsupported
or unknown states. Gateway request/token usage and cooldowns are not subscription
quota. There is no per-connection quota API, auth-file lookup, alternate-account
fallback, or payer rotation added here. The binding and current availability are
checked again after collection before an observation can be returned.

Selected observations show source and last successful measurement time; successful
observations older than two minutes are stale. Missing or invalid observation
times cannot produce current percentages or plans. Failed collection does not
substitute another source. Authentication failure is not exhausted quota, and
missing quota windows are not zero consumption. Existing bars, reset details and
reported extra-usage costs are reused when the qualifying source supplies them.

## All accounts: separate maintenance browsing

**All accounts** explicitly opens host/pool maintenance observations, separately
labeled from Selected account. Settings → Installed plugins → Provider usage
is also this maintenance browser. Without a focused thread the footer opens this
browser; a focused thread without a frozen connection instead reports unknown
and offers explicit browsing.

When a location has multiple providers, the maintenance browser opens on an
**All** tab stacking their accounts, each marked with its provider icon. Each
account shows its reported plan, usage bars, consumed percentage and reset time.
It lists metadata cheaply and fetches only the selected tab's accounts. Unopened
tabs have no quota badge until measured. Shared sources such as Account Pooler
remain the maintenance browser's default; explicitly selecting a machine shows
its local usage. These browsing preferences never change a thread binding.

An unconfigured shared source remains selectable and shows setup guidance.
Failed refreshes retain the last available measurements with a retry notice.
Account authentication failures and plans without reported limits have separate
states; unavailable usage is never represented as zero consumption.

The settings browser uses full-size provider groups with email-labeled accounts,
fetching only resources in the selected pool or machine. It shares the existing
maintenance aggregation/cache with footer All accounts. Sources publish usage
independently of either display.

Use `bb plugin rpc list --method provider-usage.v1.listResources --json` to find sources
and `bb plugin rpc inspect <plugin-id> provider-usage.v1.listResources --json`
to inspect their published contracts. RPC calls accept JSON through
`--input-file`. See the Plugin Guide for the contract API.

The selected consumer is the discoverable, schema-validated plugin RPC
`bb--provider-usage.getThreadUsage`, with input
`{ "threadId": "<actual-thread-id>", "force": false }`. `force: true` requests
a refresh only after the same source qualification; it cannot enable a source,
select a different account, or bypass current revocation. Read it through
`bb plugin rpc call bb--provider-usage getThreadUsage --input-file <request.json> --json`.
`bb plugin rpc inspect bb--provider-usage getThreadUsage --json` exposes its
input/output schema. The typed app client uses
`useRpc<typeof providerUsageRpcContract>().call("getThreadUsage", input)`;
backend/SDK consumers use `bb.sdk.plugins.callRpc` with the same method/input and
`threadUsageSchema` output schema. The response contract is in
`thread-usage-schema.ts`; the existing Plugin Guide documents these RPC clients.

The existing `getUsage` input and maintenance behavior are unchanged. No copied
`provider-usage.v1` source contract, database schema, or host-daemon wire field
changes are required for this consumer association.

`bb settings usage --json` and `bb.sdk.system.usageLimits()` remain the
host-local provider-maintenance view; they do not aggregate shared pool accounts.

Codex, Claude Code, and ACP provider plugins explicitly implement the usage contract
for their own providers. Account Pooler implements it for shared accounts. The
contract is owned here and copied into each source; no additional adapter plugin,
provider-kit helper, or core runtime convention is required. Other providers must
explicitly implement the contract to appear in these displays.

OpenCode's host-local source reports OpenCode Go subscription limits when a Go
Console account or API key is configured on the selected machine. Its five-hour, weekly, and monthly
windows come from Go's usage API. Other providers used through OpenCode and Zen
pay-as-you-go spending are not included.

Known provider-issued account identities are deduplicated within the selected
location. Unknown identities are never merged by email. Structured plan and quota
window metadata give both displays consistent labels.

Provider Usage is enabled by default for newly registered installations. Existing
explicit enable/disable choices are preserved. Right-click the footer shortcut and
choose **Hide** to move it into **More**. Settings → Appearance → Sidebar footer
controls order and visibility for every footer action. The usage settings page
remains available. These preferences belong to BB, not the plugin.
