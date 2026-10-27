---
kind: instruction
title: bb Guide — Agent Configuration
summary: User and workspace files that customize agent instructions and skills.
intent: Document the user and workspace files that shape agent behavior for threads.
editingNotes: Keep accurate against the server's agent-instructions reader and skill loader.
---
Agent configuration

bb reads agent configuration from the app data dir and from a project's .bb/
directory. These files shape how agents behave in provider-backed threads.

Explicit contexts and model connections:

  Settings → Contexts & connections keeps logical execution context separate
  from physical environment/worktree and model account. A context admits its
  selected projects and declares instructions, skill/command/plugin roots,
  settings/hooks files, direct MCP configuration references and optional Git
  identity. No project membership means no project may dispatch it.

  A model connection names a provider and execution host, with a native
  configuration/profile reference or declared host broker environment-variable
  names. It never stores OAuth, Keychain contents or a broker token. Native
  auth remains on the execution host; connection selection does not sign in or
  change the global login. Native providers may refuse unsupported references.

  Alternatively choose a CPA gateway connection for native OMP (acp-omp),
  Claude Code or Codex. OMP supports openai-completions, openai-responses and
  anthropic-messages; Claude Code requires anthropic-messages and Codex requires
  openai-responses. The native engine/session stays native; the gateway selects
  the model payer, not Work/Personal context or MCP authorization.

    bb execution-context list --json
    bb execution-context create --file context.json --json
    bb execution-context show <id> --json
    bb execution-context update <id> --file patch.json --json
    bb execution-context mcp-inspect --machine <host-id> \
      --provider claude-code --config /absolute/path/mcp.json --json
    bb model-connection create --file connection.json --json
    bb model-connection list --json
    bb model-connection show <id> --json
    bb model-connection update <id> --file patch.json --json
    bb project context-defaults get <project-id> --json
    bb project context-defaults set <project-id> \
      --execution-context <id|none> --model-connection <id|none>
    bb thread spawn --project <project-id> --execution-context <id> \
      --model-connection <id> --prompt "..."

  Create/update JSON files are read from the CLI machine; referenced absolute
  native configuration paths belong to the selected execution host. Context
  input includes name, projectIds, instructions, skillRoots, commandRoots,
  pluginRoots, settingsPaths, mcpServers [{name,configPath}], hooksPath,
  autoMemory, gitIdentity {name,email}, defaultModelConnectionId and optional
  Claude-only nativeMcpProfile {configDir:string|null}. Model connection input
  includes name, provider, hostId and nativeAuth {configDir,profile,hostEnv};
  hostEnv contains brokerUrlEnv/brokerTokenEnv variable NAMES, not their values.
  Gateway connections instead require hostId:null, default-null nativeAuth,
  gateway.allowedHostIds, accountPrefix and a worker-local credential FILE or
  ENV reference. Select an exact bb-cpa/<prefix>/<id> model; missing credentials,
  incompatible protocols/models or hosts refuse without native/pool fallback.
  Omitted create fields get native defaults;
  update JSON is a patch. Both definition kinds support enabled; connections
  also support revoked. Inspect `--help` for mutation/delete commands.

  Selection precedence: explicit run choice, task/preset choice, project
  default, then selected-context connection default. A selected connection must
  match the provider and host. Work/Personal names never pair an account to a
  context automatically. Clear project defaults with both selectors set to none.
  A disabled/revoked/missing choice is an error, not permission to borrow a
  different account. A thread retains its snapshots for reopen/followup;
  changing a definition/default affects new threads, not its native session.

  SDK equivalents: experimental_executionContexts.{list,get,create,update,delete,inspectMcp},
  experimental_modelConnections.{list,get,create,update,delete},
  experimental_executionContexts.{getProjectDefaults,setProjectDefaults,getThreadBinding},
  threads.spawn({executionContextId,modelConnectionId,...}). HTTP resources:
  /api/v1/execution-contexts and /api/v1/model-connections; static MCP inspection
  is POST /api/v1/execution-contexts/mcp/inspect with {hostId,providerId,configPaths}.
  Provider requests carry frozen executionContext/modelConnection snapshots
  under providerOptions, including model/list requests. Capability
  experimental_executionBindings advertises optional gatewayConnections
  independently of explicit-context support; gateways alone do not enable it.

  The context editor's MCP servers section inspects a preview machine's native
  file and selects individual names; the preview does not bind a host/account.
  New-thread selection and thread Info show the effective names and execution
  machine. Inspection parses only on that worker and returns file/name/transport/
  support/fixed-issue metadata, never raw config, commands, args, environment,
  headers, endpoint URLs or parse diagnostics. Use provider acp-omp for OMP
  format; repeat --config for at most 16 regular absolute files (1 MiB/file,
  250 servers/file). Offline/invalid files retain existing refs. Unsupported or
  duplicate choices cannot be added; invalid selected sources refuse before
  initial or delayed thread admission. Empty/legacy selections are unchanged.
  Inspection does not connect or authenticate; authStatus stays not_checked.
  Direct MCP credentials/cache remain separately provisioned on the execution
  host, not in the model connection. A standard stdio bridge such as pinned
  mcp-remote can reference an external private header file for supported HTTP
  auth. Do not copy account-cloud connector tokens. Selection is not per-tool
  permission policy; changing sources still requires a new native binding.

  Scoped Claude uses explicit configuration, not ambient user/ancestor
  discovery: settingsPaths selects native JSON settings; hooksPath selects a
  hooks JSON file; each mcpServers configPath selects its named direct MCP
  descriptor. The BB bridge remains present. Account-provided cloud MCP import
  and plugin auto-MCP discovery are off; selected direct MCP needs its own
  supported authorization. Auto memory must remain false until scoped native
  memory is supported. Required managed enterprise policy is not bypassed.
  The selected repository's root AGENTS.md, CLAUDE.md, .claude/CLAUDE.md and
  .bb/AGENTS.md are read within that root; ancestor/home instructions are not
  substituted. Selected native-source changes are rejected for an existing
  binding rather than silently changing its context.

  nativeMcpProfile is absent by default. Explicit owner-approved Claude use
  opts into the entire native user/project MCP profile plus account Cloud
  Connectors, not BB's per-server allowlist. configDir:null uses the host-native
  profile. This broader tool scope is not a sandbox/ACL. With CPA, nativeAuth
  stays default-null: the CPA key supplies model Authorization while local
  native OAuth is retained only for Cloud; no tokens are copied. Before model
  input, native initialization must prove first-party subscription/OAuth and
  at least one connected claudeai-scoped connector. Missing, unavailable or
  empty inventory refuses; valid-empty cannot be distinguished from missing
  grant. A compatible installed native CLI/SDK is required, without vendor
  hotpatches. This prerequisite is not proof of real Cloud runtime success.
  OMP/Codex refuse nativeMcpProfile; native Codex currently refuses any explicit
  execution context, even when its gateway model connection is supported.

  Scoped OMP requires the native host SDK under Bun with
  EXPLICIT_CONTEXT_DISCOVERY_VERSION = 1. Install the AgentOS explicit-context
  SDK and select it through the host's OMP_SDK_PATH or installed npm CLI package;
  stock 18.12.6 and standalone binaries are insufficient. Native configDir or
  declared child-only broker environment references select the model account
  independently of context roots and fixed-host MCP auth. Shared memory is off;
  native IDs/history remain native and unchanged-source receipts gate reopen.
  Missing capabilities refuse before dispatch, without an ambient fallback.
  This is not acceptance of the full real-account matrix or automatic migration.

  Context filtering is not a filesystem sandbox or an ACL. Enabled BB tool
  plugins and selected host capabilities still need their own access policy.
  Existing threads/unassigned projects retain the legacy behavior below.

