---
kind: instruction
title: bb Guide — Projects
summary: Command reference for project CRUD, attachments, and sources.
intent: Provide complete project command documentation for agents.
editingNotes: Keep flags accurate against the CLI implementation.
---
Project commands

A project maps to a code repository. All threads belong to a project.

  bb project list                         List ordinary projects
    --include-personal                    Also include the personal project
  bb project discover                     Find recently used git repos
    --machine <id-or-name>                Machine to scan (default: local)
    --host <id-or-name>                   Alias for --machine
  bb project history <id>                 List prompt history
  bb project reorder <id>                 Reorder in the sidebar
    --after <id>                          Previous project, or omit for start
    --before <id>                         Next project, or omit for end
  bb project create --name "..." [options]
    --root <path>                         Project source path
    --machine <id-or-name>                Bind the path to a connected machine
    --host <id-or-name>                   Alias for --machine

  An explicit machine/host selector accepts an exact ID or unambiguous name and
  binds --root to that machine. Omitting the selector preserves the existing
  local CLI machine fallback (normally the server machine).

  bb project show <id>                    Show project details
    Accepts proj_personal to inspect Personal.
  bb project update <id>                  Update a project
    --name <name>                         New name


  bb project context-defaults get <id>    Inspect independent logical context/account defaults
  bb project context-defaults set <id> \
    --execution-context <id|none> --model-connection <id|none>

  Both selectors are required for set; none clears that default. Definitions
  and native-provider limits are documented in `bb guide agent-configuration`.
  Defaults affect new threads only, not existing native conversations.
  bb project delete <id>                  Delete project and all threads
    --yes                                 Skip confirmation

Global prompt history:

  bb prompt-history list [--cursor <cursor>] [--limit <number>]

  Lists accepted prompts across projects and threads newest first. Pass the
  returned cursor to continue from the next page.

Discovery:

  bb project branches <id> --host <id>   List branches for a machine source
  bb project paths <id>                   Search workspace paths
  bb project files <id>                   List workspace files
  bb project content <id> <path>          Read file content (binary is base64;
                                          --json reports contentEncoding)
  bb project commands <id> --provider <id>
                                          List commands and skills
    --machine <id-or-name>                Target project source machine
    --host <id-or-name>                   Alias for --machine
    --environment <id>                    Target environment workspace
    --execution-context <id>              Commands/skills: selected scoped context
    --thread <id>                         Commands/skills: persisted thread context

  These two selectors apply to `commands`. When --thread is present its binding
  wins; a conflicting explicit execution context is refused. Otherwise an
  omitted context uses the project default. Native discovery cache entries are
  scoped by declared roots, not shared with sibling contexts.

  The machine/host and environment selectors are mutually exclusive. An
  environment selects its owning machine and workspace; otherwise an explicit
  machine selects that machine's project source. Omitting both intentionally
  falls back to the server machine's project source.

  Personal file access (`paths`, `files`, `content`) requires an explicit
  --environment <id> belonging to Personal. Personal has no default project
  source; the selected environment must be ready.

  Path and file searches honor Git ignore rules, including local and global
  exclusions; tracked and non-ignored untracked files, including hidden files,
  remain searchable. Non-Git workspaces use filesystem listings. Use
  `bb file list|paths` for listings that include ignored files.

