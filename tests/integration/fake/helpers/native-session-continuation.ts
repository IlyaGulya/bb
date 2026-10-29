import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { saveModelConnection } from "@bb/db";
import { modelConnectionSchema } from "@bb/domain";
import { nativeImportContinueSchema, type NativeImportContinue } from "@bb/server-contract";
import { discoverNativeSessions, readNativeSession } from "../../../../apps/host-daemon/src/command-handlers/native-sessions.js";
import { createTestAppHarness } from "../../../../apps/server/test/helpers/test-app.js";
import { seedEnvironment, seedHostSession, seedProjectWithSource } from "../../../../apps/server/test/helpers/seed.js";
import { reportQueuedCommandSuccess, waitForQueuedCommand } from "../../../../apps/server/test/helpers/commands.js";
import { NativeSessionImports } from "../../../../apps/server/src/services/threads/native-session-imports.js";
import { admitNativeSessionImport } from "../../../../apps/server/src/services/threads/native-session-continuation.js";

const cleanup: (() => Promise<void>)[] = [];
export async function disposeNativeContinuationFixtures() {
  for (const dispose of cleanup.splice(0)) await dispose();
}
export async function createNativeContinuationFixture() {
  const harness = await createTestAppHarness();
  const provider = harness.deps.providerRegistry.get("codex");
  if (!provider) throw new Error("Synthetic Codex provider missing");
  provider.info = { ...provider.info, experimental_executionBindings: { contexts: false, gatewayConnections: false, ...provider.info.experimental_executionBindings, nativeConnections: true } };
  let imports: NativeSessionImports | null = null;
  cleanup.push(async () => { try { await imports?.dispose(); } finally { await harness.cleanup(); } });
  const { host } = seedHostSession(harness.deps);
  const cwd = join(harness.config.dataDir, "synthetic-workspace");
  const root = join(harness.config.dataDir, "synthetic-native-history");
  await mkdir(cwd); await mkdir(root);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id, path: cwd });
  const environment = seedEnvironment(harness.deps, { hostId: host.id, projectId: project.id, path: cwd, isGitRepo: false });
  const nativeId = "synthetic-reviewed-continuation";
  await writeFile(join(root, "source.jsonl"), JSON.stringify({ type: "session_meta", payload: { id: nativeId, cwd } }));
  const page = await discoverNativeSessions({ roots: [{ engine: "codex", path: root, profile: "Synthetic continuation profile", artifactRoots: [] }], cursor: 0, limit: 100 });
  const source = page.sessions[0];
  if (!source) throw new Error(page.warnings.join("; "));
  imports = new NativeSessionImports({ db: harness.db, hub: harness.hub, dataDir: harness.config.dataDir, read: (_host, input, signal) => readNativeSession(input, signal) });
  const manifest = await imports.settle((await imports.start({ hostId: host.id, projectId: project.id, source })).id);
  expect(manifest.status).toBe("ready");
  const connection = saveModelConnection(harness.db, modelConnectionSchema.parse({ id: "synthetic-native-connection", name: "Synthetic native connection", provider: "codex", hostId: host.id, nativeAuth: { configDir: join(harness.config.dataDir, "synthetic-config") }, createdAt: 1, updatedAt: 1 }));
  const request = nativeImportContinueSchema.parse({ importId: manifest.id, environmentId: environment.id, executionContextId: null, modelConnectionId: connection.id, model: "gpt-5", permissionMode: "accept-edits" });
  return { harness, host, project, environment, imports, manifest, connection, request, nativeId };
}
export async function completeNativeAdmission(saved: Awaited<ReturnType<typeof createNativeContinuationFixture>>, input: NativeImportContinue, result: { admitted: true; providerThreadId: string } | { admitted: false; reason: string }) {
  const pending = admitNativeSessionImport(saved.harness.deps, saved.imports, input);
  const next = await Promise.race([
    pending.then((manifest) => ({ queued: null, manifest })),
    waitForQueuedCommand(saved.harness, (queued) => queued.command.type === "native.sessions.admit").then((queued) => ({ queued, manifest: null })),
  ]);
  if (next.queued === null) {
    if (next.manifest === null) throw new Error("Admission completed without a result");
    return next.manifest;
  }
  await reportQueuedCommandSuccess(saved.harness, next.queued, result.admitted ? result : { ...result, ownership: "unclaimed" });
  return pending;
}
