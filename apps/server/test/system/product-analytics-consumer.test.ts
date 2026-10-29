import { randomUUID } from "node:crypto";
import { createTerminalSession, getTerminalSession } from "@bb/db";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { consumerReport, consumerSdk, installConsumerPlugin, withAnalyticsConsumer } from "../helpers/product-analytics-consumer.js";

const readOnlyPlugin = `import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
export default function plugin(bb) {
  bb.rpc.register(defineRpcContract({ inspect: { input: z.object({}), output: z.object({ value: z.string() }) } }), { inspect: () => ({ value: "unchanged" }) });
}`;

describe("analytics explicit observation", () => {
  it("does not count explicit-observe POST mention resolution as an attempt or recent use", async () => {
    await withAnalyticsConsumer(async ({ harness, collector, work, thread }) => {
      const sdk = consumerSdk(harness, { actorKind: "human", surface: "web", mode: "production", intentional: false, projectId: work.id, operationId: randomUUID() });
      const resolved = await sdk.threads.resolveMentions({ threadIds: [thread.id] });
      expect(JSON.stringify(resolved)).toContain(thread.id);
      expect(await sdk.threads.get({ threadId: thread.id })).toMatchObject({ id: thread.id, title: thread.title });
      expect(consumerReport(collector, work.id).rows.find((row) => row.featureId === "core.threads" && row.action === "resolveMentions")).toMatchObject({ attempts: 0, successes: 0, accepted: 0, lastUsedAt: null });
    });
  });

  it("does not turn a registered plugin RPC observer into intentional feature usage", async () => {
    await withAnalyticsConsumer(async ({ harness, collector, work }) => {
      const { pluginId } = await installConsumerPlugin(harness, readOnlyPlugin);
      const sdk = consumerSdk(harness, { actorKind: "human", surface: "web", mode: "production", intentional: false, projectId: work.id, operationId: randomUUID() });
      expect(await sdk.plugins.callRpc({ pluginId, method: "inspect", input: {}, outputSchema: z.object({ value: z.string() }) })).toEqual({ value: "unchanged" });
      expect(consumerReport(collector, work.id).rows.find((row) => row.featureId === `plugin.${pluginId}` && row.action === "rpc.inspect")).toMatchObject({ attempts: 0, successes: 0, accepted: 0, lastUsedAt: null });
    });
  });
});

describe("analytics queued send admission", () => {
  it("reports a real queued thread send as accepted rather than completed successfully", async () => {
    await withAnalyticsConsumer(async ({ harness, collector, work, thread }) => {
      const sdk = consumerSdk(harness, { actorKind: "agent", surface: "sdk", mode: "production", intentional: true, projectId: work.id, operationId: randomUUID() });
      const input = [{ type: "text" as const, text: "owned queued message, never an analytics payload", mentions: [] }];
      const result = await sdk.threads.send({ threadId: thread.id, input, mode: "queue-if-active", model: "gpt-5", permissionMode: "full", serviceTier: "default", reasoningLevel: "medium" });
      expect(result).toMatchObject({ delivery: "queued" });
      expect(consumerReport(collector, work.id).rows.find((row) => row.featureId === "core.threads" && row.action === "send")).toMatchObject({ attempts: 1, accepted: 1, successes: 0, failures: 0, agent: 1 });
      expect(consumerReport(collector, work.id).rows.find((row) => row.featureId === "core.execution" && row.action === "turn")).toMatchObject({ attempts: 0, successes: 0 });
    });
  });
});

describe("analytics actual terminal ownership", () => {
  it.each(["ambient-personal", "missing-ambient"] as const)("attributes terminalId mutation to its Work owner with %s scope", async (scope) => {
    await withAnalyticsConsumer(async ({ harness, collector, host, session, environment, thread, work, personal }) => {
      const terminal = createTerminalSession(harness.db, { cols: 80, rows: 24, daemonSessionId: session.id, environmentId: environment.id, hostId: host.id, initialCwd: environment.path ?? "/owned/work", status: "running", threadId: thread.id, title: "Before rename" });
      const sdk = consumerSdk(harness, { actorKind: "human", surface: "web", mode: "production", intentional: true, operationId: randomUUID(), ...(scope === "ambient-personal" ? { projectId: personal.id } : {}) });
      expect(await sdk.terminals.rename({ terminalId: terminal.id, title: "After rename" })).toMatchObject({ id: terminal.id, title: "After rename" });
      expect(getTerminalSession(harness.db, { kind: "terminal", terminalId: terminal.id })).toMatchObject({ title: "After rename", threadId: thread.id });
      expect(consumerReport(collector, work.id).rows.find((row) => row.featureId === "core.terminals" && row.action === "update")).toMatchObject({ attempts: 1, successes: 1, human: 1 });
      for (const projectId of [personal.id, undefined]) expect(consumerReport(collector, projectId).rows.find((row) => row.featureId === "core.terminals" && row.action === "update")).toMatchObject({ attempts: 0, successes: 0, lastUsedAt: null });
    });
  });
});
