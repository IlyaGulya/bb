// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, mountPluginContentScripts, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { threadUsageInputSchema, type ThreadUsage } from "./thread-usage-schema.js";
import type { UsageProvider } from "./usage-schema.js";

function observation(threadId = "thread-owned", usedPercent = 42): ThreadUsage {
  return {
    threadId,
    bindingCreatedAt: 1,
    connection: { id: "native-owned", name: "Owned native Claude", providerId: "claude-code", providerName: "Claude Code", kind: "native", definition: "active" },
    host: { id: "host-owned", name: "Owned machine" },
    state: "available",
    reason: "Host-default observation, not a turn credential receipt.",
    source: { pluginId: "provider-claude-code", name: "Claude Code", resourceId: JSON.stringify(["host-owned", "claude-code"]) },
    observedAt: 1_000_000,
    usage: {
      status: "ok", accountEmail: "owned@example.invalid", planLabel: "Pro",
      windows: [{ label: "Five-hour limit", usedPercent, resetsAt: null, cost: null }],
    },
  };
}

function unavailable(threadId = "thread-owned"): ThreadUsage {
  return {
    ...observation(threadId),
    connection: { id: "gateway-owned", name: "Personal OMP", providerId: "acp-omp", providerName: "OMP", kind: "gateway", definition: "active" },
    state: "unsupported",
    reason: "No exact permitted gateway account quota source exists.",
    source: null,
    observedAt: null,
    usage: null,
  };
}

async function disclosure() {
  const app = await loadPluginApp(() => import("./app"));
  const item = app.experimentalSidebarFooterItems[0];
  if (item?.kind !== "disclosure") throw new Error("Missing usage disclosure");
  return { app, item };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("defaults to the selected gateway despite cached native/pool quota and requires explicit separate maintenance browsing", async () => {
  const account: UsageProvider = {
    id: "unrelated-pool", providerId: "claude-code", displayName: "Claude Code", accountLabel: "pool@example.invalid", logoUrl: null,
    icon: null, strings: { iconTint: null }, signInHint: "Sign in", expiredHint: "Expired",
    usage: { status: "ok", accountEmail: "pool@example.invalid", planLabel: "Unrelated plan", windows: [{ label: "Weekly limit", usedPercent: 97, resetsAt: null, cost: null }] },
  };
  const fetchUsage = vi.fn(async () => Response.json({
    ok: true,
    result: { machines: [
      { id: "host-owned", displayName: "Owned machine", status: "connected", error: null, providers: [{ ...account, id: "unrelated-native", accountLabel: "native@example.invalid" }] },
      { id: "source:pool", displayName: "Account Pooler", status: "connected", error: null, providers: [account] },
    ] },
  }));
  vi.stubGlobal("fetch", fetchUsage);
  const { app, item } = await disclosure();
  const mounted = await mountPluginContentScripts(app, { pluginId: "bb--provider-usage" });
  try {
    const slot = renderSlot(item, { dismiss: vi.fn() }, {
      pluginId: "bb--provider-usage",
      context: { threadId: "thread-owned" },
      rpc: { getThreadUsage: () => unavailable() },
    });
    await slot.findByRole("heading", { name: "Personal OMP" });
    expect(slot.queryByText("97%")).toBeNull();
    expect(slot.queryByText("Unrelated plan")).toBeNull();
    expect(slot.queryByText("pool@example.invalid")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "All accounts" }));
    await slot.findByText("97%");
    expect(slot.queryByRole("region", { name: "Selected model connection usage" })).toBeNull();
    expect(slot.getByText("pool@example.invalid")).toBeDefined();
    fireEvent.click(slot.getByRole("button", { name: "Selected account" }));
    await slot.findByRole("heading", { name: "Personal OMP" });
    expect(slot.queryByText("97%")).toBeNull();
    expect(slot.queryByText("Unrelated plan")).toBeNull();
  } finally {
    await mounted.lifecycle.dispose();
  }
});

