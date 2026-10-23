# Using bb on multiple devices

There are two separate ways to use more than one device with bb:

- A browser device is a control surface for one bb server. It can view projects,
  send prompts, and manage threads, but it does not execute them.
- An execution machine runs a host daemon. One bb server can dispatch project
  sources and thread environments across several enrolled machines.

You can use either story independently or combine them.

In both stories one computer runs the bb server. It stores your threads, the
database, and settings, and every browser and execution machine connects to it.
Pick a computer that stays on, such as a desktop, home server, or VM: while the
server machine is asleep or off, nothing can reach bb and running threads may
stop. Settings → Machines badges it `server` once several machines are
connected, `bb machine list` shows `server` in its Role column, and the server
machine cannot be removed.

## Prepare or transfer a project workspace

Preparation and workspace transfer are separate from enrolling a machine.
Use enrolled machine IDs and an existing project:

```bash
bb project prepare-machine --project proj_example --host host_target --target-path /code/example --json
bb project preview-workspace-transfer --project proj_example --source-environment env_source --host host_target --json
bb project transfer-workspace --project proj_example --source-environment env_source --host host_target --target-path /code/example-handoff --include-path notes.txt --branch handoff --json
bb project get-workspace-transfer --operation-id operation_id --json
bb thread spawn --project proj_example --environment env_target --transfer-operation-id operation_id --prompt "Continue from the transfer handoff" --json
```

The core project CLI example uses the bounded no-remote bundle mode. To approve
a remote/ref/SHA base for a large repository, use the SDK/HTTP `remoteBase` input
or the Tasks multi-repository panel/commands below; do not put credentials in
command arguments or copy authentication between hosts.

Preparation returns a project source, copied-file hashes and actual readiness
checks. Resolve failed checks before dispatching work. To copy specific local
configuration from a same-project source, pass `--source-host <id>` and explicit
relative `--copy-path <path>` values; secret files are never selected by default.
Target paths must be canonical absolute paths, without `~`, dot segments or a
trailing slash. Preparation copies into the project source checkout only;
isolated new worktrees do not inherit copied untracked/ignored files.

In the project preparation UI, Clone uses the same preparation API. Select a
same-project source machine and enter only the relative files you want copied,
one per line; `.env` is not preselected. The result shows readiness checks and
copied-file hashes/count, and Continue is enabled only when readiness is true.
Registering an existing folder remains an explicit local-path source operation.

Preview first, stop source work, then transfer to a new path. All source threads
must be idle. Transfer keeps the source intact and registers the verified target
as another environment of the same project. It carries unpublished commits and
tracked staged/unstaged changes, including binary files and deletes; explicitly
select portable extra untracked/ignored files with `--include-path`.

For large repositories, approve `remoteBase: {url, ref, head}`: a credential-free
HTTPS/SSH origin, explicit published `refs/heads/...` or `refs/tags/...`, and
exact prerequisite SHA. The target fetches with its own Git authorization,
verifies the prerequisite, and applies only bounded unpublished commits and
dirty overlays. Exact published HEAD needs no bundle. Cached origin candidates
are not proof that the target can fetch the approved ref. Missing authorization,
refs or objects fail visibly; there is no fallback account, source fetch/push
or larger full-history fallback. Without a remote base, a full bundle is still
available under the same limits and needs no target origin access.

Ordinary token/secret source modules, action code and project instructions need
no per-file approval. Preview flags ambiguous key/config-shaped tracked files
as `sensitive-tracked`: review them with the source owner, explicitly select
approved paths and require unchanged published provenance. Sensitive dirty,
staged, untracked or unpublished historical bytes are refused. Native auth and
session storage is forbidden even if selected. These path-based checks are not
a semantic secret scanner. Source Git configuration/authentication is not copied;
remote mode sets only the approved origin, and target provider/MCP authorization
must be configured separately.

Ordinary-file POSIX `rwx` permissions are retained and verified, including
private `0600` files whose Git content and executable bit are unchanged.
Ownership, ACLs, extended attributes and special permission bits are not
migrated.

