import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostStorageContract } from "./host-contract.js";
import {
  CRITICAL_FREE_BYTES,
  CRITICAL_FREE_RATIO,
  STALE_AFTER_MS,
  criticalFilesystems,
  emptyHealthRecord,
  healthRecordSchema,
  healthState,
  transitionWarning,
  type FleetHealth,
  type HealthRecord,
  type MachineSample,
} from "./health-types.js";

export function createHealth(bb: BbPluginApi) {
  const db = bb.storage.database();
  const worker = bb.hosts.experimental_client({
    contract: hostStorageContract,
  });
  const lifecycle = new AbortController();
  let pending: Promise<FleetHealth> | null = null;
  bb.onDispose(async () => {
    lifecycle.abort();
    await pending?.catch(() => {});
  });
  function read(hostId: string): HealthRecord {
    const row = db
      .prepare<[string], { result_json: string }>(
        "SELECT result_json FROM health WHERE host_id = ?",
      )
      .get(hostId);
    return row
      ? healthRecordSchema.parse(JSON.parse(row.result_json))
      : emptyHealthRecord();
  }
  function store(hostId: string, record: HealthRecord) {
    db.prepare(
      "INSERT INTO health (host_id, result_json) VALUES (?, ?) ON CONFLICT(host_id) DO UPDATE SET result_json = excluded.result_json",
    ).run(hostId, JSON.stringify(record));
  }
  async function fleet(): Promise<FleetHealth> {
    lifecycle.signal.throwIfAborted();
    const hosts = await bb.sdk.hosts.list({ signal: lifecycle.signal });
    let work: Map<string, string[]> | null = null;
    try {
      const threads = await bb.sdk.threads.listRunning({
        signal: lifecycle.signal,
      });
      work = new Map();
      for (const thread of threads) {
        if (thread.hostId === null)
          throw new Error("Active thread host is unknown");
        const ids = work.get(thread.hostId) ?? [];
        ids.push(thread.id);
        work.set(thread.hostId, ids);
      }
    } catch {
      work = null;
    }
    const now = Date.now();
    return {
      observedAt: now,
      staleAfterMs: STALE_AFTER_MS,
      criticalFreeBytes: CRITICAL_FREE_BYTES,
      criticalFreeRatio: CRITICAL_FREE_RATIO,
      hosts: hosts.map((host) => {
        const record = read(host.id);
        const ids = work?.get(host.id) ?? [];
        return {
          ...record,
          hostId: host.id,
          name: host.name,
          hostType: host.type,
          connection: host.status,
          lastSeenAt: host.lastSeenAt,
          state: healthState(host.status, record.observedConnectedAt, now),
          activeWork:
            work === null
              ? null
              : { count: ids.length, threadIds: ids, observedAt: now },
          capacity: null,
        };
      }),
    };
  }
  async function deliver(hostId: string, name: string, record: HealthRecord) {
    try {
      for (const kind of ["disk", "connection"] as const) {
        const warning = kind === "disk" ? record.disk : record.loss;
        if (warning.generation === 0) continue;
        const disk = record.sample ? criticalFilesystems(record.sample) : [];
        await bb.sdk.plugins.callRpc({
          pluginId: "tasks",
          method: "upsertInboxSource",
          signal: lifecycle.signal,
          input: {
            sourceKind: "machine_health",
            sourceKey: `${hostId}:${kind}`,
            revision: `${warning.generation}:${warning.signature}`,
            active: warning.active,
            context: "unknown",
            title:
              kind === "disk"
                ? `Critical disk space on ${name}`
                : `Worker connection lost: ${name}`,
            body:
              kind === "disk"
                ? `Read-only measurement. ${disk.map((fs) => `${fs.kind} ${fs.path}: ${fs.freeBytes} bytes available of ${fs.totalBytes}`).join("; ")}. Last sample: ${record.sample?.measuredAt ?? "unknown"}. Inspect the filesystem; health monitoring does not initiate cleanup.`
                : `Previously observed worker is disconnected. Last successful measurement: ${record.observedConnectedAt ?? "unknown"}. Check the machine and reconnect its worker; no process is stopped or restarted automatically.`,
          },
          outputSchema: z.object({
            item: z.object({
              id: z.string(),
              state: z.enum(["open", "resolved", "snoozed"]),
            }),
            changed: z.boolean(),
          }),
        });
      }
      record.inboxError = null;
    } catch (error) {
      record.inboxError =
        error instanceof Error ? error.message : String(error);
    }
    store(hostId, record);
  }
  async function scan(): Promise<FleetHealth> {
    const hosts = await bb.sdk.hosts.list({ signal: lifecycle.signal });
    const projects = await bb.sdk.projects.list({ signal: lifecycle.signal });
    await Promise.all(
      hosts.map(async (host) => {
        const record = read(host.id);
        const now = Date.now();
        if (record.connection !== host.status) record.connectionChangedAt = now;
        record.connection = host.status;
        if (host.status === "connected") {
          record.attemptedAt = now;
          try {
            const details = await bb.sdk.hosts.get({ hostId: host.id });
            const paths: { path: string; kind: "code" | "data" }[] = [];
            if (details.threadStorageRootPath !== null)
              paths.push({ path: details.threadStorageRootPath, kind: "data" });
            for (const project of projects)
              for (const source of project.sources) {
                if (source.type === "local_path" && source.hostId === host.id)
                  paths.push({ path: source.path, kind: "code" });
              }
            for (let offset = 0; ; offset += 500) {
              const environments = await bb.sdk.environments.list({
                hostId: host.id,
                offset,
                limit: 500,
                signal: lifecycle.signal,
              });
              for (const env of environments)
                if (env.path !== null && env.status !== "destroyed")
                  paths.push({ path: env.path, kind: "code" });
              if (environments.length < 500) break;
            }
            const unique = [
              ...new Map(
                paths.map((entry) => [`${entry.kind}:${entry.path}`, entry]),
              ).values(),
            ];
            let sample: MachineSample | null = null;
            for (
              let offset = 0;
              offset < Math.max(1, unique.length);
              offset += 500
            ) {
              const batch = await worker.call(
                "health",
                { paths: unique.slice(offset, offset + 500) },
                {
                  hostId: host.id,
                  signal: lifecycle.signal,
                  timeoutMs: 30_000,
                },
              );
              sample =
                sample === null
                  ? batch
                  : {
                      ...batch,
                      filesystems: [
                        ...new Map(
                          [...sample.filesystems, ...batch.filesystems].map(
                            (fs) => [`${fs.kind}:${fs.path}`, fs],
                          ),
                        ).values(),
                      ],
                    };
            }
            if (sample === null)
              throw new Error("No health measurement returned");
            record.sample = sample;
            record.observedConnectedAt = Date.now();
            record.error = null;
            const critical = criticalFilesystems(sample);
            const signature = [
              ...new Set(critical.map((fs) => fs.filesystemId ?? fs.path)),
            ]
              .sort()
              .join(",");
            if (
              signature !== "" ||
              (sample.filesystems.length > 0 &&
                sample.filesystems.every((fs) => fs.error === null))
            )
              record.disk = transitionWarning(record.disk, signature);
          } catch (error) {
            record.error =
              error instanceof Error ? error.message : String(error);
          }
        }
        record.loss = transitionWarning(
          record.loss,
          host.status === "disconnected" && record.observedConnectedAt !== null
            ? "disconnected"
            : "",
        );
        lifecycle.signal.throwIfAborted();
        store(host.id, record);
        await deliver(host.id, host.name, record);
      }),
    );
    bb.realtime.publish("health-changed", null);
    return fleet();
  }
  function scanAll() {
    lifecycle.signal.throwIfAborted();
    if (pending === null)
      pending = scan().finally(() => {
        pending = null;
      });
    return pending;
  }
  return { fleet, scanAll };
}
export interface Health {
  fleet(): Promise<FleetHealth>;
  scanAll(): Promise<FleetHealth>;
}