User instructions (<dataDir>/AGENTS.md):

  Add an AGENTS.md file to the bb data dir (usually ~/.bb/AGENTS.md) to give
  every provider-backed thread across all projects default user-level
  instructions. bb reads <dataDir>/AGENTS.md and appends its contents to the
  thread system prompt for unassigned legacy threads when a provider session starts.

Workspace instructions (.bb/AGENTS.md):

  Add a .bb/AGENTS.md file to a workspace to give every thread that runs there
  repo-specific instructions. bb reads <workspace>/.bb/AGENTS.md and appends its
  contents to the thread system prompt for all providers, after any
  <dataDir>/AGENTS.md instructions, when a provider session starts. Track it with
  git so fresh managed worktrees include it.

  In the legacy path only the plural AGENTS.md is read, only from the exact data-dir and
  workspace-root .bb/ locations above (bb does not walk parent directories), and
  an empty file is ignored. This is bb's own provider-agnostic instruction
  injection, separate from provider-native instruction files. Codex reads a
  repo-root AGENTS.md. Claude Code 2.1.277 and later also reads AGENTS.md when
  no project or ancestor CLAUDE.md or CLAUDE.local.md takes precedence. Older
  Claude Code versions and sessions without its built-in AGENTS.md support
  still require CLAUDE.md.

