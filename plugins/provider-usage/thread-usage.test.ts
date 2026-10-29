import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { ModelConnection } from "@get-bb/plugin-sdk/app";
import plugin from "./server.js";
import { threadUsageSchema } from "./thread-usage-schema.js";
import { usageFetchMethod, usageListMethod, usageFetchInputSchema, type UsageMeasurement, type UsageResourceList } from "./usage-source-contract.js";

const NOW = 1_000_000;
const RESOURCE_ID = JSON.stringify(["host-owned", "claude-code"]);
const nativeConnection = (): ModelConnection => ({
  id: "connection-owned",
  name: "Owned native Claude",
  provider: "claude-code",
  hostId: "host-owned",
  enabled: true,
  revoked: false,
  nativeAuth: { configDir: null, profile: null, hostEnv: null },
  gateway: null,
  createdAt: 1,
  updatedAt: 1,
});

function fixture(connection = nativeConnection()) {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const state: {
    frozen: ModelConnection;
    current: ModelConnection;
    bound: boolean;
    missing: boolean;
    definitionUnavailable: boolean;
    hostId: string;
    providerId: string;
    connected: boolean;
    nativeMcpConfigDir: string | null;
    sourceAvailable: boolean;
    inventory: UsageResourceList;
    measurement: UsageMeasurement;
  } = {
    frozen: connection,
    current: structuredClone(connection),
    bound: true,
    missing: false,
    definitionUnavailable: false,
    hostId: "host-owned",
    providerId: connection.provider,
    connected: true,
    nativeMcpConfigDir: null,
    sourceAvailable: true,
    inventory: {
      resources: [
        { id: RESOURCE_ID, accountKey: null, providerId: "claude-code", label: "Claude Code", scope: { kind: "host", hostId: "host-owned", hostName: "Owned machine" } },
        { id: JSON.stringify(["host-other", "claude-code"]), accountKey: null, providerId: "claude-code", label: "Other account", scope: { kind: "host", hostId: "host-other", hostName: "Other machine" } },
        { id: "pooled", accountKey: null, providerId: "claude-code", label: "Pool", scope: { kind: "shared" } },
      ],
    },
    measurement: {
      accountKey: "anthropic:account:synthetic",
      observedAt: NOW,
      usage: {
        status: "ok",
        accountEmail: "synthetic@example.invalid",
        planLabel: "Pro",
        plan: { id: "pro", multiplier: null },
        windows: [{ id: "five", kind: "five-hour", label: "Five-hour limit", usedPercent: 42, resetsAt: "2030-01-01T00:00:00Z", model: null, cost: { usedUsdCents: 125, limitUsdCents: 1000 } }],
      },
    },
  };
  let release: (() => void) | null = null;
  let fetchStarted: (() => void) | null = null;
  const started = new Promise<void>((resolve) => { fetchStarted = resolve; });
  let hold = false;
  const sourceRpc = vi.fn(async ({ pluginId, method, input }: { pluginId: string; method: string; input?: unknown }) => {
    if (pluginId !== "provider-claude-code") throw new Error("An unrelated source was queried");
    if (method === usageListMethod) return state.inventory;
    const request = usageFetchInputSchema.parse(input);
    if (request.resourceId !== RESOURCE_ID) throw new Error("An unrelated credential was queried");
    fetchStarted?.();
    if (hold) await new Promise<void>((resolve) => { release = resolve; });
    return state.measurement;
  });
  const host = createFakePluginHost({
    pluginId: "provider-usage",
    sdk: {
      experimental_executionContexts: {
        getThreadEligibility: async ({ threadId }) => {
          const executionContext = state.nativeMcpConfigDir === null ? null : {
            id: "context-owned", name: "Owned context", enabled: true,
            projectIds: ["project-owned"], instructions: "", skillRoots: [], commandRoots: [],
            pluginRoots: [], settingsPaths: [], mcpServers: [], hooksPath: null,
            autoMemory: false, gitIdentity: null, defaultModelConnectionId: null,
            nativeMcpProfile: { configDir: state.nativeMcpConfigDir }, createdAt: 1, updatedAt: 1,
          };
          const binding = state.bound ? {
            threadId, createdAt: 20, modelConnection: state.frozen, executionContext,
          } : null;
          const current = state.missing || state.definitionUnavailable ? null
            : state.current.id === state.frozen.id ? state.current : state.frozen;
          const authorizesHost = (value: ModelConnection) => value.gateway === null
            ? value.hostId === state.hostId : value.gateway.allowedHostIds.includes(state.hostId);
          const issue = state.missing ? { code: "model_connection_not_found", message: "Missing connection" }
            : state.definitionUnavailable ? { code: "model_connection_unavailable", message: "Current connection unavailable" }
            : current?.revoked || state.frozen.revoked ? { code: "model_connection_revoked", message: "Revoked connection" }
            : !current?.enabled || !state.frozen.enabled ? { code: "model_connection_disabled", message: "Disabled connection" }
            : !state.connected ? { code: "execution_host_disconnected", message: "Execution host disconnected" }
            : state.providerId !== state.frozen.provider || current.provider !== state.frozen.provider ||
              !authorizesHost(state.frozen) || !authorizesHost(current)
              ? { code: "model_connection_host_unavailable", message: "Execution route does not authorize this connection" } : null;
          return {
            thread: { id: threadId, projectId: "project-owned", providerId: state.providerId, environmentId: "environment-owned" },
            binding, modelConnection: current, executionContext,
            host: { id: state.hostId, name: "Owned machine", status: state.connected ? "connected" : "disconnected" },
            available: issue === null, issue,
            generation: JSON.stringify([binding, current, state.hostId, state.providerId, state.connected, issue]),
          };
        },
      },
      providers: { list: async () => [{ id: "claude-code", displayName: "Claude Code" }] },
      plugins: {
        experimental_discoverRpc: async () => [
          ...(state.sourceAvailable ? [{ pluginId: "provider-claude-code", displayName: "Claude Code" }] : []),
          { pluginId: "account-pool", displayName: "Account Pooler" },
        ],
        callRpc: sourceRpc,
      },
    },
  });
  plugin(host.bb);
  return {
    state,
    sourceRpc,
    started,
    hold: () => { hold = true; },
    release: () => { release?.(); },
    read: async () => threadUsageSchema.parse(await host.harness.behavior.callRpc("getThreadUsage", { threadId: "thread-owned", force: false })),
    dispose: () => host.harness.lifecycle.dispose(),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("frozen selected-connection usage", () => {
  it("measures the qualifying host-default source, not another host or shared account, and preserves quota/reset/extra-usage observations", async () => {
    const f = fixture();
    try {
      expect(await f.read()).toMatchObject({
        state: "available",
        connection: { id: "connection-owned", name: "Owned native Claude", providerName: "Claude Code", definition: "active" },
        host: { id: "host-owned" },
        source: { pluginId: "provider-claude-code", resourceId: RESOURCE_ID },
        observedAt: NOW,
        usage: { status: "ok", planLabel: "Pro", windows: [{ usedPercent: 42, resetsAt: "2030-01-01T00:00:00Z", cost: { usedUsdCents: 125, limitUsdCents: 1000 } }] },
      });
      expect(f.sourceRpc.mock.calls.filter(([input]) => input.method === usageFetchMethod)).toHaveLength(1);
    } finally { await f.dispose(); }
  });

  it("does not attribute native or pool quota to an explicit OMP gateway connection", async () => {
    const f = fixture({
      ...nativeConnection(), provider: "acp-omp", hostId: null,
      gateway: { baseUrl: "https://synthetic.invalid/v1", protocol: "openai-responses", accountPrefix: "personal", modelProvider: "synthetic", credential: { kind: "env", name: "SYNTHETIC_GATEWAY_KEY" }, allowedHostIds: ["host-owned"] },
    });
    try {
      expect(await f.read()).toMatchObject({ state: "unsupported", connection: { kind: "gateway", providerId: "acp-omp" }, source: null, usage: null });
      expect(f.sourceRpc).not.toHaveBeenCalled();
    } finally { await f.dispose(); }
  });

  it.each([
    { configDir: "/synthetic/profile", profile: null, hostEnv: null },
    { configDir: null, profile: "synthetic-profile", hostEnv: null },
    { configDir: null, profile: null, hostEnv: { brokerUrlEnv: "BROKER_URL", brokerTokenEnv: "BROKER_TOKEN" } },
  ])("refuses host-global quota for native selectors %j", async (nativeAuth) => {
    const f = fixture({ ...nativeConnection(), nativeAuth });
    try {
      expect(await f.read()).toMatchObject({ state: "unsupported", source: null, usage: null });
      expect(f.sourceRpc).not.toHaveBeenCalled();
    } finally { await f.dispose(); }
  });

  it.each(["host", "provider", "mcp-profile", "unbound", "source-disabled", "unproven-resource"])("does not substitute an account when %s prevents association", async (mismatch) => {
    const f = fixture();
    if (mismatch === "host") f.state.hostId = "host-other";
    if (mismatch === "provider") f.state.providerId = "codex";
    if (mismatch === "mcp-profile") f.state.nativeMcpConfigDir = "/synthetic/other-account";
    if (mismatch === "unbound") f.state.bound = false;
    if (mismatch === "source-disabled") f.state.sourceAvailable = false;
    if (mismatch === "unproven-resource") f.state.inventory.resources = f.state.inventory.resources.filter((resource) => resource.id !== RESOURCE_ID);
    try {
      const result = await f.read();
      expect(["unknown", "unsupported"]).toContain(result.state);
      expect(result.usage).toBeNull();
      expect(f.sourceRpc.mock.calls.filter(([input]) => input.method === usageFetchMethod)).toEqual([]);
    } finally { await f.dispose(); }
  });

  it.each(["revoked", "disabled", "missing", "unknown"] as const)("honors the current %s definition without changing the frozen reference", async (state) => {
    const f = fixture();
    if (state === "revoked") f.state.current.revoked = true;
    if (state === "disabled") f.state.current.enabled = false;
    if (state === "missing") f.state.missing = true;
    if (state === "unknown") f.state.definitionUnavailable = true;
    try {
      expect(await f.read()).toMatchObject({ state, connection: { id: "connection-owned", definition: state }, usage: null });
      expect(f.state.frozen).toMatchObject({ id: "connection-owned", enabled: true, revoked: false });
      expect(f.sourceRpc).not.toHaveBeenCalled();
    } finally { await f.dispose(); }
  });

  it("keeps the frozen default-native association when the editable definition changes its name and auth reference", async () => {
    const f = fixture();
    f.state.current = { ...f.state.current, name: "Edited profile", nativeAuth: { configDir: "/synthetic/edited-account", profile: null, hostEnv: null }, updatedAt: 2 };
    try {
      expect(await f.read()).toMatchObject({ state: "available", connection: { name: "Owned native Claude", definition: "changed" }, source: { resourceId: RESOURCE_ID } });
    } finally { await f.dispose(); }
  });

  it.each(["expired", "unauthenticated"] as const)("keeps %s distinct from exhaustion", async (state) => {
    const f = fixture();
    f.state.measurement = { accountKey: null, observedAt: null, usage: { status: state, plan: null, planLabel: null, accountEmail: null } };
    try {
      expect(await f.read()).toMatchObject({ state, usage: { status: state } });
    } finally { await f.dispose(); }
  });

  it("reports exhaustion, unknown observation time, and stale observations without inventing quota", async () => {
    const f = fixture();
    if (f.state.measurement.usage.status !== "ok") throw new Error("Fixture requires usage");
    f.state.measurement.usage.windows[0]!.usedPercent = 103;
    try {
      expect(await f.read()).toMatchObject({ state: "exhausted", usage: { windows: [{ usedPercent: 103 }] } });
      f.state.measurement.observedAt = null;
      expect(await f.read()).toMatchObject({ state: "unknown", usage: null });
      f.state.measurement.observedAt = NOW + 1;
      expect(await f.read()).toMatchObject({ state: "unknown", observedAt: null, usage: null });
      f.state.measurement.observedAt = NOW - 120_001;
      expect(await f.read()).toMatchObject({ state: "stale", observedAt: NOW - 120_001, usage: { windows: [{ usedPercent: 103 }] } });
      f.state.connected = false;
      expect(await f.read()).toMatchObject({ state: "stale", usage: null });
    } finally { await f.dispose(); }
  });

  it("does not turn missing quota windows or a failed collection into zero consumption", async () => {
    const f = fixture();
    if (f.state.measurement.usage.status !== "ok") throw new Error("Fixture requires usage");
    f.state.measurement.usage.windows = [];
    try {
      expect(await f.read()).toMatchObject({ state: "unknown", usage: { status: "ok", windows: [] } });
      f.state.measurement = {
        accountKey: null,
        observedAt: NOW,
        usage: { status: "error", accountEmail: null, planLabel: null, plan: null, message: "Synthetic collection failure" },
      };
      expect(await f.read()).toMatchObject({ state: "stale", observedAt: NOW, usage: null });
      f.state.measurement.observedAt = null;
      expect(await f.read()).toMatchObject({ state: "unknown", observedAt: null, usage: null });
    } finally { await f.dispose(); }
  });

  it.each(["revoke", "replace-binding", "move-environment", "edit-definition"])("discards an in-flight observation after %s", async (change) => {
    const f = fixture();
    f.hold();
    try {
      const pending = f.read();
      await f.started;
      if (change === "revoke") f.state.current = { ...f.state.current, revoked: true };
      if (change === "replace-binding") f.state.frozen = { ...f.state.frozen, id: "new-frozen-connection", nativeAuth: { configDir: "/synthetic/new-account", profile: null, hostEnv: null } };
      if (change === "move-environment") f.state.hostId = "host-other";
      if (change === "edit-definition") f.state.current = { ...f.state.current, name: "Edited while collecting", updatedAt: 2 };
      f.release();
      const result = await pending;
      expect(result.usage).toBeNull();
      expect(result.source).toBeNull();
      expect(result.state).toBe(change === "revoke" ? "revoked" : change === "replace-binding" ? "unsupported" : "unknown");
    } finally { f.release(); await f.dispose(); }
  });
});
