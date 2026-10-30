import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverNativeSessions, readNativeSession } from "./native-sessions.js";

const race = vi.hoisted(() => {
  const state: { afterStat: ((path: string) => Promise<void>) | null } = { afterStat: null };
  return state;
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: async (path: string) => {
    const result = await actual.lstat(path);
    await race.afterStat?.(path);
    return result;
  } };
});
const directories: string[] = [];
afterEach(async () => { race.afterStat = null; for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function fixture() {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "bb-native-race-"));
  directories.push(directory);
  const sessions = join(directory, "sessions");
  const artifacts = join(directory, "artifacts");
  const sub = join(artifacts, "sub");
  const outside = join(directory, "outside");
  await mkdir(sessions); await mkdir(sub, { recursive: true }); await mkdir(outside);
  const header = `${JSON.stringify({ type: "session", id: "synthetic-race-session", cwd: "/synthetic/original-workspace" })}\n`;
  const record = JSON.stringify({ type: "checkpoint", id: "checkpoint", artifactPath: "sub/result.bin" });
  const path = join(sessions, "source.jsonl");
  await writeFile(path, header + record);
  await writeFile(join(sub, "result.bin"), "ALLOWED ORIGINAL ARTIFACT");
  await writeFile(join(outside, "result.bin"), "OUTSIDE FILE MUST NEVER BE RETURNED");
  const discovered = await discoverNativeSessions({ roots: [{ engine: "omp", path: sessions, profile: "Synthetic race profile", artifactRoots: [artifacts] }], cursor: 0, limit: 100 });
  const source = discovered.sessions[0];
  if (!source) throw new Error(discovered.warnings.join("; "));
  return { directory, sub, outside, source, artifact: { reference: "sub/result.bin", recordOffset: Buffer.byteLength(header), recordLength: Buffer.byteLength(record), recordSha256: sha(record), revision: null } };
}

describe("reviewed native source authority", () => {
  it("does not read an outside file when an ancestor is replaced after validation", async () => {
    const saved = await fixture();
    const input = { source: saved.source, offset: 0, length: 256, artifact: saved.artifact };
    const control = await readNativeSession(input);
    expect(Buffer.from(control.content, "base64").toString("utf8")).toBe("ALLOWED ORIGINAL ARTIFACT");
    let swapped = false;
    race.afterStat = async (path) => {
      if (path !== join(saved.sub, "result.bin") || swapped) return;
      swapped = true;
      await rename(saved.sub, join(saved.directory, "original-sub"));
      await symlink(saved.outside, saved.sub);
    };
    let outcome: { kind: "read"; text: string } | { kind: "refused" };
    try { const result = await readNativeSession(input); outcome = { kind: "read", text: Buffer.from(result.content, "base64").toString("utf8") }; }
    catch { outcome = { kind: "refused" }; }
    expect(swapped).toBe(true);
    if (outcome.kind === "read") expect(outcome.text).toBe("ALLOWED ORIGINAL ARTIFACT");
    else expect(outcome).toEqual({ kind: "refused" });
  });

  it("revalidates recorded cwd rather than trusting an edited discovery descriptor", async () => {
    const saved = await fixture();
    await expect(readNativeSession({ source: { ...saved.source, cwd: "/synthetic/different-workspace" }, offset: 0, length: 1, artifact: null })).rejects.toThrow();
  });

  it("revalidates actual source size rather than accepting a forged empty boundary", async () => {
    const saved = await fixture();
    await expect(readNativeSession({ source: { ...saved.source, sizeBytes: 0 }, offset: 0, length: 1, artifact: null })).rejects.toThrow();
  });
});
