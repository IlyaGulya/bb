import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getProject, patchThreadPluginMetadata } from "@bb/db";
import { NATIVE_HISTORY_OWNER } from "@bb/domain";
import { nativeImportManifestSchema } from "@bb/server-contract";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { describe, expect, it } from "vitest";
import { privateAnalyticsMiddleware } from "../../src/services/system/product-analytics-http.js";
import { consumerReport, consumerSdk, installConsumerPlugin, withAnalyticsConsumer } from "../helpers/product-analytics-consumer.js";

const rawPlugin = `import { createHash } from "node:crypto";
export default function plugin(bb) {
  const handler = async (context) => context.json({ digest: createHash("sha256").update(Buffer.from(await context.req.raw.arrayBuffer())).digest("hex") });
  bb.http.route("POST", "/raw", handler, { auth: "none" });
  bb.http.route("POST", "/protected", handler, { auth: "token" });
}`;

describe("analytics request body ownership", () => {
  it("preserves exact noncanonical JSON bytes for an actual plugin raw-body consumer", async () => {
    await withAnalyticsConsumer(async ({ harness, collector, work }) => {
      const { pluginId } = await installConsumerPlugin(harness, rawPlugin);
      const bytes = '{\r\n "duplicate": 1, "duplicate": 2, "text": "\\u0061-owned-raw-plaintext"\r\n}\n';
      const response = await harness.app.request(`/api/v1/plugins/${pluginId}/http/raw`, { method: "POST", headers: { "content-type": "application/json", "x-bb-product-project": work.id }, body: bytes });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ digest: createHash("sha256").update(bytes).digest("hex") });
      expect(JSON.stringify(consumerReport(collector, work.id))).not.toContain("owned-raw-plaintext");
    });
  });

  it("leaves JSON unread when the actual plugin token guard denies admission", async () => {
    await withAnalyticsConsumer(async ({ harness, work }) => {
      const { pluginId } = await installConsumerPlugin(harness, rawPlugin);
      const request = new Request(`http://localhost/api/v1/plugins/${pluginId}/http/protected`, { method: "POST", headers: { "content-type": "application/json", "x-bb-product-project": work.id, "x-bb-plugin-token": "invalid-owned-token" }, body: '{"payload":"must not be read before authentication"}' });
      const response = await harness.app.request(request);
      expect(response.status).toBe(401);
      expect(request.bodyUsed).toBe(false);
      expect(getProject(harness.db, work.id)?.name).toBe(work.name);
    });
  });

  it("does not consume an oversized JSON body before the existing Hono body-limit guard", async () => {
    await withAnalyticsConsumer(async ({ harness, collector, work }) => {
      const app = new Hono();
      app.use("*", privateAnalyticsMiddleware(harness.db, collector));
      app.use("*", bodyLimit({ maxSize: 32 }));
      app.patch("/api/v1/projects/:id", (context) => harness.app.request(context.req.raw));
      const body = JSON.stringify({ name: "must not replace Work", padding: "x".repeat(64) });
      const request = new Request(`http://localhost/api/v1/projects/${work.id}`, { method: "PATCH", headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }, body });
      const response = await app.request(request);
      expect(response.status).toBe(413);
      expect(request.bodyUsed).toBe(false);
      expect(getProject(harness.db, work.id)?.name).toBe(work.name);
    });
  });

  it("keeps a saved native archive action in its owning project despite another ambient project", async () => {
    await withAnalyticsConsumer(async ({ harness, collector, thread, host, work, personal }) => {
      const importId = "a".repeat(64);
      const now = Date.now();
      const manifest = nativeImportManifestSchema.parse({
        version: 1, id: importId, hostId: host.id, projectId: work.id,
        source: { engine: "omp", path: "/owned/work/source.jsonl", rootPath: "/owned/work", profile: "Owned source", artifactRoots: [], sessionId: "owned-native-source", title: "Owned native archive", cwd: "/owned/work", sizeBytes: 0, revision: "owned-empty-source", modifiedAt: now },
        attemptedSource: null, threadId: thread.id, status: "paused", mode: "archive", continuationThreadId: null,
        reason: "Archive only", error: null, bytes: 0, records: 0, nextSequence: 1, sha256: null,
        boundaryBytes: 0, boundarySha256: null, createdAt: now, updatedAt: now, artifacts: [],
      });
      const directory = join(harness.config.dataDir, "native-session-imports", importId);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
      patchThreadPluginMetadata(harness.db, { threadId: thread.id, pluginId: NATIVE_HISTORY_OWNER, remove: [], set: { importId } });
      const sdk = consumerSdk(harness, { actorKind: "human", surface: "web", mode: "production", intentional: true, operationId: randomUUID(), projectId: personal.id });
      expect(await sdk.experimental_nativeSessionImports.cancel({ importId })).toMatchObject({ status: "cancelled", projectId: work.id, threadId: thread.id });
      expect(consumerReport(collector, work.id).rows.find((row) => row.featureId === "core.nativeSessionImports" && row.action === "cancel")).toMatchObject({ attempts: 1, successes: 1, human: 1 });
      for (const projectId of [personal.id, undefined]) expect(consumerReport(collector, projectId).rows.find((row) => row.featureId === "core.nativeSessionImports" && row.action === "cancel")).toMatchObject({ attempts: 0, successes: 0, lastUsedAt: null });
    });
  });
});
