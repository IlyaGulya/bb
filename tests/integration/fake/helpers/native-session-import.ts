import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, noopNotifier, upsertHost } from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import type { JsonValue } from "@bb/domain";
import type { NativeEngine } from "@bb/host-daemon-contract";
import { discoverNativeSessions, readNativeSession } from "../../../../apps/host-daemon/src/command-handlers/native-sessions.js";
import { NativeSessionImports } from "../../../../apps/server/src/services/threads/native-session-imports.js";

const cleanup = new Set<() => Promise<void>>();
export const nativeChecksum = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export async function disposeNativeArchiveFixtures() {
  for (const dispose of cleanup) { cleanup.delete(dispose); await dispose(); }
}
export function nativeHeader(engine: NativeEngine, sessionId: string, cwd: string): JsonValue {
  if (engine === "codex") return { type: "session_meta", title: "Original native title", payload: { id: sessionId, cwd } };
  if (engine === "claude") return { type: "system", subtype: "compact_boundary", title: "Original native title", sessionId, cwd };
  return { type: "session", id: sessionId, title: "Original native title", cwd };
}
export function nativeUser(engine: NativeEngine, sessionId: string, text: string): JsonValue {
  if (engine === "codex") return { type: "response_item", id: "user-a", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } };
  if (engine === "claude") return { type: "user", uuid: "user-a", sessionId, message: { role: "user", content: [{ type: "text", text }] } };
  return { type: "message", id: "user-a", message: { role: "user", content: [{ type: "text", text }] } };
}
export async function createNativeArchiveFixture(options: {
  engine?: NativeEngine;
  records?: (sessionId: string, cwd: string) => JsonValue[];
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "bb-native-reviewed-"));
  const db = createMigratedConnection();
  let imports: NativeSessionImports | null = null;
  cleanup.add(async () => { try { await imports?.dispose(); } finally { db.$client.close(); await rm(directory, { recursive: true, force: true }); } });
  const engine = options.engine ?? "omp";
  const sessionId = `${engine}-synthetic-reviewed-session`;
  const sourceRoot = join(directory, "sessions");
  const leafRoot = join(sourceRoot, "project");
  const artifactRoot = join(directory, "artifacts");
  const cwd = join(directory, "workspace");
  await mkdir(leafRoot, { recursive: true }); await mkdir(artifactRoot); await mkdir(cwd);
  const path = join(leafRoot, "source.jsonl");
  const records = options.records?.(sessionId, cwd) ?? [nativeHeader(engine, sessionId, cwd), nativeUser(engine, sessionId, "Original saved request")];
  const original = records.map((record) => JSON.stringify(record)).join("\n");
  await writeFile(path, original);
  const host = upsertHost(db, noopNotifier, { name: "Synthetic native source" });
  const { project } = createProject(db, noopNotifier, { name: "Synthetic import destination", source: { type: "local_path", hostId: host.id, path: cwd } });
  imports = new NativeSessionImports({ db, hub: noopNotifier, dataDir: join(directory, "core"), read: (_hostId, input, signal) => readNativeSession(input, signal) });
  async function discover(rootPath = sourceRoot) {
    const page = await discoverNativeSessions({ roots: [{ engine, path: rootPath, profile: "Explicit fixture profile", artifactRoots: [artifactRoot] }], cursor: 0, limit: 100 });
    const source = page.sessions.find((entry) => entry.path === path);
    if (!source) throw new Error(`Synthetic source unavailable: ${page.warnings.join("; ")}`);
    return source;
  }
  const source = await discover();
  return { directory, db, imports, host, project, engine, sessionId, sourceRoot, leafRoot, artifactRoot, cwd, path, records, original, source, discover, selection: { hostId: host.id, projectId: project.id, source } };
}
