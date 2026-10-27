# ACP providers

First-party plugin for ACP (Agent Client Protocol) agent providers: Cursor,
opencode, omp, Grok Build and Hermes Agent.

OpenCode Go usage appears under OpenCode in the Provider usage panel for the
selected machine. It reads the official Go endpoint using the machine's OpenCode
Console account or API credentials and reports the five-hour, weekly, and monthly
windows with their reset times. Sign in to Go in OpenCode on that machine.
The same data is available through `bb settings usage --machine <id> --json`
and `bb.sdk.system.usageLimits({ hostId, providerId: "acp-opencode" })`.
Other OpenCode providers and pay-as-you-go spending are not included.

The plugin has no bridge of its own. Every agent it registers runs on the
published ACP kit, `@get-bb/plugin-sdk/provider-bridge/acp`, which its
`bb.host` entry re-exports (`src/host.ts`). That is the whole
point of the kit: a third-party plugin adds an ACP agent exactly the way this
one does, with no bb-side code. The plugin is forkable
(`docs/forkable-plugins.md`): its lint rule and the fork check prove it takes
no shortcut — no file here may import a workspace package.

What lives here:

- `server.ts` — the plugin's runtime: it reconciles one registration per
  agent, from the shipped list (`src/known-agents.ts`) plus whatever the
  `customAgents` setting declares.
- `src/agents.ts` — the agent definition and the setting's schema, built out
  of the kit's own launch-spec schema so what the setting accepts is exactly
  what the bridge parses. The setting itself is a multi-line JSON field
  (`experimental_multiline`) whose description stays at two sentences; the
  field reference — required and optional fields, the replacement rule for a
  shipped agent's id, the `acp-<id>` provider id — is the "Custom ACP Agents"
  chapter of `docs/configuration.md`.
- `src/configured-agents.ts` — resolving the setting's JSON into agent
  definitions, with a warning for each entry it cannot use.
- `src/declaration.ts` — one agent definition becomes one
  `bb.providers.register` declaration: ids, display names, icons,
  capabilities, and the bridge options it launches with (`acpLaunchSpec`, and
  `acpDialect` for the agents whose vendor side channels the kit reads).
- `src/host.ts` — the `bb.host` artifact, two surfaces in one file: the kit's
  bridge, re-exported, and a host entry whose one RPC asks an agent what it
  supports on the machine it is installed on (`src/contract.ts`,
  `src/probe-capabilities.ts`).
- `icons/` — the provider logos, declared in `package.json` under
  `bb.branding.experimental_icons` so the packaged build ships them.

The kit itself, including the ACP wire schema, the delta translation, the
per-agent dialects and the bridge process, is `packages/provider-bridge-acp`.

## OMP context and account bindings

Unassigned `acp-omp` launches retain native `omp acp`. Scoped native ACP instead
uses the host-installed native OMP SDK's public session factory and ACP mode,
under Bun; it does not replace the native agent loop. The bridge consumes the
reserved `providerOptions.executionContext` and `providerOptions.modelConnection`
snapshots on discovery, start, resume, fork and followup; invalid or unsupported
selections fail before an agent is launched or a prompt is submitted.

An OMP model connection with `nativeAuth.configDir` and `nativeAuth.profile` both
`null` uses the host's existing native authentication source. Multiple connections
can reference that same source concurrently without switching a global login or
copying credentials. An optional `nativeAuth.hostEnv` object names
`brokerUrlEnv` and `brokerTokenEnv` variables on the selected host. The bridge
passes their values only to the child as `OMP_AUTH_BROKER_URL` and
`OMP_AUTH_BROKER_TOKEN`; absent references fail instead of falling back to another
login. The stored snapshot contains variable names, never their values. Changing
the selected connection on an active thread is refused.