Skills (.bb/skills/):

  A skill is a reusable instruction file that bb injects into a thread and
  exposes to the agent as a slash command. Place project skills under
  .bb/skills/<name>/SKILL.md in a workspace. Each SKILL.md has YAML frontmatter
  with `name` (lowercase, hyphenated, matching the directory) and `description`,
  followed by the instruction body.

  bb resolves skills from three sources, in increasing precedence:

    plugin     Skills from enabled plugins, including the bundled BB guide.
    user       <dataDir>/skills (e.g. ~/.bb/skills).
    project    <workspace>/.bb/skills.

  A project skill overrides a user or plugin skill with the same name. Two
  skills with the same name within one source collide and are both dropped.

  Use `bb skill list` to inspect installed and discovered skills and copy the
  opaque skill ID. `bb skill show|files <skill-id>` reads that exact skill;
  `bb skill show <skill-id> --json` returns the revision required by `bb skill
  update <skill-id> --revision <sha256>`. `bb skill delete <skill-id>` and
  update are restricted to editable, user-owned skills. These workspace-scoped
  commands default to `BB_PROJECT_ID`, then the personal project; pass
  `--project` or `--environment` when a different workspace is required.

  Use `bb skill search [query]` to browse skills.sh (no query lists what is
  trending; `--page` starts at 0 and `--per-page` defaults to 24). JSON
  `installs` counts the `ranking` window; `lifetimeInstalls` may be null. Use `bb skill registry detail
  <registry-skill-id>` to inspect metadata and the bounded file preview, and
  `bb skill install <registry-skill-id>` to install that canonical registry
  identity into bb user skills. Registry commands are server-wide and do not
  accept workspace selectors.

  Use `bb skill install-cli-skills` to copy bb's built-in CLI skills into a
  machine's global agent skill roots (`~/.agents/skills` and
  `~/.claude/skills`) so agents running outside bb can drive it. It installs on
  every connected persistent machine unless you pass `--machine <id-or-name>`
  (repeatable; required for a sandbox) (Settings → Skills has the same action). Machines install
  independently, so the command reports each machine's outcome and exits
  non-zero if any failed. The install replaces a previously installed copy of
  the same skill and leaves other skills alone. `bb skill cli-skills-status`
  reports whether each machine is installed, out of date, missing, or unknown
  (disconnected or unreachable).

  Use the skill-creator skill to author and iterate on skills.

BB guide plugin:

  The enabled-by-default BB guide plugin owns the BB introduction and the
  bb-cli, bb-plugin-authoring, skill-creator, and submit-a-plugin skills. Settings → Installed
  plugins → BB guide exposes introduction, a master skills switch, and one
  switch per skill. All default to true. Use:

    bb plugin config bb-guide set introduction false
    bb plugin config bb-guide set skills false
    bb plugin config bb-guide set bbCli false
    bb plugin config bb-guide set pluginAuthoring false
    bb plugin config bb-guide set skillCreator false
    bb plugin config bb-guide set submitPlugin false

  Changes apply when agent configuration is next assembled. They do not erase
  existing conversation text or disable independently installed copies.
