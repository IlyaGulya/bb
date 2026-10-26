Start a thread, pick Claude Code, and let it work in your repository from bb. The plugin drives the Claude Code CLI on the host machine. It streams the agent's work into the bb timeline.

## What you get

- Permission modes `accept-edits`, `auto`, and `full`, plus a plan action in the composer.
- Reasoning levels from Low to Max, plus Ultracode, which turns on multi-agent workflow orchestration.
- Checkpoint forks, manual compaction, and native questions from the agent.
- Claude Code skills and provider-native CLAUDE.md or supported AGENTS.md files
  from your home directory and project.
- Health, usage, and install status for Claude Code on each host, with an install or update action.

## Settings

- `Claude Code memory`: let Claude Code read and write its auto-memory.
- `Disable provider subagents`: hide the native Task tool so the agent delegates through bb.
- `Disable Workflow tool`: hide the native Workflow tool.
- `Claude in Chrome`: start Claude Code with the browser tools.

## Requirements

- Install the Claude Code CLI (`claude`) on the host machine. The plugin can run the installer for you.
- Sign in with `claude` on that machine. bb reads the sign-in state to show account and plan.
- `Claude in Chrome` needs the Chrome extension and a claude.ai login on the host.

## Scoped execution contexts and native model connections

Thread provider options can carry validated `executionContext` and `modelConnection`
snapshots. They are independent: multiple contexts may reference the same native
Claude account directory. Legacy threads without either snapshot keep their existing
settings sources, native roots, auto-memory defaults, and authentication behavior.

For scoped threads, native filesystem settings sources are empty. Instructions come
from the frozen context's `instructions` plus the thread's explicit base instructions,
not automatic user/project/ancestor `CLAUDE.md` or `AGENTS.md` discovery. Include selected
repository instructions in the context snapshot deliberately. Selected project settings
can be referenced explicitly with `settingsPaths`; hooks use native `{ "hooks": ... }`
JSON through those files or `hooksPath`. Supported settings are `permissions`, `sandbox`,
`hooks`, `language`, `alwaysThinkingEnabled`, `model`, `effortLevel`, and `attribution`.
Other settings are refused rather than silently importing an account, plugin registry,
or tool identity. Native managed settings, managed instructions, and enterprise
restrictions remain the native engine's responsibility and are not disabled.

Only selected `skillRoots`, `commandRoots`, and `pluginRoots` are injected. Scoped
plugins use SDK `skipMcpDiscovery`; their MCP definitions are not imported implicitly.
Each selected `mcpServers` entry references a standard MCP JSON file and selects only
its named descriptor, even if the file also contains other servers. Native stdio,
HTTP, and SSE descriptors are supported; unsupported options/transports are refused.
Strict local MCP configuration retains bb's mandatory `bb-bridge` server.

Claude.ai account-provided MCP requires a separate control:
`ENABLE_CLAUDEAI_MCP_SERVERS=false` is set only in the scoped child environment.
Strict MCP configuration alone is insufficient. The adapter refuses scoped startup
unless the selected executable exposes that control and `--plugin-dir-no-mcp`.
The native 2.1.204 executable contains both controls, and SDK 0.3.245 exposes
`settingSources`, `strictMcpConfig`, and `skipMcpDiscovery`. Capability inspection
does not constitute a live cloud-import or subscription acceptance test. See the
[native MCP reference](https://code.claude.com/docs/en/mcp-configuration#disable-claude-ai-connectors)
for the documented cloud-import switch.

Scoped auto-memory must be explicitly disabled (`autoMemory=false`); shared
account/project memory and Claude in Chrome cannot be enabled for scoped threads.
An isolated native memory directory is not represented by the current context schema,
so `autoMemory=true` is refused rather than leaking shared memory.

A model connection's `nativeAuth.configDir` selects an existing native auth reference
through the child's `CLAUDE_CONFIG_DIR`. It never changes `HOME`, the global login, or
copies/extracts credentials. Explicit connections discard competing inherited API-key,
OAuth-token, and alternate-provider environment overrides. A non-default auth directory
requires an explicit execution context, preventing an auth-only selection from
accidentally swapping the account's entire settings profile. `profile` and OMP
`hostEnv` broker references are unsupported for Claude and fail with guidance.

Each bound thread stores a content-hash receipt under the provider host data directory's
`execution-contexts/` directory. Selected settings, MCP definitions, hooks, and transitive
root contents are checked before continuation and native restart/resume. Modified
sources or missing resume receipts fail closed; create a new thread or restore the
original selected files. Receipts contain hashes only, not source bodies or credentials.
Native session IDs, transcript storage, and resume/fork mechanisms are unchanged.
This is configuration isolation, not a filesystem sandbox; mandatory managed resources
and explicitly selected executable code remain outside the private-context guarantee.
