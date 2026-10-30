import { createHash } from "node:crypto";
import type * as Crypto from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { appendFile, link, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NATIVE_SESSION_CHUNK_BYTES, type NativeSessionSource } from "@bb/host-daemon-contract";
import { discoverNativeSessions, nativeSessionLocations, readNativeSession, readNativeSessionIdentity, snapshotNativeSession } from "./native-sessions.js";

const race = vi.hoisted(() => ({ afterDigest: null as (() => void) | null }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof Crypto>();
  return { ...actual, createHash: (...args: Parameters<typeof actual.createHash>) => new Proxy(actual.createHash(...args), {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      return (...values: unknown[]) => {
        const result: unknown = Reflect.apply(value, target, values);
        if (property === "digest") race.afterDigest?.();
        return result === target ? receiver : result;
      };
    },
  }) };
});
const directories: string[] = [];
beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => {
  race.afterDigest = null;
  vi.advanceTimersByTime(31 * 60 * 1000);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "bb-native-snapshot-fixture-"));
  directories.push(directory);
  const sessions = join(directory, "sessions");
  const stem = join(sessions, "source");
  const blobs = join(directory, "blobs");
  await mkdir(stem, { recursive: true });
  await mkdir(blobs);
  const header = `${JSON.stringify({ type: "session", id: "fixture-original-session", cwd: "/fixture/workspace", title: "Original" })}\n`;
  const record = JSON.stringify({ type: "message", id: "tool-output", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "Retained output\n[Raw output: artifact://25]" }], details: { wallTimeMs: 1 } } });
  const path = join(sessions, "source.jsonl");
  const original = header + record;
  await writeFile(path, original);
  await writeFile(join(stem, "25.bash-original.log"), "original companion bytes");
  const roots = [{ engine: "omp" as const, path: sessions, profile: "Fixture original", artifactRoots: [sessions, blobs] }];
  const discovery = await discoverNativeSessions({ roots, cursor: 0, limit: 100 });
  const source = discovery.sessions[0];
  if (!source) throw new Error(discovery.warnings.join("; "));
  const artifact = { reference: "artifact://25", recordOffset: Buffer.byteLength(header), recordLength: Buffer.byteLength(record), recordSha256: digest(record), revision: null };
  return { directory, sessions, stem, blobs, path, header, record, original, source, artifact };
}
async function bytes(source: NativeSessionSource): Promise<Buffer> {
  const pieces: Buffer[] = [];
  for (let offset = 0; offset < source.sizeBytes; offset += NATIVE_SESSION_CHUNK_BYTES) {
    const result = await readNativeSession({ source, offset, length: NATIVE_SESSION_CHUNK_BYTES, artifact: null });
    expect(result.revision).toBe(source.revision);
    expect(result.sizeBytes).toBe(source.sizeBytes);
    pieces.push(Buffer.from(result.content, "base64"));
  }
  return Buffer.concat(pieces);
}
async function isolatedLocations(directory: string) {
  const home = join(directory, "home");
  await mkdir(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("OMP_PROFILE", "default");
  vi.stubEnv("PI_PROFILE", "");
  vi.stubEnv("PI_CODING_AGENT_DIR", join(directory, "omp"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(directory, "claude"));
  vi.stubEnv("CODEX_HOME", join(directory, "codex"));
  return home;
}

describe("managed native snapshot boundaries", () => {
  it("retains a valid final record without a newline and reads immutable bytes after the source grows", async () => {
    const saved = await fixture();
    const snapshot = await snapshotNativeSession({ source: saved.source, resolveOriginal: false });
    expect(snapshot.snapshotId).toBeTypeOf("string");
    expect(snapshot.path).toBe(saved.source.path);
    expect(snapshot.rootPath).toBe(saved.source.rootPath);
    expect(snapshot.artifactRoots).toEqual(saved.source.artifactRoots);
    await appendFile(saved.path, `\n${JSON.stringify({ type: "message", id: "later", message: { role: "assistant", content: "Later" } })}\n`);
    expect((await bytes(snapshot)).toString()).toBe(saved.original);
    expect((await readFile(saved.path)).length).toBeGreaterThan(snapshot.sizeBytes);
    const reused = await snapshotNativeSession({ source: snapshot, resolveOriginal: false });
    expect(reused.snapshotId).toBe(snapshot.snapshotId);
    expect(reused.sizeBytes).toBe(snapshot.sizeBytes);
    const next = await snapshotNativeSession({ source: saved.source, resolveOriginal: false });
    expect(next.sizeBytes).toBeGreaterThan(snapshot.sizeBytes);
  });

  it.each([Buffer.from('{"type":"message","text":"partial'), Buffer.from([0xf0, 0x9f, 0xa7])])("excludes an incomplete final JSON/UTF8 record without changing complete bytes: %j", async (partial) => {
    const saved = await fixture();
    await appendFile(saved.path, Buffer.concat([Buffer.from("\n"), partial]));
    const snapshot = await snapshotNativeSession({ source: saved.source, resolveOriginal: false });
    expect((await bytes(snapshot)).toString()).toBe(`${saved.original}\n`);
    expect(await readFile(saved.path)).toEqual(Buffer.concat([Buffer.from(`${saved.original}\n`), partial]));
  });

  it("recaptures an expired managed descriptor from the real source instead of trusting stale identity bytes", async () => {
    const saved = await fixture();
    const snapshot = await snapshotNativeSession({ source: saved.source, resolveOriginal: false });
    vi.advanceTimersByTime(31 * 60 * 1000);
    await appendFile(saved.path, '\n{"type":"checkpoint","id":"after-expiry"}\n');
    const resumed = await snapshotNativeSession({ source: snapshot, resolveOriginal: false });
    expect(resumed.snapshotId).not.toBe(snapshot.snapshotId);
    expect((await bytes(resumed)).toString()).toContain("after-expiry");
    await writeFile(saved.path, saved.original.replace("/fixture/workspace", "/changed/workspace"));
    vi.advanceTimersByTime(31 * 60 * 1000);
    await expect(snapshotNativeSession({ source: resumed, resolveOriginal: false })).rejects.toThrow(/workspace changed/);
  });

  it("handles records and UTF8 split across transfer chunks", async () => {
    const saved = await fixture();
    const record = JSON.stringify({ type: "message", id: "large", message: { role: "assistant", content: "🧭".repeat(NATIVE_SESSION_CHUNK_BYTES) } });
    const original = `${saved.header}${record}\n`;
    await writeFile(saved.path, original);
    const snapshot = await snapshotNativeSession({ source: saved.source, resolveOriginal: false });
    expect(await bytes(snapshot)).toEqual(Buffer.from(original));
  });

  it("does not include complete records appended after the captured click boundary", async () => {
    const saved = await fixture();
    race.afterDigest = () => {
      race.afterDigest = null;
      appendFileSync(saved.path, '\n{"type":"checkpoint","id":"later"}\n');
    };
    const snapshot = await snapshotNativeSession({ source: saved.source, resolveOriginal: false });
    expect((await bytes(snapshot)).toString()).toBe(saved.original);
  });

  it("captures an unchanged prefix when the live writer appends during prefix verification", async () => {
    const saved = await fixture();
    let digests = 0;
    race.afterDigest = () => {
      if (++digests === 2) appendFileSync(saved.path, '\n{"type":"checkpoint","id":"appended-during-validation"}\n');
    };
    const snapshot = await snapshotNativeSession({ source: saved.source, resolveOriginal: false });
    expect((await bytes(snapshot)).toString()).toBe(saved.original);
    expect((await readFile(saved.path)).toString()).toContain("appended-during-validation");
  });

  it.each(["title", "conversation"])("rejects %s mutation during copying, including same-length header rewrites", async (kind) => {
    const saved = await fixture();
    race.afterDigest = () => {
      race.afterDigest = null;
      writeFileSync(saved.path, kind === "title" ? saved.original.replace("Original", "Replaced") : saved.original.replace("Retained", "Replaced"));
    };
    await expect(snapshotNativeSession({ source: saved.source, resolveOriginal: false })).rejects.toThrow(/prefix.*changed/);
  });

  it("deduplicates identical captures, renews active reads and expires inactive snapshots", async () => {
    const saved = await fixture();
    const first = await snapshotNativeSession({ source: saved.source, resolveOriginal: false });
    const second = await snapshotNativeSession({ source: saved.source, resolveOriginal: false });
    expect(second.snapshotId).toBe(first.snapshotId);
    vi.advanceTimersByTime(29 * 60 * 1000);
    expect((await bytes(first)).toString()).toBe(saved.original);
    vi.advanceTimersByTime(29 * 60 * 1000);
    expect((await bytes(first)).toString()).toBe(saved.original);
    vi.advanceTimersByTime(31 * 60 * 1000);
    await expect(bytes(first)).rejects.toThrow(/expired/);
  });

  it("reads numeric spills from the original companion directory using frozen record authority", async () => {
    const saved = await fixture();
    const snapshot = await snapshotNativeSession({ source: saved.source, resolveOriginal: false });
    await appendFile(saved.path, '\n{"type":"checkpoint","id":"later"}\n');
    const result = await readNativeSession({ source: snapshot, artifact: saved.artifact, offset: 0, length: 256 });
    expect(Buffer.from(result.content, "base64").toString()).toBe("original companion bytes");
    for (const changed of [{ ...snapshot, artifactRoots: [saved.directory] }, { ...snapshot, cwd: "/forged" }, { ...snapshot, path: join(saved.sessions, "foreign.jsonl") }, { ...snapshot, snapshotId: "unknown" }]) {
      await expect(readNativeSession({ source: changed, artifact: saved.artifact, offset: 0, length: 256 })).rejects.toThrow();
    }
    await expect(readNativeSession({ source: snapshot, artifact: { ...saved.artifact, recordOffset: 1 }, offset: 0, length: 256 })).rejects.toThrow();
  });

  it("allows recovery of a missing companion artifact without relaxing snapshot confinement", async () => {
    const saved = await fixture();
    const snapshot = await snapshotNativeSession({ source: saved.source, resolveOriginal: false });
    const artifactPath = join(saved.stem, "25.bash-original.log");
    await rm(artifactPath);
    const input = { source: snapshot, artifact: saved.artifact, offset: 0, length: 256 };
    await expect(readNativeSession(input)).rejects.toThrow();
    await writeFile(artifactPath, "recovered retained spill");
    const recovered = await readNativeSession(input);
    expect(Buffer.from(recovered.content, "base64").toString()).toBe("recovered retained spill");
    await rm(artifactPath);
    const outside = join(saved.directory, "outside.log");
    await writeFile(outside, "must not be returned");
    await symlink(outside, artifactPath);
    await expect(readNativeSession(input)).rejects.toThrow();
  });

  it("rejects a traversal reference even when the frozen structured record actually contains it", async () => {
    const saved = await fixture();
    const record = JSON.stringify({ type: "checkpoint", artifactPath: "../outside.bin" });
    await writeFile(saved.path, `${saved.header}${record}\n`);
    await writeFile(join(saved.directory, "outside.bin"), "outside private bytes");
    const snapshot = await snapshotNativeSession({ source: { ...saved.source, artifactRoots: [saved.blobs] }, resolveOriginal: false });
    const artifact = { reference: "../outside.bin", recordOffset: Buffer.byteLength(saved.header), recordLength: Buffer.byteLength(record), recordSha256: digest(record), revision: null };
    await expect(readNativeSession({ source: snapshot, artifact, offset: 0, length: 256 })).rejects.toThrow(/outside/);
  });

  it("retains canonical hardlinked OMP image authority in the snapshot record, not in generic paths", async () => {
    const saved = await fixture();
    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ6kAAAAASUVORK5CYII=", "base64");
    const hash = createHash("sha256").update(image).digest("hex");
    const record = JSON.stringify({ type: "message", id: "image", message: { role: "user", content: [{ type: "image", data: `blob:sha256:${hash}`, mimeType: "image/png" }] } });
    await writeFile(saved.path, `${saved.header}${record}\n`);
    await writeFile(join(saved.blobs, hash), image);
    await link(join(saved.blobs, hash), join(saved.blobs, `${hash}.png`));
    const snapshot = await snapshotNativeSession({ source: saved.source, resolveOriginal: false });
    await rm(saved.path);
    const artifact = { reference: hash, recordOffset: Buffer.byteLength(saved.header), recordLength: Buffer.byteLength(record), recordSha256: digest(record), revision: null };
    const result = await readNativeSession({ source: snapshot, artifact, offset: 0, length: 256 });
    expect(Buffer.from(result.content, "base64")).toEqual(image);
    await expect(readNativeSessionIdentity(snapshot)).rejects.toThrow();
  });

  it("does not let a snapshot identity bypass the actual original workspace check", async () => {
    const saved = await fixture();
    const snapshot = await snapshotNativeSession({ source: saved.source, resolveOriginal: false });
    await writeFile(saved.path, saved.original.replace("/fixture/workspace", "/changed/workspace"));
    expect((await bytes(snapshot)).toString()).toBe(saved.original);
    await expect(readNativeSessionIdentity(snapshot)).rejects.toThrow(/workspace changed/);
  });

  it.each(["growth", "title", "partial"])("requires the actual complete live boundary before native admission after %s", async (change) => {
    const saved = await fixture();
    if (change === "partial") await appendFile(saved.path, '\n{"partial":');
    const snapshot = await snapshotNativeSession({ source: saved.source, resolveOriginal: false });
    if (change !== "partial") await expect(readNativeSessionIdentity(snapshot, true)).resolves.toMatchObject({ sessionId: saved.source.sessionId });
    if (change === "growth") await appendFile(saved.path, '\n{"type":"checkpoint","id":"new"}\n');
    if (change === "title") await writeFile(saved.path, saved.original.replace("Original", "Replaced"));
    await expect(readNativeSessionIdentity(snapshot, true)).rejects.toThrow(/captured archive boundary/);
    expect((await bytes(snapshot)).toString()).toBe(change === "partial" ? `${saved.original}\n` : saved.original);
  });

  it("refuses snapshot source symlinks, hardlinks and confinement escapes", async () => {
    const saved = await fixture();
    const alias = join(saved.sessions, "alias.jsonl");
    await symlink(saved.path, alias);
    await expect(snapshotNativeSession({ source: { ...saved.source, path: alias }, resolveOriginal: false })).rejects.toThrow();
    await expect(snapshotNativeSession({ source: { ...saved.source, rootPath: saved.blobs }, resolveOriginal: false })).rejects.toThrow();
    await link(saved.path, join(saved.directory, "outside.jsonl"));
    await expect(snapshotNativeSession({ source: saved.source, resolveOriginal: false })).rejects.toThrow();
  });

  it("rejects cancellation before capture and does not silently accept malformed terminated records", async () => {
    const saved = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(snapshotNativeSession({ source: saved.source, resolveOriginal: false }, controller.signal)).rejects.toThrow();
    await appendFile(saved.path, '\n{"type":broken}\n');
    await expect(snapshotNativeSession({ source: saved.source, resolveOriginal: false })).rejects.toThrow();
  });
});

describe("host native locations and legacy source rebinding", () => {
  it("discovers only existing bounded native default/env/profile directories and reports inaccessible locations", async () => {
    const saved = await fixture();
    const home = await isolatedLocations(saved.directory);
    for (const path of [join(saved.directory, "omp", "sessions"), join(saved.directory, "omp", "blobs"), join(saved.directory, "claude", "projects"), join(saved.directory, "codex", "sessions"), join(home, ".omp", "profiles", "work", "agent", "sessions")]) await mkdir(path, { recursive: true });
    const result = await nativeSessionLocations();
    expect(result.roots.map((root) => root.path)).toEqual(expect.arrayContaining([join(saved.directory, "omp", "sessions"), join(saved.directory, "claude", "projects"), join(saved.directory, "codex", "sessions"), join(home, ".omp", "profiles", "work", "agent", "sessions")]));
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.roots.every((root) => !/auth|credentials/.test(root.path))).toBe(true);
    expect(result.roots.length).toBeLessThanOrEqual(16);
  });

  it("caps configured roots plus defaults at the discover command limit and warns instead of returning unusable input", async () => {
    const saved = await fixture();
    await isolatedLocations(saved.directory);
    const roots = [];
    for (let index = 0; index < 16; index++) {
      const path = join(saved.directory, `configured-${index}`, "sessions");
      await mkdir(path, { recursive: true });
      roots.push({ engine: "omp" as const, path, profile: `Configured ${index}`, artifactRoots: [path] });
    }
    await mkdir(join(saved.directory, "omp", "sessions"), { recursive: true });
    const result = await nativeSessionLocations({ roots });
    expect(result.roots).toEqual(roots);
    expect(result.warnings).toContain("Native location discovery reached its sixteen-root limit; configured roots take priority.");
    const discovered = await discoverNativeSessions({ roots: result.roots, cursor: 0, limit: 100 });
    expect(discovered.sessions).toEqual([]);
  });

  it("refreshes a saved custom ordinary root without requiring default-root enrollment", async () => {
    const saved = await fixture();
    await isolatedLocations(saved.directory);
    await appendFile(saved.path, '\n{"type":"checkpoint","id":"custom-new-record"}\n');
    const snapshot = await snapshotNativeSession({ source: saved.source, resolveOriginal: true });
    expect(snapshot.path).toBe(saved.path);
    expect(snapshot.artifactRoots).toEqual(saved.source.artifactRoots);
    expect((await bytes(snapshot)).toString()).toContain("custom-new-record");
  });

  it("uses safely configured profile roots to resolve a legacy checkpoint outside default locations", async () => {
    const saved = await fixture();
    await isolatedLocations(saved.directory);
    const configuredPath = join(saved.directory, "configured-native-profile", "sessions");
    await mkdir(configuredPath, { recursive: true });
    const livePath = join(configuredPath, "actual.jsonl");
    await writeFile(livePath, `${saved.original}\n{"type":"checkpoint","id":"configured-only-record"}\n`);
    const roots = [{ engine: "omp" as const, path: configuredPath, profile: "Named configured profile", artifactRoots: [configuredPath] }];
    const locations = await nativeSessionLocations({ roots });
    expect(locations.roots).toContainEqual(roots[0]);
    const snapshot = await snapshotNativeSession({ source: { ...saved.source, profile: "Frozen checkpoint" }, resolveOriginal: true, roots });
    expect(snapshot.path).toBe(livePath);
    expect((await bytes(snapshot)).toString()).toContain("configured-only-record");
  });

  it("never follows a configured session-root symlink or treats a configured frozen root as the original", async () => {
    const saved = await fixture();
    await isolatedLocations(saved.directory);
    const alias = join(saved.directory, "aliased-sessions");
    await symlink(saved.sessions, alias);
    const roots = [{ engine: "omp" as const, path: alias, profile: "Configured alias", artifactRoots: [] }];
    expect((await nativeSessionLocations({ roots })).roots).toEqual([]);
    await expect(snapshotNativeSession({ source: { ...saved.source, profile: "Frozen checkpoint" }, resolveOriginal: true, roots: [{ ...roots[0]!, path: saved.sessions, profile: "Frozen checkpoint" }] })).rejects.toThrow(/original native session is unavailable/);
  });

  it("rebinds a frozen checkpoint by exact engine/session/workspace to the actual known original", async () => {
    const saved = await fixture();
    await isolatedLocations(saved.directory);
    const originalRoot = join(saved.directory, "omp", "sessions");
    await mkdir(originalRoot, { recursive: true });
    const originalPath = join(originalRoot, "live.jsonl");
    await writeFile(originalPath, `${saved.original}\n{"type":"checkpoint","id":"new-live-record"}\n`);
    const snapshot = await snapshotNativeSession({ source: { ...saved.source, profile: "Frozen read-only checkpoint" }, resolveOriginal: true });
    expect(snapshot.path).toBe(originalPath);
    expect(snapshot.rootPath).toBe(originalRoot);
    expect((await bytes(snapshot)).toString()).toContain("new-live-record");
    await rm(originalPath);
    await expect(snapshotNativeSession({ source: snapshot, resolveOriginal: true })).rejects.toThrow(/original native session is unavailable/);
  });

  it("rejects ambiguous originals instead of preferring the frozen or previously selected pathname", async () => {
    const saved = await fixture();
    await isolatedLocations(saved.directory);
    const originalRoot = join(saved.directory, "omp", "sessions");
    await mkdir(originalRoot, { recursive: true });
    await writeFile(join(originalRoot, "one.jsonl"), saved.original);
    await writeFile(join(originalRoot, "two.jsonl"), saved.original);
    await expect(snapshotNativeSession({ source: { ...saved.source, profile: "Frozen checkpoint" }, resolveOriginal: true })).rejects.toThrow(/More than one original/);
  });

  it("never falls back to an arbitrary frozen source when no known original exists", async () => {
    const saved = await fixture();
    await isolatedLocations(saved.directory);
    await expect(snapshotNativeSession({ source: { ...saved.source, profile: "checkpoint" }, resolveOriginal: true })).rejects.toThrow(/Original native session locations are unavailable/);
    expect(await readFile(saved.path, "utf8")).toBe(saved.original);
  });
});

describe("recent native discovery pages", () => {
  it("orders by newest metadata before the first hundred, ties by path, skips companion/subagent sessions and retains branch files", async () => {
    const saved = await fixture();
    await utimes(saved.path, 1, 1);
    const paths: string[] = [];
    for (let index = 0; index < 103; index++) {
      const path = join(saved.sessions, `session-${String(index).padStart(3, "0")}.jsonl`);
      await writeFile(path, JSON.stringify({ type: "session", id: `recent-${index}`, cwd: "/fixture/workspace" }));
      const modified = index >= 101 ? 1000 : 100 + index;
      await utimes(path, modified, modified);
      paths.push(path);
    }
    const branches = join(saved.sessions, "branches");
    const subagents = join(saved.sessions, "subagents");
    await mkdir(branches);
    await mkdir(subagents);
    const branch = join(branches, "branch.jsonl");
    await writeFile(branch, JSON.stringify({ type: "session", id: "legitimate-branch", cwd: "/fixture/workspace" }));
    await utimes(branch, 50, 50);
    for (const path of [join(saved.stem, "nested-native.jsonl"), join(subagents, "child.jsonl")]) {
      await writeFile(path, JSON.stringify({ type: "session", id: "not-an-ordinary-dialog", cwd: "/fixture/workspace" }));
      await utimes(path, 9000, 9000);
    }
    const roots = [{ engine: "omp" as const, path: saved.sessions, profile: "Recent fixture", artifactRoots: [saved.sessions] }];
    const first = await discoverNativeSessions({ roots, cursor: 0, limit: 100 });
    expect(first.sessions).toHaveLength(100);
    expect(first.sessions.slice(0, 3).map((source) => source.path)).toEqual([paths[101], paths[102], paths[100]]);
    expect(first.nextCursor).toBe(100);
    const second = await discoverNativeSessions({ roots, cursor: first.nextCursor!, limit: 100 });
    expect(second.sessions.map((source) => source.path)).toEqual([paths[2], paths[1], paths[0], branch, saved.path]);
    expect(second.nextCursor).toBeNull();
    expect([...first.sessions, ...second.sessions].some((source) => source.sessionId === "not-an-ordinary-dialog")).toBe(false);
    const controller = new AbortController();
    controller.abort();
    await expect(discoverNativeSessions({ roots, cursor: 100, limit: 100 }, controller.signal)).rejects.toThrow();
  });
});