The checkpoint limit is 64 MiB combined decoded data, including Git bundle,
changed staged-index blobs, changed tracked working files and extra files;
unchanged tracked files come from the target's approved fetch or the bundle,
not duplicate worktree blobs. Any bundle's compressed bytes still count.
Staged and working versions
of a changed file can count twice. Preparation copy batches have the same limit.
The encoded RPC can be approximately 85.4 MiB plus metadata. Each checkpoint
or copy batch must also fit 96 MiB of serialized UTF-8 JSON, including base64
and path/index metadata. Both limits apply; oversized reads fail before returning
data and oversized writes fail before target processing or mutation. There is
no chunking.
Oversize data fails without truncation. Index metadata and previews allow
100,000 entries; select exact extra files, not recursively copied directories.
Ignored directories appear excluded in preview. Verified tracked symlinks retain
their pointers and staged/unstaged state without dereferencing contents. Their
targets must exist inside the repository and avoid Git internals and sensitive
storage. Untracked/explicit-copy links and escaping links are refused, as are
submodules/gitlinks, sparse checkout/index, special index states, in-progress
Git operations and custom non-LFS clean/smudge filters.
Shallow/partial/promisor clones, grafts and replacement refs are also refused
instead of fetching missing history or changing the source.

Ordinary transfers need Node and Git. Git LFS files must have materialized
source content, not unresolved pointers; arrange source materialization before
capture, which does not fetch into the source. The target needs `git-lfs`.
Unchanged LFS files already present at the approved published prerequisite use
target-native LFS fetch/checkout and are verified against source identities,
instead of embedding large payloads in JSON. Dirty/unpublished LFS remains
bounded overlay data. The transfer configures standard target-local filters
before checkout and copies no authentication. LFS attributes must match on both
sides; explicitly select required untracked/ignored `.gitattributes` files.
Source-only info attributes or mismatches fail rather than silently changing
file interpretation.