it("immediately hides an invalidated observation and rejects a late pre-revocation refresh", async () => {
  const { item } = await disclosure();
  let release: (value: ThreadUsage) => void = () => { throw new Error("Refresh not started"); };
  const delayed = new Promise<ThreadUsage>((resolve) => { release = resolve; });
  let hold = false;
  let revoked = false;
  const read = vi.fn(() => {
    if (revoked) return {
      ...observation(), state: "revoked", usage: null, source: null, observedAt: null,
      connection: { ...observation().connection!, definition: "revoked" },
    } satisfies ThreadUsage;
    return hold ? delayed : observation();
  });
  const slot = renderSlot(item, { dismiss: vi.fn() }, {
    context: { threadId: "thread-owned" }, rpc: { getThreadUsage: read },
  });
  await slot.findByText("42%");
  hold = true;
  fireEvent.click(slot.getByRole("button", { name: "Reload selected account usage" }));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(slot.queryByText("42%")).toBeNull();
  revoked = true;
  await slot.behavior.emitRealtime("system:changed", { changes: ["model-connections-changed"] });
  await slot.findByText("Revoked");
  await act(async () => { release(observation("thread-owned", 88)); await delayed; });
  expect(slot.queryByText("88%")).toBeNull();
  expect(slot.queryByText("42%")).toBeNull();
  expect(slot.getByText("Revoked")).toBeDefined();
});

it("withdraws the previous thread's observation on selection change and rejects its late refresh", async () => {
  const { SelectedThreadUsage } = await import("./app");
  let releaseOld: (value: ThreadUsage) => void = () => { throw new Error("Old refresh not started"); };
  let releaseCurrent: (value: ThreadUsage) => void = () => { throw new Error("Current thread not started"); };
  const oldRefresh = new Promise<ThreadUsage>((resolve) => { releaseOld = resolve; });
  const currentResponse = new Promise<ThreadUsage>((resolve) => { releaseCurrent = resolve; });
  let hold = false;
  const read = vi.fn((input: unknown) => {
    const { threadId } = threadUsageInputSchema.parse(input);
    return threadId === "thread-current" ? currentResponse
      : hold ? oldRefresh : observation("thread-old");
  });
  const props = {
    threadId: "thread-old",
    pluginId: "bb--provider-usage",
    snapshot: { data: null, error: null, isRefreshing: false },
    threadMachineId: "host-owned",
    dismiss: vi.fn(),
  };
  const slot = renderSlot({ component: SelectedThreadUsage }, props, {
    rpc: { getThreadUsage: read },
  });
  await slot.findByText("42%");
  hold = true;
  fireEvent.click(slot.getByRole("button", { name: "Reload selected account usage" }));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  slot.lifecycle.rerender(<SelectedThreadUsage {...props} threadId="thread-current" />);
  expect(slot.queryByText("42%")).toBeNull();
  expect(slot.queryByText("owned@example.invalid")).toBeNull();
  await act(async () => { releaseOld(observation("thread-old", 88)); await oldRefresh; });
  expect(slot.queryByText("88%")).toBeNull();
  await act(async () => { releaseCurrent(unavailable("thread-current")); await currentResponse; });
  await slot.findByRole("heading", { name: "Personal OMP" });
  expect(slot.queryByText("88%")).toBeNull();
  expect(slot.queryByRole("heading", { name: "Owned native Claude" })).toBeNull();
});

it("withdraws quota while disconnected and reconciles current revocation on reconnect", async () => {
  const { item } = await disclosure();
  let revoked = false;
  const slot = renderSlot(item, { dismiss: vi.fn() }, {
    context: { threadId: "thread-owned" },
    rpc: { getThreadUsage: () => revoked ? {
      ...observation(), state: "revoked", source: null, usage: null,
      connection: { ...observation().connection!, definition: "revoked" },
    } satisfies ThreadUsage : observation() },
  });
  await slot.findByText("42%");
  await slot.behavior.setRealtimeConnectionState("reconnecting");
  expect(slot.queryByText("42%")).toBeNull();
  revoked = true;
  await slot.behavior.setRealtimeConnectionState("connected");
  await slot.findByText("Revoked");
  expect(slot.queryByText("42%")).toBeNull();
});
