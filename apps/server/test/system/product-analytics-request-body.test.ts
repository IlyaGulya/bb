import { createHash } from "node:crypto";
import { getProject } from "@bb/db";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { describe, expect, it } from "vitest";
import { privateAnalyticsMiddleware } from "../../src/services/system/product-analytics-http.js";
import { consumerReport, installConsumerPlugin, withAnalyticsConsumer } from "../helpers/product-analytics-consumer.js";

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
});
