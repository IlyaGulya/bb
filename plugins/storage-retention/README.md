# Storage & retention

A bundled, default-disabled plugin. Enable the `bb--storage-retention` plugin. Open Storage & retention in the sidebar.
The native plugin setting `readOnly` defaults to `true`. In this mode the panel
shows fleet health, every destructive RPC/CLI operation rejects, and all effective
retention policies are Never/off even when an older saved policy enables deletion.
The old policy remains stored but cannot run. Explicitly setting `readOnly=false`
restores the maintenance UI and saved policies; do not do that for health-only use.
The plugin owns policy, previews, hourly scheduling, run summaries, UI, and CLI
commands. It uses public SDK thread rows and ordinary lifecycle actions.
The plugin also owns disk measurement in its host worker, scan caching in its own
SQLite database, report assembly, orphan classification, and file deletion.
Core supplies ordinary thread lifecycle actions, machine storage paths, and
environment cleanup retry. The existing core idle orphan sweep is unchanged.
Disabling the plugin stops retention; it does not stop core orphan maintenance.

The machine page offers Clear archived files for whole storage folders, including
small files, from archived, stopped, unpinned threads in the scan. Bulk clearing
keeps conversations and uploaded attachments and requires confirmation. The
matching CLI command is `bb storage clear-archived-files --machine HOST_ID --yes`.

The Clean up section offers Remove instances for `~/.bb-dev` entries whose
source checkout no longer exists. The host re-verifies each checkout is missing,
stops processes whose working directory is inside it, then removes the entry. The
matching CLI command is `bb storage remove-dev-instances --machine HOST_ID --yes`.
Every development row's trash button removes that single entry immediately
(`--instance NAME`), like the thread rows' trash button clears a thread's files.
If the instance's dev server is running (fresh daemon lock), the row asks
"Stop and remove?" first; confirming stops that instance's launcher and
removes it. The CLI's `--yes` covers that confirmation.

Large-file cleanup from the page starts a background job so slow folder walks
can finish after the remote HTTP request returns. Each machine reports running,
completed, or failed status, including after navigation or reconnection. The
`startClearLargeFiles({hostId})` RPC starts the job; pass null for all scanned
online machines. `bb storage usage` exposes `largeFileCleanup` status. The
`clearLargeFiles` RPC and `bb storage clear-large-files` continue to wait for
completion and return deleted file/byte totals.

Cached reports are snapshots; rescan to see external filesystem changes. Bulk
cleanup runs exclusively per machine. Scans run alongside cleanup; a finished
scan leaves out entries cleared while it ran. Different stopped threads
can clear concurrently, while duplicate clears for one thread are rejected.
The UI starts a clear immediately, shows row progress and error toasts,
and keeps other thread actions available. Settings save immediately without
success toasts; failed saves restore the previous value. Concurrent core cleanup tolerates
missing entries. Disk measurement and deletion remain in the plugin host worker. Core emits an environment-removal notification; storage scans and cleanup stay
in the plugin.

The first version pages all nondeleted threads before acting. It intentionally
accepts changes between reading eligibility and applying an action. CLI previews count current candidates, not guaranteed future outcomes.

Two additional cleanup policies default to off. `deleteStorageOnArchive`
queues future archives, waits for the 30-second undo grace, and retries after
reload, thread stop, or host reconnection. Unarchiving cancels cleanup; pinned
threads are skipped. `deleteDevDataOnCheckoutRemoval` scans and removes development
folders whose checkout is missing, including existing folders, while keeping
existing and unidentified sources. Both are available through `bb storage retention`.

Development cleanup reconciles filesystem state on plugin startup, machine
reconnect, and hourly. `experimental_environment.removed` re-measures only the
removing machine's `~/.bb-dev`, queued behind any cleanup already
running there; missed events need no replay or removal-history tables.
Offline/busy machines and failed cleanup retry on subsequent scans. Provider
removal success does not prove the path was deleted; the host always checks
actual filesystem state.

Orphan, development, worktree, and archived-file bulk cleanup can also run as
background jobs. `startCleanup` and `startClearArchivedFiles` start them; `host`
and `hosts` report progress. The CLI offers `bb storage cleanup` for maintenance
jobs and keeps synchronous cleanup commands for callers that need final totals.

## Read-only fleet health

