import { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { trackChildProcessFixtureExit } from "@bb/test-helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProcessStop } from "../src/managed-process.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  readFileSync: vi.fn(),
}));

function stat(pid: number, birth: number): string {
  const fields = Array<string>(22).fill("0");
  fields[0] = "S";
  fields[2] = String(pid);
  fields[19] = String(birth);
  return `${pid} (synthetic fixture leader) ${fields.join(" ")}`;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(readFileSync).mockReset();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.skipIf(process.platform !== "linux")("managed process identity fences without OS processes", () => {
  it.each(["leaderless reused group", "reused leader birth"] as const)("refuses to signal a %s after the original child exits", async (replacement) => {
    const pid = 9_000_001;
    const child = new ChildProcess();
    Object.defineProperty(child, "pid", { value: pid });
    trackChildProcessFixtureExit(child);
    child.emit("exit", 0, null);
    const childSignal = vi.spyOn(child, "kill").mockReturnValue(true);
    const groupSignal = vi.spyOn(process, "kill").mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementationOnce(() => stat(pid, 100));
    const stop = createProcessStop(child, true);
    vi.mocked(readFileSync).mockImplementation((path) => {
      if (String(path) !== `/proc/${pid}/stat`) throw new Error("Unexpected fixture identity lookup");
      if (replacement === "reused leader birth") return stat(pid, 200);
      throw Object.assign(new Error("Synthetic missing replacement leader"), { code: "ENOENT" });
    });

    const stopping = stop({ gracePeriodMs: 10 });
    await vi.advanceTimersByTimeAsync(1_010);
    expect(await stopping).toEqual({ treeTermination: "unverified" });
    expect(groupSignal.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
    expect(childSignal).not.toHaveBeenCalled();
  });
});
