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

The shipped `acp-omp` provider still starts native `omp acp`. Its bridge consumes
the reserved `providerOptions.executionContext` and `providerOptions.modelConnection`
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

OMP profile/config-directory references are not authentication-only references:
native OMP uses them for settings, instructions, skills and session storage too.
The bridge therefore rejects them as model-connection selectors rather than
silently replacing the execution context.

The inspected native OMP 18.12.6 CLI has no complete isolated-context launch seam.
Its `--config` / `PI_CONFIG_FILES` values overlay ambient global and project
settings; ACP session creation also rediscovers project settings and title
instructions. Although ACP owns the MCP server list, that alone does not isolate
instructions, extensions or settings. Scoped execution-context launches are
therefore refused with an actionable native-capability error. Full Work/Personal
context execution requires a native explicit-context capability that disables
ambient discovery before startup and preserves the supplied immutable resources
on session creation and continuation; this is not provided by a new BB adapter.

The OMP host root resolver accepts the selected execution context and returns
only its absolute `skillRoots`, including an empty list for an empty selection.
It does not read ambient OMP/Pi/Codex/OpenCode/Claude-plugin roots in that mode.
The host layer must pass the snapshot and exclude static/default native roots
and sibling instruction/MCP injection as well. Unbound legacy launches retain
their existing behavior and native transcript/continuation handling.