Attachments:

  bb project attachment upload <id>       Upload bytes from the CLI machine
    --client-file <path>                  Path read on this CLI machine
    --filename <name>                     Attachment filename override
    --mime-type <type>                    MIME override (otherwise inferred)
  bb project attachment download <id> <attachment-path>
    --client-file <path>                  Destination on this CLI machine

  Uploads use multipart bytes and return a server-managed attachment DTO. Pass
  its relative `path` to thread --file/--image input. Thread --file and --image
  upload absolute paths and file: URLs from the CLI machine automatically;
  relative values remain existing server attachment paths.
  image/* uploads are limited to 10MB; other files are limited to 25MB.
  image/heic and image/heif uploads are rejected because no renderer or
  provider can decode them; convert them to JPEG or PNG first. There is no
  command to list or remove project attachments.

Sources:

  Projects can have multiple machine-local path sources.

  bb project source add <projectId>       Add a source
    --path <path>                         Local path
    --clone                               Clone the project's Git remote
    --remote-url <url>                    Git remote override for --clone
    --target-path <path>                  Destination override for --clone
    --machine <id-or-name>                Target machine (--host is an alias)
    --default                             Set as default source

  Explicit project source selectors must name a connected machine. Omitting
  the selector preserves the same local CLI machine fallback as project create.

  bb project source update <projectId> <sourceId>
    --path <path>
    --default

  bb project source delete <projectId> <sourceId>

  A live project must retain at least one source; a project pending deletion
  may remove its last source.

Machine preparation and workspace transfer:

  bb project prepare-machine --project <id> --host <id> --target-path <path>
    --source-host <id>                    Source machine for explicit copies
    --copy-path <path...>                 Relative files to copy; repeatable
  bb project preview-workspace-transfer --project <id>
    --source-environment <id> --host <id>  Inspect source and target readiness
  bb project transfer-workspace --project <id> --source-environment <id>
    --host <id> --target-path <path>       Create a new target environment
    --branch <name>                       Explicit target branch
    --include-path <path...>              Extra files or secret consent; repeatable
  bb project get-workspace-transfer --operation-id <id>
                                          Query the durable operation journal

  All four commands support --json and print the complete SDK result. Host flags
  take machine IDs. Preparation returns source, copiedFiles with SHA-256 hashes,
  and readiness {ready, checks: [{name, ok, detail}]}; inspect actual failed checks
  rather than assuming the machine is ready. Copies require an explicit source
  host and relative paths; no .env or credentials are copied by default.
  Target paths must be canonical absolute paths: no ~, dot segments or trailing
  slash. Copies land only in the project source checkout; isolated new worktrees
  do not inherit copied untracked/ignored files.

  Preview lists HEAD, branch, file selections/exclusions and active thread IDs.
  Transfer requires an idle source environment and idle threads, refuses source
  changes during capture, and requires a new target path. It preserves the source,
  local-only commits, staged and unstaged tracked changes/deletes, binary bytes
  and modes. Untracked/ignored files require explicit --include-path selection.
  Tracked secret paths require explicit consent, not silent omission.
  Preview kind sensitive-tracked marks ordinary files requiring explicit consent;
  unsupported file types are hard refusals, not selectable exclusions.
  A shared private remote login is not required: unpublished commits travel in
  a Git bundle. The target is a new environment of the same project.
  No origin access is needed; Git config, remote configuration and authentication
  are not automatically transferred.

  Checkpoints support at most 64 MiB combined decoded bytes, counting the bundle,
  changed staged-index blobs, changed tracked working files and selected extras.
  Unchanged tracked file bytes do not count; the same changed file can count
  twice for index and working state. Preparation copy batches share the 64 MiB
  combined limit; index metadata and previews support at most 10,000 entries.
  Base64 RPC JSON can reach approximately 85.4 MiB plus metadata; no chunking.
  Each checkpoint/copy batch must also fit 96 MiB UTF-8 JSON, including base64
  and path/index metadata. Both limits apply; oversized capture/copy reads fail
  before returning data and restore/copy writes fail before target mutation.
  Oversize payloads fail, never truncate. Symlinks, submodules/gitlinks, sparse checkout/index,
  unmerged entries, skip-worktree, assume-unchanged, in-progress Git operations
  and custom non-LFS clean/smudge filters are refused explicitly.
  Shallow/partial/promisor clones, grafts and replacement refs are also refused.
  Only exact ordinary files can be selected, including explicit nested relative
  paths. Ignored directories appear excluded in preview; selection does not
  recursively copy directories.
  Ordinary transfers need Node and Git. Materialized Git LFS bytes and pointer
  index entries are preserved; unresolved pointer-only working files are refused.
  Fetch/materialize actual source bytes before retrying.
  LFS paths require git-lfs installed on the target. Transfer configures only
  standard local LFS filters, not network/authentication. Effective filter=lfs
  paths must match; select required untracked/ignored .gitattributes explicitly.
  Source-only info attributes or target attribute mismatches fail actionably.

  Transfer returns operationId, status ready, environmentId, hostId, rootPath,
  head, branch and handoff only after verification. Durable status is pending,
  capturing, transferring, verifying, ready, failed or interrupted; query by
  operation ID after a disconnected request. Failure includes an error.
  Ready query results can include continuationThreadId. Continue with:
    bb thread spawn --project <id> --environment <returned-environmentId>
      --transfer-operation-id <operationId> --prompt "Continue from the handoff"
  The server validates the ready target and idle source, records the continuation
  thread and returns it on retry. A durable source/target active-dispatch fence
  persists across restart. This starts a new native session, not live-session
  migration. Agent/auth/MCP directories and whole-home archives are not copied
  automatically.
