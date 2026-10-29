// @vitest-environment jsdom
import type { ComponentType } from "react";
import { z } from "zod";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { ChangedMessage } from "@bb/domain";
import type { ThreadUsage } from "../../../../plugins/provider-usage/thread-usage-schema.js";

vi.mock("@/hooks/useRouteState", () => ({
  useRouteState: () => ({ threadId: "thread-owned", projectId: "project-owned" }),
}));
vi.mock("@/components/plugin/plugin-context", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/components/plugin/plugin-context")>(),
  usePluginId: () => "bb--provider-usage",
}));
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => ({
  ...await importOriginal<typeof import("@get-bb/plugin-sdk/app")>(),
  useRealtime: (channel: string, handler: (payload: unknown) => void) => useCoreRealtime(channel, handler),
}));

import { wsManager } from "./ws";
import { useRealtime as useCoreRealtime } from "./plugin-sdk-hooks";
const usageModules = import.meta.glob(["../../../../plugins/provider-usage/app.tsx"]);
const loadUsage = usageModules["../../../../plugins/provider-usage/app.tsx"];
if (!loadUsage) throw new Error("Actual Provider Usage app module could not be located");
const { SelectedThreadUsage } = z.object({
  SelectedThreadUsage: z.custom<ComponentType<Record<string, unknown>>>(
    (value) => typeof value === "function",
  ),
}).parse(await loadUsage());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function observation(percent = 42): ThreadUsage {
  return {
    threadId: "thread-owned", bindingCreatedAt: 1,
    connection: { id: "connection-owned", name: "Owned Claude", providerId: "claude-code", providerName: "Claude Code", kind: "native", definition: "active" },
    host: { id: "host-owned", name: "Owned host" },
    state: "available", reason: "An owned host-default observation, not physical credential proof.",
    source: { pluginId: "provider-claude-code", name: "Claude Code", resourceId: "owned-resource" },
    observedAt: 3_000_000,
    usage: { status: "ok", accountEmail: "owned@example.invalid", planLabel: null, windows: [{ label: "Five-hour limit", usedPercent: percent, resetsAt: null, cost: null }] },
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

it.each([
  { type: "changed", entity: "thread", id: "thread-owned", changes: ["environment-changed"] },
  { type: "changed", entity: "environment", id: "environment-owned", changes: ["status-changed"] },
  { type: "changed", entity: "host", id: "host-owned", changes: ["host-disconnected"] },
  { type: "changed", entity: "system", changes: ["execution-contexts-changed"] },
] satisfies ChangedMessage[])("withdraws admitted quota and rejects late pre-change results after a delivered $entity change with Core still connected", async (message) => {
  vi.spyOn(Date, "now").mockReturnValue(3_000_000);
  const oldStarted = deferred<void>();
  const currentStarted = deferred<void>();
  const old = deferred<ThreadUsage>();
  const current = deferred<ThreadUsage>();
  let phase: "initial" | "old-refresh" | "current" = "initial";
  const slot = renderSlot({ component: SelectedThreadUsage }, {
    threadId: "thread-owned", threadMachineId: "host-owned", pluginId: "bb--provider-usage",
    snapshot: { data: null, error: null, isRefreshing: false }, dismiss: vi.fn(),
  }, {
    pluginId: "bb--provider-usage", realtimeConnectionState: "connected",
    rpc: {
      getThreadUsage: () => {
        if (phase === "initial") return observation();
        if (phase === "old-refresh") {
          oldStarted.resolve(undefined);
          return old.promise;
        }
        currentStarted.resolve(undefined);
        return current.promise;
      },
    },
  });
  await slot.findByText("42%");
  phase = "old-refresh";
  fireEvent.click(slot.getByRole("button", { name: "Reload selected account usage" }));
  await oldStarted.promise;
  phase = "current";
  act(() => { wsManager.handleIncomingMessage(JSON.stringify(message)); });
  expect(slot.queryByText("42%")).toBeNull();
  await currentStarted.promise;
  await act(async () => {
    old.resolve(observation(88));
    await old.promise;
  });
  expect(slot.queryByText("88%")).toBeNull();
  await act(async () => {
    current.resolve({ ...observation(), state: "unknown", usage: null, source: null, observedAt: null, reason: "Current Core execution eligibility changed." });
    await current.promise;
  });
  await slot.findByText("Unknown");
  expect(slot.queryByText("42%")).toBeNull();
  expect(slot.queryByText("88%")).toBeNull();
});

it.each([
  { type: "changed", entity: "thread", id: "thread-owned", changes: ["environment-changed"] },
  { type: "changed", entity: "host", id: "host-owned", changes: ["host-disconnected"] },
] satisfies ChangedMessage[])("withdraws a displayed observation on a delivered $entity eligibility change even when no refresh is pending", async (message) => {
  vi.spyOn(Date, "now").mockReturnValue(3_000_000);
  const next = deferred<ThreadUsage>();
  let disconnected = false;
  const slot = renderSlot({ component: SelectedThreadUsage }, {
    threadId: "thread-owned", threadMachineId: "host-owned", pluginId: "bb--provider-usage",
    snapshot: { data: null, error: null, isRefreshing: false }, dismiss: vi.fn(),
  }, {
    realtimeConnectionState: "connected",
    rpc: { getThreadUsage: () => disconnected ? next.promise : observation() },
  });
  await slot.findByText("42%");
  disconnected = true;
  act(() => { wsManager.handleIncomingMessage(JSON.stringify(message)); });
  expect(slot.queryByText("42%")).toBeNull();
  expect(slot.queryByText("owned@example.invalid")).toBeNull();
  await act(async () => {
    next.resolve({ ...observation(), state: "stale", reason: "Current execution eligibility changed.", usage: null, source: null, observedAt: null });
    await next.promise;
  });
  await slot.findByText("Stale");
  expect(slot.queryByText("42%")).toBeNull();
});
