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
- For native model authentication, sign in with `claude` on that machine. A CPA model connection instead uses its provisioned worker-local client key.
- `Claude in Chrome` needs the Chrome extension and a claude.ai login on the host.

## Scoped contexts and native accounts

Explicit `executionContext` and `modelConnection` snapshots select instructions/
tools and native authentication independently. Unassigned legacy threads retain
their existing behavior.

By default, scoped launches use explicit settings/hooks and selected skill/command/plugin
roots. Named MCP descriptors come from the selected native JSON files; strict
MCP retains `bb-bridge`. Plugin MCP auto-discovery is off. Account-cloud MCP
import is separately disabled with `ENABLE_CLAUDEAI_MCP_SERVERS=false`
([native reference](https://code.claude.com/docs/en/mcp-configuration#disable-claude-ai-connectors)).
Unsupported native controls refuse startup, never fall back to ambient sources.

The native account reference uses child-only `CLAUDE_CONFIG_DIR`; explicit
connections discard competing inherited auth overrides, never change `HOME`,
copy OAuth or switch the global login. A non-default auth directory requires a
scoped context. Auth `profile`/OMP broker references, Chrome and shared native
auto-memory are unsupported for scoped Claude.

A CPA connection routes native Claude model HTTP over `anthropic-messages`;
CLI/session history stays native. Select an exact `bb-cpa/<prefix>/<id>` model
and worker-local key reference. Missing/incompatible selections refuse without
native/pool fallback. Context and model payer remain independent.

`nativeMcpProfile: {configDir: string|null}` explicitly selects the whole native
user/project MCP and Cloud profile; null means host-native. Absent keeps strict
scoped MCP. This mode is not a per-server ACL or sandbox.
CPA model `nativeAuth` stays null: custom Authorization uses the CPA key; native
OAuth stays Cloud-only, without copying tokens. Before input, a compatible CLI/SDK
must prove first-party OAuth and a connected `claudeai` server; empty inventory refuses.
CPA enables `ToolSearch` unless explicitly overridden, discovering schemas
on demand without changing permissions or Cloud identity.

Hash-only host receipts protect selected settings/MCP/hooks/root content and
secret-free gateway references across
continuation and resume. Modified sources or missing resume receipts require a
new thread or restored original files. Native session/transcript linkage and
managed enterprise policy remain native. This is configuration selection, not
a filesystem sandbox or proof of live subscription/cloud-MCP isolation.

See `bb guide agent-configuration` and the repository's
[configuration reference](../../docs/configuration.md#independent-execution-contexts-and-model-connections)
for persisted UI/CLI/SDK fields, precedence and current limits.
