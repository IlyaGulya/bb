import { z } from "zod";

const bytes = z.number().int().nonnegative();
export const healthPathSchema = z.object({
  path: z.string().min(1),
  kind: z.enum(["code", "data"]),
});
export const filesystemHealthSchema = healthPathSchema.extend({
  resolvedPath: z.string().nullable(),
  filesystemId: z.string().nullable(),
  totalBytes: bytes.nullable(),
  freeBytes: bytes.nullable(),
  error: z.string().nullable(),
});
export const machineSampleSchema = z.object({
  measuredAt: z.number(),
  platform: z.string(),
  scope: z.enum(["host", "container", "unknown"]),
  cpu: z
    .object({
      logicalCores: z.number().int().positive(),
      loadAverage1m: z.number().nonnegative(),
    })
    .nullable(),
  memory: z
    .object({
      totalBytes: bytes,
      availableBytes: bytes,
      basis: z.enum(["os-free", "cgroup-limit-minus-usage"]),
    })
    .nullable(),
  filesystems: z.array(filesystemHealthSchema),
});
export type MachineSample = z.infer<typeof machineSampleSchema>;
export const warningStateSchema = z.object({
  active: z.boolean(),
  generation: z.number().int().nonnegative(),
  signature: z.string(),
});
export const healthRecordSchema = z.object({
  sample: machineSampleSchema.nullable(),
  attemptedAt: z.number().nullable(),
  error: z.string().nullable(),
  observedConnectedAt: z.number().nullable(),
  connectionChangedAt: z.number().nullable(),
  connection: z.enum(["connected", "disconnected"]).nullable(),
  disk: warningStateSchema,
  loss: warningStateSchema,
  inboxError: z.string().nullable(),
});
export type HealthRecord = z.infer<typeof healthRecordSchema>;
export const fleetHostSchema = healthRecordSchema.extend({
  hostId: z.string(),
  name: z.string(),
  hostType: z.enum(["persistent", "ephemeral"]),
  connection: z.enum(["connected", "disconnected"]),
  lastSeenAt: z.number().nullable(),
  state: z.enum(["connected", "stale", "offline", "unknown"]),
  activeWork: z
    .object({
      count: z.number().int().nonnegative(),
      observedAt: z.number(),
      threadIds: z.array(z.string()),
    })
    .nullable(),
  capacity: z.null(),
});
export const fleetHealthSchema = z.object({
  observedAt: z.number(),
  staleAfterMs: z.number(),
  criticalFreeBytes: bytes,
  criticalFreeRatio: z.number(),
  hosts: z.array(fleetHostSchema),
});
export type FleetHealth = z.infer<typeof fleetHealthSchema>;
export const STALE_AFTER_MS = 3 * 60_000;
export const CRITICAL_FREE_BYTES = 5 * 1024 ** 3;
export const CRITICAL_FREE_RATIO = 0.05;

export function emptyHealthRecord(): HealthRecord {
  return {
    sample: null,
    attemptedAt: null,
    error: null,
    observedConnectedAt: null,
    connectionChangedAt: null,
    connection: null,
    inboxError: null,
    disk: { active: false, generation: 0, signature: "" },
    loss: { active: false, generation: 0, signature: "" },
  };
}

export function transitionWarning(
  previous: HealthRecord["disk"],
  signature: string,
): HealthRecord["disk"] {
  const active = signature !== "";
  return {
    active,
    signature,
    generation:
      previous.generation +
      (active && (!previous.active || previous.signature !== signature)
        ? 1
        : 0),
  };
}

export function criticalFilesystems(sample: MachineSample) {
  return sample.filesystems.filter(
    (fs) =>
      fs.freeBytes !== null &&
      fs.totalBytes !== null &&
      fs.totalBytes > 0 &&
      (fs.freeBytes <= CRITICAL_FREE_BYTES ||
        fs.freeBytes / fs.totalBytes <= CRITICAL_FREE_RATIO),
  );
}

export function healthState(
  connection: "connected" | "disconnected",
  observedAt: number | null,
  now: number,
) {
  if (connection === "disconnected") return "offline" as const;
  if (observedAt === null) return "unknown" as const;
  return now - observedAt >= STALE_AFTER_MS
    ? ("stale" as const)
    : ("connected" as const);
}
