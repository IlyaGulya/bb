import { execFileSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { spawnPortablePipedProcess } from "./spawn.js";
import {
  stopProcessGroupLeaderFirst,
  supportsProcessGroups,
  type ProcessStopResult,
} from "./process-group.js";

interface ManagedProcessRequest {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fenceIdentity?: boolean;
}

export interface ManagedProcess {
  child: ReturnType<typeof spawnPortablePipedProcess>;
  stop(options?: { gracePeriodMs: number }): Promise<ProcessStopResult>;
}

export function spawnManagedProcess(
  request: ManagedProcessRequest,
): ManagedProcess {
  const { fenceIdentity = false, ...spawnRequest } = request;
  const child = spawnPortablePipedProcess({
    ...spawnRequest,
    detached: supportsProcessGroups(),
  });
  return { child, stop: createProcessStop(child, fenceIdentity) };
}

export function createProcessStop(child: ChildProcess, fenceIdentity = false): ManagedProcess["stop"] {
  const originalIdentity = fenceIdentity && child.pid !== undefined ? readGroupIdentity(child.pid) : null;
  const identityMatches = fenceIdentity ? () => {
    if (child.pid === undefined || originalIdentity === null) return false;
    const current = readGroupIdentity(child.pid);
    if (current === null) return child.exitCode !== null || child.signalCode !== null;
    return current.birth === originalIdentity.birth && current.group === child.pid;
  } : undefined;
  let stopping: Promise<ProcessStopResult> | undefined;
  return function stop({ gracePeriodMs } = { gracePeriodMs: 1_000 }) {
    stopping ??= (async () => {
      if (child.pid === undefined) {
        return { treeTermination: "confirmed" };
      }
      const result = await stopProcessGroupLeaderFirst({
        child,
        timeoutMs: gracePeriodMs,
        killGraceMs: 1_000,
        ...(identityMatches ? { identityMatches } : {}),
      });
      if (child.exitCode === null && child.signalCode === null) {
        throw new Error(`Process did not exit after termination: ${child.pid}`);
      }
      return result;
    })();
    return stopping;
  };
}

function readGroupIdentity(pid: number): { birth: string; group: number } | null {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/);
      const birth = fields[19];
      const group = Number(fields[2]);
      return birth && /^\d+$/.test(birth) && Number.isSafeInteger(group) ? { birth, group } : null;
    }
    if (process.platform !== "win32") {
      const value = execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "pgid="], { encoding: "utf8", timeout: 1_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      const match = value.match(/^(.*?)\s+(\d+)$/);
      return match?.[1] ? { birth: match[1], group: Number(match[2]) } : null;
    }
  } catch {}
  return null;
}

export function isClosedProcessStdinError(error: Error): boolean {
  return (
    "code" in error &&
    (error.code === "EPIPE" ||
      error.code === "EOF" ||
      error.code === "ERR_STREAM_DESTROYED")
  );
}
