// @vitest-environment jsdom
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeHostResponse,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { ExecutionContext, ModelConnection } from "@get-bb/plugin-sdk/app";
import plugin from "./server.js";
import {
  threadUsageInputSchema,
  threadUsageSchema,
  type ThreadUsage,
} from "./thread-usage-schema.js";
import {
  usageFetchInputSchema,
  usageFetchMethod,
  usageListMethod,
  type UsageMeasurement,
  type UsageResourceList,
} from "./usage-source-contract.js";

const CLOCK_ORIGIN = 2_000_000;
const HOST_ID = "host-review-owned";
const RESOURCE_ID = JSON.stringify([HOST_ID, "claude-code"]);

type ContextAvailability = "enabled" | "disabled" | "deleted" | "unavailable";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function nativeConnection(): ModelConnection {
  return {
    id: "connection-review-owned",
    name: "Review native Claude",
    provider: "claude-code",
    hostId: HOST_ID,
    enabled: true,
    revoked: false,
    nativeAuth: { configDir: null, profile: null, hostEnv: null },
    gateway: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function nativeContext(): ExecutionContext {
  return {
    id: "context-review-owned",
    name: "Review instructions",
    enabled: true,
    projectIds: ["project-review-owned"],
    instructions: "",
    skillRoots: [],
    commandRoots: [],
    pluginRoots: [],
    settingsPaths: [],
    mcpServers: [],
    hooksPath: null,
    autoMemory: false,
    gitIdentity: null,
    defaultModelConnectionId: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function measuredUsage(observedAt = CLOCK_ORIGIN, usedPercent = 42): UsageMeasurement {
  return {
    accountKey: "anthropic:account:review-synthetic",
    observedAt,
    usage: {
      status: "ok",
      accountEmail: "review-synthetic@example.invalid",
      plan: null,
      planLabel: null,
      windows: [{
        id: "five-hour",
        kind: "five-hour",
        label: "Five-hour limit",
        usedPercent,
        resetsAt: null,
        model: null,
        cost: null,
      }],
    },
  };
}

function consumerFixture({
  scoped = true,
  connection = nativeConnection(),
}: { scoped?: boolean; connection?: ModelConnection } = {}) {
  const frozenContext = scoped ? nativeContext() : null;
  const state: {
    context: ContextAvailability;
    measurement: UsageMeasurement;
  } = { context: "enabled", measurement: measuredUsage() };
  let heldMeasurement: {
    started: ReturnType<typeof deferred<void>>;
    released: ReturnType<typeof deferred<void>>;
  } | null = null;
  const inventory: UsageResourceList = {
    resources: [{
      id: RESOURCE_ID,
      providerId: "claude-code",
      accountKey: null,
      label: "Claude Code",
      scope: { kind: "host", hostId: HOST_ID, hostName: "Review machine" },
    }],
  };
  const sourceRpc = vi.fn(async ({
    pluginId,
    method,
    input,
  }: { pluginId: string; method: string; input?: unknown }) => {
    if (pluginId !== "provider-claude-code")
      throw new Error("Unrelated source was queried");
    if (method === usageListMethod) return inventory;
    if (method !== usageFetchMethod) throw new Error("Unexpected source method");
    const request = usageFetchInputSchema.parse(input);
    if (request.resourceId !== RESOURCE_ID)
      throw new Error("Unrelated account was queried");
    const measurement = structuredClone(state.measurement);
    const held = heldMeasurement;
    heldMeasurement = null;
    if (held !== null) {
      held.started.resolve(undefined);
      await held.released.promise;
    }
    return measurement;
  });
  const { bb, harness } = createFakePluginHost({
    pluginId: "bb--provider-usage",
    sdk: {
      experimental_executionContexts: {
        getThreadBinding: async ({ threadId }) => ({
          threadId,
          createdAt: 1,
          executionContext: frozenContext,
          modelConnection: connection,
        }),
        get: async ({ id }) => {
          if (frozenContext === null || id !== frozenContext.id || state.context === "deleted")
            throw Object.assign(new Error("Context missing"), { status: 404 });
          if (state.context === "unavailable") throw new Error("Context lookup unavailable");
          return { ...frozenContext, enabled: state.context !== "disabled" };
        },
      },
      experimental_modelConnections: {
        get: async ({ id }) => {
          if (id !== connection.id) throw new Error("Unrelated connection requested");
          return connection;
        },
      },
      threads: {
        get: async ({ threadId }) => makeThreadResponse({
          id: threadId,
          projectId: "project-review-owned",
          providerId: connection.provider,
          environmentId: "environment-review-owned",
        }),
      },
      environments: {
        get: async () => ({ id: "environment-review-owned", hostId: HOST_ID }),
      },
      hosts: {
        get: async ({ hostId }) => {
          if (hostId !== HOST_ID) throw new Error("Unrelated host requested");
          return makeHostResponse({ id: HOST_ID, name: "Review machine", status: "connected" });
        },
      },
      providers: {
        list: async () => [{ id: connection.provider, displayName: connection.provider === "claude-code" ? "Claude Code" : "OMP" }],
      },
      plugins: {
        experimental_discoverRpc: async () => [{ pluginId: "provider-claude-code", displayName: "Claude Code" }],
        callRpc: sourceRpc,
      },
    },
  });
  plugin(bb);
  return {
    state,
    sourceRpc,
    holdNextMeasurement() {
      const held = { started: deferred<void>(), released: deferred<void>() };
      heldMeasurement = held;
      return {
        started: held.started.promise,
        release: () => held.released.resolve(undefined),
      };
    },
    async read(threadId = "thread-review-owned") {
      return threadUsageSchema.parse(await harness.behavior.callRpc("getThreadUsage", { threadId, force: false }));
    },
    dispose: () => harness.lifecycle.dispose(),
  };
}

async function mountSelected(
  fixture: ReturnType<typeof consumerFixture>,
  threadId = "thread-review-owned",
) {
  const { SelectedThreadUsage } = await import("./app");
  const completions = new Map<string, ReturnType<typeof deferred<ThreadUsage>>>();
  const completion = (id: string) => {
    let pending = completions.get(id);
    if (pending === undefined) {
      pending = deferred<ThreadUsage>();
      completions.set(id, pending);
    }
    return pending;
  };
  const props = {
    threadId,
    pluginId: "bb--provider-usage",
    snapshot: { data: null, error: null, isRefreshing: false },
    threadMachineId: HOST_ID,
    dismiss: vi.fn(),
  };
  const slot = renderSlot({ component: SelectedThreadUsage }, props, {
    pluginId: "bb--provider-usage",
    rpc: {
      getThreadUsage: async (raw: unknown) => {
        const request = threadUsageInputSchema.parse(raw);
        try {
          const result = await fixture.read(request.threadId);
          completion(request.threadId).resolve(result);
          return result;
        } catch (cause) {
          completion(request.threadId).reject(cause);
          throw cause;
        }
      },
    },
  });
  await act(async () => { await completion(threadId).promise; });
  return { slot, props, completion, SelectedThreadUsage };
}

function visibleText(region: HTMLElement) {
  const visible = region.cloneNode(true);
  if (!(visible instanceof HTMLElement)) throw new Error("Missing usage region");
  for (const hidden of visible.querySelectorAll("details, [hidden], [aria-hidden='true']"))
    hidden.remove();
  return visible.textContent ?? "";
}

function showsNoncurrentState(region: HTMLElement) {
  return within(region).getAllByRole("status").some((status) =>
    /stale|unknown|loading|unavailable/i.test(`${status.textContent} ${status.getAttribute("aria-label") ?? ""}`),
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Stage1 context availability", () => {
  it.each([false, true])("preserves qualifying native usage with scoped=%s when the current context is legitimately available", async (scoped) => {
    vi.spyOn(Date, "now").mockReturnValue(CLOCK_ORIGIN);
    const fixture = consumerFixture({ scoped });
    try {
      expect(await fixture.read()).toMatchObject({
        state: "available",
        source: { pluginId: "provider-claude-code", resourceId: RESOURCE_ID },
        usage: { status: "ok", windows: [{ usedPercent: 42 }] },
      });
    } finally { await fixture.dispose(); }
  });

  it("keeps an enabled scoped gateway connection unsupported instead of borrowing native quota", async () => {
    const fixture = consumerFixture({ connection: {
      ...nativeConnection(),
      provider: "acp-omp",
      hostId: null,
      gateway: {
        baseUrl: "https://review-synthetic.invalid/v1",
        protocol: "openai-responses",
        accountPrefix: "review",
        modelProvider: "synthetic",
        credential: { kind: "env", name: "REVIEW_SYNTHETIC_KEY" },
        allowedHostIds: [HOST_ID],
      },
    } });
    try {
      expect(await fixture.read()).toMatchObject({ state: "unsupported", usage: null, source: null });
      expect(fixture.sourceRpc).not.toHaveBeenCalled();
    } finally { await fixture.dispose(); }
  });

  it.each(["disabled", "deleted", "unavailable"] as const)("blocks a currently %s frozen context before any source query", async (availability) => {
    vi.spyOn(Date, "now").mockReturnValue(CLOCK_ORIGIN);
    const fixture = consumerFixture();
    fixture.state.context = availability;
    try {
      const result = await fixture.read();
      expect(result.usage).toBeNull();
      expect(result.source).toBeNull();
      expect(["disabled", "missing", "unknown"]).toContain(result.state);
      expect(fixture.sourceRpc).not.toHaveBeenCalled();
    } finally { await fixture.dispose(); }
  });

  it.each(["disabled", "deleted", "unavailable"] as const)("does not repopulate quota when the current context becomes %s during collection", async (availability) => {
    vi.spyOn(Date, "now").mockReturnValue(CLOCK_ORIGIN);
    const fixture = consumerFixture();
    let held: ReturnType<typeof fixture.holdNextMeasurement> | null = null;
    try {
      expect(await fixture.read()).toMatchObject({ state: "available", usage: { windows: [{ usedPercent: 42 }] } });
      held = fixture.holdNextMeasurement();
      const pending = fixture.read();
      await held.started;
      fixture.state.context = availability;
      held.release();
      const result = await pending;
      expect(result.usage).toBeNull();
      expect(result.source).toBeNull();
      expect(["disabled", "missing", "unknown"]).toContain(result.state);
      fixture.sourceRpc.mockClear();
      expect((await fixture.read()).usage).toBeNull();
      expect(fixture.sourceRpc).not.toHaveBeenCalled();
    } finally { held?.release(); await fixture.dispose(); }
  });
});

describe("Stage1 collected-source provenance", () => {
  it.each(["available", "exhausted", "expired", "unauthenticated", "not_installed", "error", "stale", "no-limits"] as const)("visibly qualifies %s as a host-default observation rather than physical turn-credential proof", async (reported) => {
    vi.spyOn(Date, "now").mockReturnValue(CLOCK_ORIGIN);
    const fixture = consumerFixture();
    if (reported === "exhausted") fixture.state.measurement = measuredUsage(CLOCK_ORIGIN, 103);
    if (reported === "stale") fixture.state.measurement = measuredUsage(CLOCK_ORIGIN - 120_001);
    if (reported === "no-limits" && fixture.state.measurement.usage.status === "ok")
      fixture.state.measurement.usage.windows = [];
    if (reported === "expired" || reported === "unauthenticated" || reported === "not_installed")
      fixture.state.measurement.usage = { status: reported, accountEmail: null, plan: null, planLabel: null };
    if (reported === "error")
      fixture.state.measurement.usage = { status: "error", accountEmail: null, plan: null, planLabel: null, message: "Synthetic collection failure" };
    try {
      const { slot } = await mountSelected(fixture);
      const region = slot.getByRole("region", { name: "Selected model connection usage" });
      const text = visibleText(region);
      expect(text).toMatch(/host[- ]default/i);
      expect(text).toMatch(/observation/i);
      expect(text).toMatch(/\bnot\b[\s\S]*(?:physical[\s\S]*credential|turn[\s\S]*credential)|does not[\s\S]*(?:prove|identify)/i);
    } finally { await fixture.dispose(); }
  });
});

describe("Stage1 observed-time freshness", () => {
  it("expires a fifty-second-old observation at its sixty-second deadline without waiting for a pending two-minute refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(CLOCK_ORIGIN);
    const fixture = consumerFixture();
    fixture.state.measurement = measuredUsage(CLOCK_ORIGIN - 50_000);
    let held: ReturnType<typeof fixture.holdNextMeasurement> | null = null;
    try {
      const { slot } = await mountSelected(fixture);
      const region = slot.getByRole("region", { name: "Selected model connection usage" });
      expect(within(region).getByText("42%")).toBeDefined();
      expect(showsNoncurrentState(region)).toBe(false);
      held = fixture.holdNextMeasurement();
      await act(async () => { await vi.advanceTimersByTimeAsync(9_999); });
      expect(showsNoncurrentState(region)).toBe(false);
      await act(async () => { await vi.advanceTimersByTimeAsync(2); });
      expect(showsNoncurrentState(region)).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(110_000); });
      await held.started;
      expect(showsNoncurrentState(region)).toBe(true);
      slot.lifecycle.unmount();
    } finally { held?.release(); await fixture.dispose(); }
  });

  it("does not apply the previous thread's observation deadline to a fresh newly selected thread", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(CLOCK_ORIGIN);
    const fixture = consumerFixture();
    fixture.state.measurement = measuredUsage(CLOCK_ORIGIN - 50_000);
    try {
      const { slot, props, completion, SelectedThreadUsage } = await mountSelected(fixture, "thread-review-old");
      expect(slot.getByText("42%")).toBeDefined();
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      fixture.state.measurement = measuredUsage(Date.now(), 71);
      slot.lifecycle.rerender(<SelectedThreadUsage {...props} threadId="thread-review-current" />);
      await act(async () => { await completion("thread-review-current").promise; });
      const region = slot.getByRole("region", { name: "Selected model connection usage" });
      expect(within(region).getByText("71%")).toBeDefined();
      await act(async () => { await vi.advanceTimersByTimeAsync(5_001); });
      expect(within(region).getByText("71%")).toBeDefined();
      expect(showsNoncurrentState(region)).toBe(false);
      await act(async () => { await vi.advanceTimersByTimeAsync(54_998); });
      expect(within(region).getByText("71%")).toBeDefined();
      expect(showsNoncurrentState(region)).toBe(false);
      slot.lifecycle.unmount();
    } finally { await fixture.dispose(); }
  });

  it("does not let a late old-thread refresh replace a fresh current-thread observation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(CLOCK_ORIGIN);
    const fixture = consumerFixture();
    fixture.state.measurement = measuredUsage(CLOCK_ORIGIN - 50_000);
    let held: ReturnType<typeof fixture.holdNextMeasurement> | null = null;
    try {
      const { slot, props, completion, SelectedThreadUsage } = await mountSelected(fixture, "thread-review-old");
      expect(slot.getByText("42%")).toBeDefined();
      await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
      held = fixture.holdNextMeasurement();
      fireEvent.click(slot.getByRole("button", { name: "Reload selected account usage" }));
      await held.started;
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      fixture.state.measurement = measuredUsage(Date.now(), 71);
      slot.lifecycle.rerender(<SelectedThreadUsage {...props} threadId="thread-review-current" />);
      await act(async () => { await completion("thread-review-current").promise; });
      const region = slot.getByRole("region", { name: "Selected model connection usage" });
      expect(within(region).getByText("71%")).toBeDefined();
      expect(showsNoncurrentState(region)).toBe(false);
      await act(async () => { await vi.advanceTimersByTimeAsync(5_001); });
      expect(within(region).getByText("71%")).toBeDefined();
      expect(showsNoncurrentState(region)).toBe(false);
      await act(async () => { held?.release(); });
      expect(within(region).queryByText("42%")).toBeNull();
      expect(within(region).getByText("71%")).toBeDefined();
      expect(showsNoncurrentState(region)).toBe(false);
      slot.lifecycle.unmount();
    } finally { held?.release(); await fixture.dispose(); }
  });
});