`nativeAuth.configDir` selects an existing native authentication/model directory
on the execution host, including its `models.yml` and default model role when BB
does not name a model. It does not supply context settings, roots or session
storage. Native profiles are not supported selectors; use explicit configDir or
broker references. Do not copy auth stores or swap HOME/profile directories.
MCP authentication always uses the fixed host native auth source, independently
of the selected LLM source; selecting an LLM account does not select a cloud MCP
identity.

Scoped startup requires Bun and the host-installed
`@oh-my-pi/pi-coding-agent` SDK directory, selected with absolute
`OMP_SDK_PATH` in the execution host environment, or found beside the installed
npm CLI package. The native-prefixed variable survives BB's deliberate removal
of inherited `BB_*` control variables. A standalone
binary/wrapper is insufficient. The SDK must expose
`EXPLICIT_CONTEXT_DISCOVERY_VERSION = 1`: use
[`IlyaGulya/oh-my-pi` at `e4c4903`](https://github.com/IlyaGulya/oh-my-pi/commit/e4c4903)
(`agentos/native-model-errors-20261026`), based on 18.12.6. Point source installations
at the prepared `packages/coding-agent` package, with its dependencies, generated
assets and matching native bindings, not the monorepo root. Stock 18.12.6 does not
satisfy this contract. The SDK stays host-installed, not vendored. Missing
capabilities refuse startup, never fall back to ambient
`omp acp`, another account, or inference through another provider.

Use this revision or its descendants for terminal model-failure propagation:
native `session/prompt` rejects with JSON-RPC `-32603` / `reason: model_error`,
and BB's existing error path records a failed turn rather than successful
`end_turn`. The diagnostic and native history remain inspectable; explicit
retry/continuation keeps the session. Typed refusals and user cancellation
retain their ACP outcomes. This changes neither native retry policy nor model
authentication.

Selected `settingsPaths` accept only the bridge's context-setting allowlist, not
credentials, routing, discovery roots or memory configuration. `hooksPath` must
point to a native JS/TS default extension factory or native `omp`/`pi.extensions`
package; Claude command-hook JSON and shell-hook directories are not native OMP
hooks. Selected packages retain native extensions, agents, custom tools and MCP;
explicit direct MCP servers compose with package MCP. Scoped shared memory is
unsupported: keep `autoMemory: false`.
Direct references accept stdio command/args/env or HTTP/SSE URL/headers and retain
native environment-value resolution. Select a native package for other native
MCP options such as OAuth, timeouts or cwd; unsupported direct-reference options
are rejected, not silently discarded. ACP client/proxy headers and env are final
literal values, kept separate from native configuration references.

Native new/load/fork preserve native session IDs and history. The host provider
data directory holds source receipts: resume/fork/followup require the original
receipt and unchanged selected sources/binding. Restore those originals or start
a new thread; missing receipts never authorize ambient resume. Session storage
remains native to the host, not the selected model configDir. Configuration/session
discovery isolation is not a filesystem sandbox or session-storage ACL.

The OMP host root resolver returns only the selected absolute `skillRoots`,
`commandRoots`, and the skills/commands of explicitly selected `pluginRoots`.
Plugins expose native OMP extension-package sibling `skills/` and `commands/`
directories, not Claude manifest extras; extension entrypoints are resolved by
the native factory. No ambient plugin registry is consulted. Empty selections return no roots.
Missing or relative selected root directories are refused. Scoped discovery
does not read ambient OMP/Pi/Codex/OpenCode/Claude, home, or ancestor roots.
Unbound legacy discovery and native transcript handling remain unchanged.

Provider capability metadata advertises scoped contexts and native account
references. Discovery alone does not prove runtime acceptance. Real work
subscriptions, cloud MCP identities and macOS acceptance remain separate from
synthetic loopback evidence; these unreleased changes do not change the live
deployment.

## CPA gateway model connections

A gateway connection selects model HTTP independently of execution context, MCP,
Git identity and native session storage. It uses provider `acp-omp`, `hostId: null`
and an explicit nonempty `gateway.allowedHostIds` list. Native auth overrides and
gateway routing are mutually exclusive. The selected worker needs Bun and the
native SDK described above, plus its own provisioned CPA model-client key.

In Settings → Contexts & connections → Model connections, choose
**CPA gateway · native OMP (acp-omp)**. Enter the model API base URL, protocol,
account namespace and native catalog provider. Credential fields accept only an
environment variable name or an absolute worker file path, never its contents.
File credentials must be small owner-only regular files owned by the worker;
symlinks and missing/invalid values refuse launch. Never provision the CPA
management key or provider OAuth stores to a worker.

The same definition is available through `bb model-connection create/update`
and `sdk.experimental_modelConnections`. For example, after provisioning:

```sh
bb model-connection create \
  --name "CPA personal" --provider acp-omp \
  --gateway-base-url https://gateway.example/v1 \
  --gateway-protocol openai-responses \
  --gateway-account-prefix personal-codex \
  --gateway-model-provider openai-codex \
  --gateway-credential-file /run/credentials/cpa-client \
  --gateway-allowed-host host_authorized --json
```

The worker fetches this connection's `/models` with its client key. Only exact
namespace matches with supported native metadata are offered; unknown models
and unsupported image metadata do not acquire invented token limits. Select an
explicit `bb-cpa/personal-codex/<upstream-model-id>` model. Native/default model
fallback is disabled. Catalog requests need the selected `modelConnectionId`;
bound-thread requests use `threadId` to retain the frozen selection.

Responses gateway registrations explicitly set native
`compat.statefulResponses: false`. Each request sends the complete native
transcript with `store: false` and no `previous_response_id`, including each
function call before its result. Gateway routes must not inherit the official
provider's server-side continuation assumption. Native session history,
follow-up and reopen remain local to the same native SDK.

Both context-free and explicitly scoped launches use the native SDK/ACP loop.
Follow-up and reopen preserve native IDs; forks retain the binding with a new
native ID. Endpoint/protocol/namespace/model mapping and credential references
are pinned in secret-free receipts. Change the binding through a new thread,
not by editing an old receipt. File-key contents can rotate behind their
reference; an already running child retains its key until a new child opens.
BB disable/revoke blocks new admitted turns, not already admitted HTTP.

CPA client keys are flat credentials, not task/account leases. Account prefixes
restrict routing, not worker authorization. This pilot is private and trusted;
it does not provide per-user RBAC or strict per-run revocation. Native Claude
Cloud Connectors remain on their separate native path.

## Inspecting CPA request logs

Enable stock CPA request logging and give the Linux BB server only a read-only
log mount via `BB_CPA_LOG_DIR`. Do not mount CPA auth, configuration or key
directories into BB. Model requests carry `X-BB-Thread-Id`; discovery requests
do not. This header is correlation, not authorization or per-turn attribution.

Open a gateway-bound thread's Info panel → **Native CPA request logs**, or use:

```sh
bb gateway-logs list --thread <thread-id> --json
bb gateway-logs read <log-id> --thread <thread-id> --preview-bytes 1024 --json
bb gateway-logs read <log-id> --thread <thread-id> --output ./request.log
```

The SDK area is `experimental_gatewayLogs.list/read/download`. Reads require a
persisted gateway binding and an exact inbound thread header, not a body
substring. Paths, symlinks and hardlinks are confined/rejected server-side.
Previews default to 64 KiB, at most 256 KiB; truncation is explicit, and full
downloads retain all bytes. Directory scans are bounded to 2,048 entries and
report incomplete scans. Files still changing or settling are unavailable.

Raw logs may contain complete prompts, tool schemas/results and sensitive data.
Keep them private and outside Git; sample key masking is not universal
redaction. Native CPA capture can lose data under overload, and early admission
errors need not produce a full request trace. This covers routed model HTTP,
not direct providers, MCP/Git/browser transport or all machine traffic.
