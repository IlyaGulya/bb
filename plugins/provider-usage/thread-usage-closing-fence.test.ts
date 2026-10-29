import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { ModelConnection } from "@get-bb/plugin-sdk/app";
import plugin from "./server.js";
import { threadUsageSchema, type ThreadUsage } from "./thread-usage-schema.js";
import {
  usageFetchInputSchema,
  usageFetchMethod,
  usageListMethod,
  type UsageMeasurement,
  type UsageResourceList,
} from "./usage-source-contract.js";

const NOW = 3_000_000;
const THREAD_ID = "thread-closing-owned";
const PROJECT_ID = "project-closing-owned";
const HOST_ID = "host-closing-owned";
const ORIGINAL_ENVIRONMENT_ID = "environment-closing-original";
const REPLACEMENT_ENVIRONMENT_ID = "environment-closing-replacement";
const RESOURCE_ID = JSON.stringify([HOST_ID, "claude-code"]);

function barrier() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  return { entered, released, enter, release };
}

function closingFenceFixture() {
  const connection: ModelConnection = {
    id: "connection-closing-owned",
    name: "Closing native Claude",
    provider: "claude-code",
    hostId: HOST_ID,
    enabled: true,
    revoked: false,
    nativeAuth: { configDir: null, profile: null, hostEnv: null },
    gateway: null,
    createdAt: 1,
    updatedAt: 1,
  };
  const route: {
    environmentId: string;
    hostStatus: "connected" | "disconnected";
  } = { environmentId: ORIGINAL_ENVIRONMENT_ID, hostStatus: "connected" };
  const closingMetadata = barrier();
  let phase: "qualifying" | "quota-fetched" | "closing-metadata" | "released" = "qualifying";
  const inventory: UsageResourceList = {
    resources: [{
      id: RESOURCE_ID,
      providerId: "claude-code",
      accountKey: null,
      label: "Claude Code",
      scope: { kind: "host", hostId: HOST_ID, hostName: "Closing machine" },
    }],
  };
  const measurement: UsageMeasurement = {
    accountKey: "anthropic:account:closing-synthetic",
    observedAt: NOW,
    usage: {
      status: "ok",
      accountEmail: "closing-synthetic@example.invalid",
      plan: null,
      planLabel: null,
      windows: [{
        id: "five-hour",
        kind: "five-hour",
        label: "Five-hour limit",
        usedPercent: 42,
        resetsAt: null,
        model: null,
        cost: null,
      }],
    },
  };
  const { bb, harness } = createFakePluginHost({
    pluginId: "bb--provider-usage",
    sdk: {
      experimental_executionContexts: {
        getThreadEligibility: async ({ threadId }) => ({
          thread: { id: threadId, projectId: PROJECT_ID, providerId: "claude-code", environmentId: route.environmentId },
          binding: { threadId, createdAt: 1, executionContext: null, modelConnection: structuredClone(connection) },
          modelConnection: structuredClone(connection), executionContext: null,
          host: { id: HOST_ID, name: "Closing machine", status: route.hostStatus },
          available: route.hostStatus === "connected",
          issue: route.hostStatus === "connected" ? null : { code: "execution_host_disconnected", message: "Execution host disconnected" },
          generation: JSON.stringify([connection, route.environmentId, route.hostStatus]),
        }),
      },
      providers: {
        list: async () => {
          if (phase === "quota-fetched") {
            phase = "closing-metadata";
            closingMetadata.enter();
            await closingMetadata.released;
            phase = "released";
          }
          return [{ id: "claude-code", displayName: "Claude Code" }];
        },
      },
      plugins: {
        experimental_discoverRpc: async () => [{ pluginId: "provider-claude-code", displayName: "Claude Code" }],
        callRpc: async ({ pluginId, method, input }) => {
          if (pluginId !== "provider-claude-code") throw new Error("Unrelated source was queried");
          if (method === usageListMethod) return inventory;
          if (method !== usageFetchMethod) throw new Error("Unexpected usage-source method");
          const request = usageFetchInputSchema.parse(input);
          if (request.resourceId !== RESOURCE_ID) throw new Error("Unrelated quota resource was queried");
          phase = "quota-fetched";
          return structuredClone(measurement);
        },
      },
    },
  });
  plugin(bb);
  return {
    route,
    closingMetadata,
    async read() {
      return threadUsageSchema.parse(await harness.behavior.callRpc("getThreadUsage", { threadId: THREAD_ID, force: false }));
    },
    dispose: () => harness.lifecycle.dispose(),
  };
}

function expectHistoricalOrUnknown(result: ThreadUsage) {
  expect(["unknown", "stale"]).toContain(result.state);
  if (result.usage?.status === "ok") {
    expect(result.state).toBe("stale");
    expect(result.observedAt).toBe(NOW);
    expect(result.source).toMatchObject({ pluginId: "provider-claude-code", resourceId: RESOURCE_ID });
    expect(result.usage.windows.map((window) => window.usedPercent)).toEqual([42]);
  }
}

afterEach(() => vi.restoreAllMocks());

describe("Stage3 closing execution eligibility", () => {
  it("keeps the qualifying host-default observation when closing name metadata is delayed but routing and host status remain stable", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const fixture = closingFenceFixture();
    try {
      const pending = fixture.read();
      await fixture.closingMetadata.entered;
      fixture.closingMetadata.release();
      expect(await pending).toMatchObject({
        threadId: THREAD_ID,
        state: "available",
        connection: { id: "connection-closing-owned", definition: "active" },
        host: { id: HOST_ID },
        source: { pluginId: "provider-claude-code", resourceId: RESOURCE_ID },
        observedAt: NOW,
        usage: { status: "ok", windows: [{ usedPercent: 42 }] },
      });
    } finally {
      fixture.closingMetadata.release();
      await fixture.dispose();
    }
  });

  it("does not admit current quota after the same thread changes environment on the same host during closing metadata", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const fixture = closingFenceFixture();
    try {
      const pending = fixture.read();
      await fixture.closingMetadata.entered;
      fixture.route.environmentId = REPLACEMENT_ENVIRONMENT_ID;
      fixture.closingMetadata.release();
      expectHistoricalOrUnknown(await pending);
    } finally {
      fixture.closingMetadata.release();
      await fixture.dispose();
    }
  });

  it("does not admit current quota after the execution host disconnects during closing metadata while Core reads remain available", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const fixture = closingFenceFixture();
    try {
      const pending = fixture.read();
      await fixture.closingMetadata.entered;
      fixture.route.hostStatus = "disconnected";
      fixture.closingMetadata.release();
      expectHistoricalOrUnknown(await pending);
    } finally {
      fixture.closingMetadata.release();
      await fixture.dispose();
    }
  });
});