`bb storage health` and RPC `health(null)` return the same cached fleet snapshot
as the panel. `bb storage health --rescan` and RPC `scanHealth(null)` wait for a
fresh read-only measurement of connected enrolled machines. SDK callers use
`sdk.plugins.callRpc({pluginId: "bb--storage-retention", method: "health",
input: null, outputSchema: fleetHealthSchema})`; the schema is exported from
`src/health-types.ts`. Every host, including offline and ephemeral hosts, is listed.
The existing plugin host worker performs measurements; no core monitor, socket
mount, HOME mount, process termination, or retention action is added.

Startup, host connection changes and the native one-minute background schedule
refresh health. Samples persist in the plugin SQLite `health` table. A connected
host with no sample is unknown; a sample at least three minutes old is stale;
a disconnected host is offline. Server last-seen, measurement/attempt and observed
connection-change timestamps are distinct. A failed measurement retains the last
sample and exposes its error, never fabricating current values.

Each reported project source and live environment path is measured independently
with `statfs`, as are thread storage and the worker's plugin data directory.
`freeBytes` is space available to that worker user, not root-only free blocks.
Resolved paths and filesystem device IDs identify shared volumes; repeated paths
must not be summed. Missing/inaccessible paths are unavailable, not an ancestor
filesystem estimate. Unreported paths are not guessed.

Linux and macOS host scope exposes actual OS logical cores, one-minute load average
(not CPU utilization), and total/free RAM. Linux container detection uses runtime
marker files and cgroups. Container CPU is unavailable rather than attributed host
load; RAM is exposed only with a finite usable cgroup limit and usage. Unsupported
or indeterminate scope stays unknown. Container filesystem numbers describe its
mounted filesystem, not a claim about the physical host. Active work counts BB
starting/active threads using the targeted public `threads.running` API (including
hidden work and admission host routing), not all machine processes. An unresolved
running host or failed query makes work counts unavailable. No full thread or
environment listing is needed to read work counts. Capacity is unavailable because
the public API has no worker slot limit.
The RAM field `availableBytes` is qualified by its `basis`: `os-free` means OS free
memory, not Linux cache-adjusted `MemAvailable`; `cgroup-limit-minus-usage` means
remaining container allowance. The UI labels these separately.

At most 5 GiB **or** 5% available is critical (inclusive thresholds). The Tasks
plugin receives `upsertInboxSource` using runtime plugin ID `tasks`, source kind
`machine_health`, and stable keys `<hostId>:disk` / `<hostId>:connection`.
Repeated samples retain the incident revision, so dismissed/snoozed warnings do
not reopen. A recovery resolves that source item only; a later incident advances
the persisted generation. Disk warnings aggregate critical filesystem identities,
not changing byte counts or timestamps. Worker-loss warnings require a previously
successful observation; machines never observed online do not generate noise.
Unavailable disk reads do not resolve an existing critical warning. Tasks being
disabled/unreachable appears as `inboxError`; subsequent scans retry delivery.

Safe activation needs no preliminary policy write: the new `readOnly` setting
defaults true before any hooks run. Confirm `bb storage retention` returns
`readOnly:true`, `archiveAfterDays:null`, `deleteAfterDays:null`,
`deleteStorageOnArchive:false`, `deleteDevDataOnCheckoutRemoval:false`.
Optionally persist those same four policy values with
`bb storage retention --archive-after never --delete-after never --delete-storage-on-archive false --delete-dev-data-on-checkout-removal false --save --yes`.
Keep the native `readOnly` setting true. Core's existing orphan maintenance is
independent and is not disabled or reconfigured.

Deterministic regression cases live in `src/health.test.ts`: inclusive disk/stale
boundaries, unknown values, real temporary-directory filesystem reads, Linux/macOS
wire fixtures, SQLite reload/incident identity, failed delivery retry, loss and
recovery, and destructive-policy suppression. Fixtures use only `host_fixture`
and `/fixture/data`, never real enrolled IDs. Live Linux/macOS acceptance must use
the actual `health --rescan` results, not fixture values.


## TODO

Define cross-plugin thread protection. Automation targets receive no special
exemption yet; pin threads that must be kept. No retention-hold API or Automations
integration ships with this plugin.

Consider general timestamp and lifecycle-owner filters if full enumeration
becomes expensive. No retention-specific query or mutation API is required.