Save the returned operation ID to query durable progress or errors after a
disconnect. The ready result includes the target environment ID and handoff;
start a new native session with `--transfer-operation-id` and that existing
environment ID. The server validates the ready transfer and idle source,
records `continuationThreadId`, and returns the same thread on retries.
A durable source/target dispatch fence prevents simultaneous active execution
across server restarts. This does not move a live process or its native
session/authentication state. See the
[API contract and detailed limits](environment-provisioning.md#project-preparation-and-transfer-api)
and `bb guide projects` for all options.

## Prepare one Task across multiple repositories

Use the Task's repository preparation panel or the matching CLI commands:

```bash
bb tasks repositories inspect ABC-12 --project proj_android --environment env_android --host host_worker --json
bb tasks repositories inspect ABC-12 --project proj_actions --environment env_actions --host host_worker --json
bb tasks repositories prepare ABC-12 --bindings "$BINDINGS_JSON" --json
bb tasks repositories show ABC-12 --json
bb tasks repositories continue ABC-12 --checkpoint mrc_checkpoint_id --json
```

First confirm the current task scope, actual roots and their owners; do not
infer them from a default project or stale linked ticket. In these commands,
`--project` is the BB code project ID, not a Tasks tracker prefix. Inspect each
source and build the reviewed `BINDINGS_JSON` array with 2–32 explicit roots:
source environment/host/path/branch/HEAD, owner and role, required flag, fresh
target host/path, isolated branch, executor preset, instructions, required
instruction paths, explicit extra files and optional approved remote base.
The [Tasks skill](../plugins/tasks/skills/tasks/SKILL.md#multi-repository-workspaces)
lists the exact binding fields and plugin RPC names.

The first root is required and primary. Every target uses the same execution
host and preset, with non-overlapping repository roots. Each has its own
environment, branch and dirty checkpoint, but continuation starts **one coherent
native writer** with access to all ready folders and their instructions. There
is no umbrella Git repository or required disconnected agent per root.

`prepare` returns a durable checkpoint immediately and never starts an
executor. The plugin's existing background lifecycle publishes per-root
progress. Use `show`/the panel to inspect aggregate readiness, errors and native
operation IDs; partial preparation is not migration success. All required roots
and target execution readiness must verify before continuation. Failed optional
roots remain visible and are not represented as prepared folders.

An interrupted client/plugin can leave an explicit unknown native outcome.
Observe/reconcile its saved receipt instead of blindly repeating the transfer.
To retry a settled checkpoint, pass `--checkpoint <id>` to `prepare`, preserve
verified bindings and choose fresh paths for failed/interrupted roots. Old
targets and attempt history are retained. Once the coherent writer starts, its
root set is fixed; single-root delegation cannot bypass the aggregate gate.
The equivalent Tasks RPC/SDK uses the same asynchronous checkpoint lifecycle,
not a long synchronous multi-root request.

Native manifests enforce scoped writer ownership and source/target admission;
they are **not an OS sandbox**. Read-only inspection and human Git controls
remain available, while secondary bound executor/terminal admission is fenced.
External host processes can still edit files: coordinate interventions and stop
native writers before doing so. Each root retains durable local checkpoint and
operation receipts. All backup work is explicitly deferred; no backup system
is activated or accepted and no backup restore proof is required in this wave.

## Open bb from another browser

The simplest managed route is **bb connect**. Sign the server in to your bb
account from Settings → bb connect (or `bb account login`, or
`bb connect --code ...` with a dashboard code), then open its getbb.app URL.
The server owns the tunnel and reconnects after restart.

For a private tailnet route, keep bb on its loopback default and publish it
through Tailscale Serve:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:38886
npx bb-app config set BB_APP_URL https://<machine>.<tailnet>.ts.net
```

Start bb with `npx bb-app` and open the HTTPS URL. Tailscale ACLs are the access
boundary for this route; do not expose the server through Funnel or the public
internet. bb connect URLs require the paired account owner's session.

Existing remote host daemons that target a direct tailnet IP or
`http://<machine>.<tailnet>.ts.net:38886` must migrate before restarting an
upgraded server. Prefer pairing bb connect and re-adding the machine from
Settings → Machines so its installer records the account-gated route. The
private alternative is to open bb through the Tailscale Serve URL and re-run
the Add machine installer from there.

For compatibility only, `npx bb-app --server-bind-host 0.0.0.0` restores direct
IPv4 network access. The public API is unauthenticated and permits command
execution and file reads, so use wildcard binding only behind a trusted network
boundary and never through Funnel or the public internet.

Inside a container, `0.0.0.0` listens on the container's IPv4 interfaces; the
container runtime must still publish that port to the host (for example,
`docker run -p 3000:3000 ...`). Host firewall and upstream network rules also
remain separate from bb's bind setting.

### Use editors installed on the browser device

Local editor integration is optional. It connects the remote bb page to the
loopback-only helper started by the bb desktop app or `npx bb-app` on the
computer running the browser. The helper discovers installed editors and opens
paths without exposing its API to the network.

If that browser should open work-host files in its local editor, first make
sure bb is running on the browser device. Verify `ssh <work-host>` succeeds
there, then map the server/work-host to that SSH target:

```bash
npx bb-app client ssh-target set <bb-server-origin> <ssh-target> --host-id <work-host-id>
```

Copy the work-host ID from `bb machine list`. `--host-id` may be omitted when
the server has exactly one machine. A browser running on an enrolled execution
machine needs no SSH mapping for that same machine: connected daemons report
their helper ports to the server, and the browser discovers the matching local
helper after you enable integration.

Then open Settings → Files in that browser and enable **Local editor
integration**. The browser may ask once for permission to connect to software
on the computer. bb does not request that permission during normal remote page
loads; it is only needed for discovering and launching local editors.

If Settings reports that it cannot connect to the helper:

1. Confirm the bb desktop app or `npx bb-app` is running on the browser device.
2. Confirm the browser allows local network access for the bb page.
3. A helper enrolled with this exact server trusts its origin automatically.
   For a separate local bb helper serving a custom HTTPS or Tailscale browser,
   configure that exact origin with
   `npx bb-app config set BB_APP_URL <origin>` and restart bb.
4. Return to Settings → Files and choose **Retry**.

Phones and tablets need no helper; editor-launch actions are simply unavailable.

## Use the bb mobile app

The bb mobile app is a client for a bb server; it runs nothing itself. Over
bb connect it pairs the same way the desktop app does: the phone enrolls as a
connect machine with its own credential, which the getbb.app dashboard lists
and can revoke.

1. Sign the bb server in to your bb account first (Settings → bb account, `bb account login`, or `bb connect --code …`).
2. Mint a pairing code for the phone: Settings → Mobile → **Add mobile device** (QR code plus the code as text, with a countdown), or run
   `bb connect machine-code` (`--json` prints
   `{code, serverUrl, apex, expiresAt}`).
3. In the mobile app, add a server over bb connect and scan the QR code or type
   the code. Codes last 10 minutes and work once.

The phone keeps its credential in the device keychain and mints sessions from
it; it never holds the server's pairing secret. A session lasts seven days and
renews while the phone is in use. To cut a phone off, revoke it in the
getbb.app dashboard machine list; its session stops working within about 20
seconds. Every phone takes one of
the account's machine slots, so a machine-limit error means an unused device
should be revoked first. On a trusted network the app can also use a direct
server URL (Tailscale Serve or `--server-bind-host 0.0.0.0`) with the same
caveats as a browser. What the phone cannot do is listed in
[platform-support.md](platform-support.md#mobile-app).

### Push notifications on a self-hosted server

The built-in Push notifications plugin sends each notification's thread title
and a short plain-text preview through Expo, so a self-hosted server must reach
`https://exp.host`; it needs no Apple or Google key. An Expo push token can only
send notifications to one app installation, but treat it as private. Device
commands are in the `push-notifications` plugin skill; the relay URL and proxy
settings are in [configuration.md](configuration.md).

## Point the desktop app at another bb

The desktop app's Server menu lists "This Mac", every bb connect server on the
account, and a custom URL. When you select a remote server, the app stops
starting a bb server on this Mac. It starts one again only when you select
"This Mac".

To reach bb connect without a local server, the app enrolls itself once as a
connect machine. That step needs the local server, so the first switch to a
remote server still starts it. The app keeps its own credential, encrypted with
the OS keychain, and never holds the server's pairing secret. The app appears in
the getbb.app dashboard machine list, where you can revoke it. After a revoke,
the app drops the credential and asks the local server again.

A remote server has no realtime link for keybindings and theme. The app re-reads
them when it starts, when it becomes active, and every five minutes.

## Add an execution machine

Open Settings → Machines and choose Add a machine. Run the generated one-line
installer on the computer that should
execute work. Choose Windows in the dialog for a PowerShell command; a Windows
machine needs Node.js 22.19 or newer and Git for Windows, and its daemon starts
when you sign in to Windows. It installs and enrolls a host daemon; when bb connect is paired,
the installer also configures the machine credential used to reach the server
through the account gate. Without bb connect, open the server through a
Tailscale Serve URL before generating the installer; the loopback listener is
not directly reachable from another machine. When bb connect is not paired and
the server URL is a loopback or unspecified address, the dialog does not show an
installer. It asks you to set up machine access first by choosing the address
machines should use. Once access is ready, the dialog also names the server
machine the new machine will depend on.

The installer always installs the exact host-only `bb-app` package exposed by
that server at `/install/bb-app.tgz`: the host daemon, provider/plugin workers,
native host dependencies, and bundled `bb` CLI, but no web app or server. A
`bb-app` already on PATH, or the npm registry, is used only when the server
provides no package. The installer verifies the route's SHA-256 digest and
skips reinstalling an identical artifact. Like `/install.sh`, the package route
is public. npm installs the package into the machine's bb data directory, not
its system-wide global prefix, so enrollment needs neither `sudo` nor a PATH
change.

Each joined server gets its own daemon instance, data directory
(`~/.bb-machines/<server-host>`, override with `BB_DATA_DIR` when running the
installer), local API port, and launchd/systemd service. The installer persists
the selected port in that data directory. Subsequent runs reuse it; pass
`--host-daemon-port <port>` to the installer to override the selection. One machine can therefore
serve several bb servers at once, and joining never touches a full local bb
install's `~/.bb`. Each instance keeps its own `bb-app` under that data
directory and self-updates against its own server, so servers running different
bb versions on one machine remain isolated.

On Linux, the installer uses the current user's systemd manager (or a system
unit when run as root on a non-container systemd host). If the user bus is
unavailable on a systemd host, installation fails before enrolling or creating
a unit; rerun it from a systemd user session. In containers and on machines without systemd
as init, the installer runs a detached daemon instead. Set
`BB_INSTALL_SKIP_SERVICE=1` only when a detached daemon is acceptable: no
service starts it after a reboot. The temporary daemon used
for a first join is not supervised. When the installer starts a previously
joined daemon without a service, its launcher restarts it after crashes and
self-updates while the launcher remains running.

The installed launchd/systemd service enables `--auto-update`. If session open
reports a newer server protocol, the daemon downloads the server artifact,
verifies its SHA-256 digest, updates its private install, then exits so the
service manager restarts it. Failed attempts fall back to normal reconnect behavior with a persisted
exponential retry backoff from 5 seconds to 5 minutes. Settings → Machines and
`bb machine retry-update <id-or-name>` can bypass the current backoff. A daemon
never downgrades itself to an older server protocol. To opt out, remove
`--auto-update` from
`~/Library/LaunchAgents/app.getbb.host-daemon.<server>.plist` or
`~/.config/systemd/user/bb-host-daemon-<server>.service`, then reload the
service.

After it connects:

1. To create a project from that machine, choose New project, select the
   machine, and browse to its folder. To map an existing project there instead,
   add its path or clone source in project settings.
2. Select the machine when creating a thread, or use `bb thread spawn --machine
<id-or-name> ...`.
3. Inspect enrolled machines with `bb machine list`.

Machine names are conveniences and may be duplicated; CLI targeting by name
requires an unambiguous match. IDs are always accepted. Removing a machine from
Settings stops bb from dispatching new work to it; revoke a lost machine's bb
connect access from the getbb.app dashboard as well.

Browser access and execution remain independent: opening bb on a laptop does
not enroll that laptop, and enrolling it as a machine does not expose the bb UI.
