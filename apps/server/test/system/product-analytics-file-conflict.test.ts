import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { productAnalyticsEvents } from "@bb/db";
import { and, eq } from "drizzle-orm";
import { writeHostFile } from "../../../host-daemon/src/command-handlers/file-write.js";
import { rpcContract } from "../../../../plugins/monaco-editor/server.js";
import { reportQueuedCommandSuccess, waitForQueuedCommand } from "../helpers/commands.js";
import { consumerReport, consumerSdk, withAnalyticsConsumer } from "../helpers/product-analytics-consumer.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

describe("analytics genuine file conflict outcomes", () => {
  it.each(["core", "monaco"] as const)("reports a real %s stale-hash conflict as a failure while preserving the file", async (entrypoint) => {
    await withAnalyticsConsumer(async ({ harness, collector, host, work, environment }) => {
      const path = join(harness.config.dataDir, "owned-conflict.txt");
      const original = "current file bytes";
      await writeFile(path, original);
      const sdk = consumerSdk(harness, { actorKind: "human", surface: "web", mode: "production", intentional: true, projectId: work.id, operationId: randomUUID() });
      let pluginId: string | undefined;
      if (entrypoint === "monaco") {
        const plugin = await harness.pluginService.install("builtin:monaco-editor", { kind: "root" });
        if (plugin.status !== "running") throw new Error(`Actual Monaco plugin did not load: ${plugin.statusDetail}`);
        pluginId = plugin.id;
      }
      const pending = pluginId === undefined
        ? sdk.files.write({ hostId: host.id, path, rootPath: harness.config.dataDir, content: "replacement must not be written", contentEncoding: "utf8", expectedSha256: sha256("stale file bytes") })
        : sdk.plugins.callRpc({ pluginId, method: "write", input: { path, content: "replacement must not be written", expectedSha256: sha256("stale file bytes"), source: { kind: "host", threadId: null, projectId: work.id, environmentId: environment.id, experimental_hostId: host.id } }, outputSchema: rpcContract.write.output });
      const queued = await waitForQueuedCommand(harness, (candidate) => candidate.command.type === "host.write_file");
      if (queued.command.type !== "host.write_file") throw new Error("Actual file RPC was not a write command");
      const actual = await writeHostFile(queued.command);
      expect(actual).toEqual({ outcome: "conflict", currentSha256: sha256(original) });
      await reportQueuedCommandSuccess(harness, queued, actual);
      expect(await pending).toMatchObject({ outcome: "conflict", currentSha256: sha256(original) });
      expect(await readFile(path, "utf8")).toBe(original);
      const report = consumerReport(collector, work.id);
      expect(report.rows.find((row) => row.featureId === "core.files" && row.action === "write")).toMatchObject({ attempts: 1, failures: 1, successes: 0, accepted: 0 });
      if (pluginId !== undefined) expect(report.rows.find((row) => row.featureId === `plugin.${pluginId}` && row.action === "rpc.write")).toMatchObject({ attempts: 1, failures: 1, successes: 0, accepted: 0 });
      const identities = [{ featureId: "core.files", action: "write" }];
      if (pluginId !== undefined) identities.push({ featureId: `plugin.${pluginId}`, action: "rpc.write" });
      for (const identity of identities) expect(harness.db.select({ outcome: productAnalyticsEvents.outcome, errorCode: productAnalyticsEvents.errorCode }).from(productAnalyticsEvents).where(and(eq(productAnalyticsEvents.featureId, identity.featureId), eq(productAnalyticsEvents.action, identity.action), eq(productAnalyticsEvents.stage, "completed"))).get()).toEqual({ outcome: "failed", errorCode: "conflict" });
    });
  });
});
