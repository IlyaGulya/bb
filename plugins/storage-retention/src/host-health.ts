import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { z } from "zod";
import type { healthPathSchema, MachineSample } from "./health-types.js";
import { isFsErrorWithCode } from "./fs-errors.js";

export async function measureCapacity(target: string, nearestExisting = true) {
  if (!path.isAbsolute(target)) throw new Error("Invalid storage path");
  for (let current = target; ; current = path.dirname(current)) {
    try {
      const stats = await fs.statfs(current);
      return {
        totalBytes: stats.blocks * stats.bsize,
        freeBytes: stats.bavail * stats.bsize,
      };
    } catch (error) {
      if (
        !nearestExisting ||
        !isFsErrorWithCode(error, "ENOENT") ||
        current === path.dirname(current)
      )
        throw error;
    }
  }
}

async function text(file: string) {
  try {
    return (await fs.readFile(file, "utf8")).trim();
  } catch {
    return null;
  }
}

async function scope(): Promise<MachineSample["scope"]> {
  if (process.platform === "darwin") return "host";
  if (process.platform !== "linux") return "unknown";
  for (const marker of ["/.dockerenv", "/run/.containerenv"]) {
    try {
      await fs.access(marker);
      return "container";
    } catch {}
  }
  const cgroup = await text("/proc/1/cgroup");
  if (cgroup === null) return "unknown";
  return /docker|kubepods|containerd|lxc|libpod/.test(cgroup)
    ? "container"
    : "host";
}

async function memory(
  measurementScope: MachineSample["scope"],
): Promise<MachineSample["memory"]> {
  if (measurementScope === "host")
    return {
      totalBytes: os.totalmem(),
      availableBytes: os.freemem(),
      basis: "os-free",
    };
  if (measurementScope !== "container") return null;
  for (const [limitPath, usedPath] of [
    ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory.current"],
    [
      "/sys/fs/cgroup/memory/memory.limit_in_bytes",
      "/sys/fs/cgroup/memory/memory.usage_in_bytes",
    ],
  ] as const) {
    const [limit, used] = await Promise.all([text(limitPath), text(usedPath)]);
    if (
      limit === null ||
      used === null ||
      !/^\d+$/.test(limit) ||
      !/^\d+$/.test(used)
    )
      continue;
    const totalBytes = Number(limit);
    const usage = Number(used);
    if (
      !Number.isSafeInteger(totalBytes) ||
      totalBytes <= 0 ||
      totalBytes > os.totalmem() ||
      !Number.isSafeInteger(usage)
    )
      continue;
    return {
      totalBytes,
      availableBytes: Math.max(0, totalBytes - usage),
      basis: "cgroup-limit-minus-usage",
    };
  }
  return null;
}

export async function measureMachineHealth(
  paths: z.infer<typeof healthPathSchema>[],
  signal: AbortSignal,
): Promise<MachineSample> {
  const measurementScope = await scope();
  const filesystems: MachineSample["filesystems"] = [];
  for (const target of paths) {
    signal.throwIfAborted();
    try {
      if (!path.isAbsolute(target.path))
        throw new Error("Path must be absolute");
      const resolvedPath = await fs.realpath(target.path);
      const [capacity, stats] = await Promise.all([
        measureCapacity(resolvedPath, false),
        fs.stat(resolvedPath),
      ]);
      filesystems.push({
        ...target,
        ...capacity,
        resolvedPath,
        filesystemId: String(stats.dev),
        error: null,
      });
    } catch (error) {
      filesystems.push({
        ...target,
        resolvedPath: null,
        filesystemId: null,
        totalBytes: null,
        freeBytes: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const cpus = measurementScope === "host" ? os.cpus().length : 0;
  const load = os.loadavg()[0];
  return {
    measuredAt: Date.now(),
    platform: process.platform,
    scope: measurementScope,
    cpu:
      cpus > 0 && load !== undefined
        ? { logicalCores: cpus, loadAverage1m: load }
        : null,
    memory: await memory(measurementScope),
    filesystems,
  };
}
