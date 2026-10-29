// @vitest-environment jsdom
import { createDeferredPromise } from "@bb/test-helpers";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createStore, registerTasksApi } from "../../api/index.js";
import { registerInbox } from "../../inbox/index.js";
import { InboxStore } from "../../inbox/store.js";
import { registerRouting } from "../../routing/index.js";
import { RoutingStore } from "../../routing/store.js";
import { routingRpcContract } from "../../shared/routing.js";
import { tasksRpcContract } from "../../shared/contract.js";
import type { InboxEntry } from "../../shared/inbox-contract.js";
import { TasksRefreshProvider } from "../../shell/refresh.js";
import { InboxRoutingControl } from "./routing.js";

const hosts: FakePluginHost[] = [];
beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(async () => { cleanup(); for (const host of hosts.splice(0)) await host.harness.dispose(); vi.unstubAllGlobals(); });
function Harness({ item }: { item: InboxEntry }) { return <TasksRefreshProvider><InboxRoutingControl item={item} refresh={() => undefined} /></TasksRefreshProvider>; }
async function fixture(pending?: { entered: () => void; release: Promise<void> }, deliverPreview?: (input: unknown, host: FakePluginHost) => Promise<unknown>) {
  const host = createFakePluginHost({ pluginId: "tasks", sdk: {
    hosts: { list: async () => [] }, projects: { list: async () => [] },
    experimental_executionContexts: { list: async () => [] }, experimental_modelConnections: { list: async () => [] },
  } });
  hosts.push(host);
  const store = createStore(host.bb);
  registerTasksApi(host.bb, store);
  const project = store.tasks.createProject({ name: "Routing UI", prefix: "RUI", color: "blue" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Keep existing checkout writer" });
  const inbox = registerInbox(host.bb, store, { background: false });
  const routing = registerRouting(host.bb, store);
  const { item } = await inbox.createInbox({ title: `Continue ${task.key}`, body: "Untrusted incoming", context: "work" });
  await routing.previewInboxRoute({ id: item.id, operationId: "seed-advice", grantId: null, sourceRevision: item.revision, expectedRevision: 0, projectId: project.id, taskRef: "", newTask: false, semantic: false });
  const rpc = Object.fromEntries([...Object.keys(tasksRpcContract), ...Object.keys(routingRpcContract)].map(method => [method, (input: unknown) => host.harness.callRpc(method, input)]));
  const slot = renderSlot({ component: Harness }, { item }, {
    sdk: { experimental_executionContexts: { list: async () => [] }, experimental_modelConnections: { list: async () => [] } },
    rpc: {
      ...rpc,
      ...(pending ? { applyInboxRoute: async (input: unknown) => { pending.entered(); await pending.release; return host.harness.callRpc("applyInboxRoute", input); } } : {}),
      ...(deliverPreview ? { previewInboxRoute: (input: unknown) => deliverPreview(input, host) } : {}),
    },
  });
  return { host, store, task, item, slot, persistence: new RoutingStore(store) };
}

it("retains local reference edits across stale advice, Escape and reopen without granting away or replacing the owner", async () => {
  const f = await fixture();
  const trigger = f.slot.getByRole("button", { name: "Routing & local away" });
  trigger.focus();
  fireEvent.click(trigger);
  await f.slot.findByRole("dialog", { name: "Advisory routing and local-action away" });
  const reference = await f.slot.findByRole("textbox", { name: "Exact task or thread reference" });
  fireEvent.change(reference, { target: { value: "Locally edited scope, not sent" } });
  const link = await f.slot.findByRole("button", { name: "Link existing owner" });
  await waitFor(() => expect(link.hasAttribute("disabled")).toBe(false));
  f.store.tasks.updateTask(f.task.id, { description: "Authoritative task scope changed remotely" });
  await act(async () => { await f.slot.behavior.emitRealtime("tasks:changed", { taskId: f.task.id, projectId: f.task.projectId }); });
  await waitFor(() => expect(link.hasAttribute("disabled")).toBe(true));
  expect((reference as HTMLInputElement).value).toBe("Locally edited scope, not sent");
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(f.slot.queryByRole("dialog", { name: "Advisory routing and local-action away" })).toBeNull());
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  await f.slot.findByRole("dialog", { name: "Advisory routing and local-action away" });
  expect((f.slot.getByRole("textbox", { name: "Exact task or thread reference" }) as HTMLInputElement).value).toBe("Locally edited scope, not sent");
  expect(f.persistence.grants(f.item.id)).toEqual([]);
  expect(new InboxStore(f.store.database).get(f.item.id).taskId).toBeNull();
  expect(f.host.harness.sdk.callsTo("threads.spawn")).toEqual([]);
  expect(f.host.harness.sdk.callsTo("threads.send")).toEqual([]);
});

it("retains one pending local action across close/reopen and does not duplicate it on repeated activation", async () => {
  const entered = createDeferredPromise<void>();
  const released = createDeferredPromise<void>();
  const f = await fixture({ entered: () => entered.resolve(), release: released.promise });
  const trigger = f.slot.getByRole("button", { name: "Routing & local away" });
  fireEvent.click(trigger);
  const link = await f.slot.findByRole("button", { name: "Link existing owner" });
  await waitFor(() => expect(link.hasAttribute("disabled")).toBe(false));
  fireEvent.click(link);
  await entered.promise;
  await waitFor(() => expect(link.hasAttribute("disabled")).toBe(true));
  fireEvent.click(link);
  fireEvent.click(f.slot.getByRole("button", { name: "Close · no execution" }));
  await waitFor(() => expect(f.slot.queryByRole("dialog", { name: "Advisory routing and local-action away" })).toBeNull());
  fireEvent.click(trigger);
  await f.slot.findByRole("dialog", { name: "Advisory routing and local-action away" });
  expect(f.slot.getByRole("button", { name: "Link existing owner" }).hasAttribute("disabled")).toBe(true);
  await act(async () => { released.resolve(); });
  await waitFor(() => expect(new InboxStore(f.store.database).get(f.item.id)).toMatchObject({ taskId: f.task.id, state: "resolved" }));
  expect(f.slot.rpcCalls.filter(call => call.method === "applyInboxRoute")).toHaveLength(1);
  expect(f.persistence.journal(f.item.id).filter(entry => entry.kind === "link").map(entry => entry.state)).toEqual(["applied"]);
  expect(f.store.tasks.listTaskThreads(f.task.id)).toEqual([]);
  expect(f.host.harness.sdk.callsTo("threads.spawn")).toEqual([]);
});

it("review regressions: retries unchanged choices after a definitive parked preview and drawer reopen", async () => {
  const f = await fixture();
  let available = false;
  f.host.harness.sdk.stub("threads.get", async () => {
    if (!available) throw new Error("Native thread temporarily unavailable");
    return makeThreadResponse({ id: "thr_recoverable", projectId: "proj_code", status: "idle" });
  });
  const trigger = f.slot.getByRole("button", { name: "Routing & local away" });
  fireEvent.click(trigger);
  const reference = await f.slot.findByRole("textbox", { name: "Exact task or thread reference" });
  fireEvent.change(reference, { target: { value: "thr_recoverable" } });
  const preview = await f.slot.findByRole("button", { name: "Preview route" });
  await waitFor(() => expect(preview.hasAttribute("disabled")).toBe(false));
  fireEvent.click(preview);
  await waitFor(() => expect(f.persistence.journal(f.item.id).filter(entry => entry.operationId !== "seed-advice").map(entry => entry.state)).toEqual(["parked"]));
  expect(f.persistence.proposal(f.item.id)?.revision).toBe(1);
  fireEvent.click(f.slot.getByRole("button", { name: "Close · no execution" }));
  await waitFor(() => expect(f.slot.queryByRole("dialog", { name: "Advisory routing and local-action away" })).toBeNull());
  available = true;
  fireEvent.click(trigger);
  await f.slot.findByRole("dialog", { name: "Advisory routing and local-action away" });
  expect((f.slot.getByRole("textbox", { name: "Exact task or thread reference" }) as HTMLInputElement).value).toBe("thr_recoverable");
  const retry = f.slot.getByRole("button", { name: "Preview route" });
  await waitFor(() => expect(retry.hasAttribute("disabled")).toBe(false));
  fireEvent.click(retry);
  await f.slot.findByRole("button", { name: "Open retained executor" });
  expect(f.persistence.proposal(f.item.id)).toMatchObject({ revision: 2, decision: { kind: "existing-thread", threadId: "thr_recoverable" }, threadId: "thr_recoverable" });
  expect(f.persistence.journal(f.item.id).filter(entry => entry.operationId !== "seed-advice").map(entry => entry.state).sort()).toEqual(["applied", "parked"]);
  expect(new InboxStore(f.store.database).get(f.item.id)).toMatchObject({ taskId: null, threadId: null, state: "open" });
  expect(f.persistence.grants(f.item.id)).toEqual([]);
  expect(f.host.harness.sdk.callsTo("threads.spawn")).toEqual([]);
  expect(f.host.harness.sdk.callsTo("threads.send")).toEqual([]);
  expect(f.host.harness.sdk.callsTo("system.experimental_classifyTaskRoute")).toEqual([]);
});

it("review regressions: retains uncertain preview identity across reopen instead of allocating another attempt", async () => {
  const operations: string[] = [];
  const entered = createDeferredPromise<void>();
  const release = createDeferredPromise<void>();
  const serverResult = createDeferredPromise<unknown>();
  const replaySettled = createDeferredPromise<void>();
  const f = await fixture(undefined, async (raw, host) => {
    const input = routingRpcContract.previewInboxRoute.input.parse(raw);
    operations.push(input.operationId);
    if (operations.length === 1) {
      void host.harness.callRpc("previewInboxRoute", input).then(result => serverResult.resolve(result), error => serverResult.reject(error));
      await entered.promise;
      throw new Error("Preview delivery was not acknowledged");
    }
    try {
      return await host.harness.callRpc("previewInboxRoute", input);
    } finally {
      replaySettled.resolve();
    }
  });
  f.host.harness.sdk.stub("threads.get", async () => {
    entered.resolve();
    await release.promise;
    return makeThreadResponse({ id: "thr_uncertainpreview", projectId: "proj_code", status: "idle" });
  });
  try {
    const trigger = f.slot.getByRole("button", { name: "Routing & local away" });
    fireEvent.click(trigger);
    const reference = await f.slot.findByRole("textbox", { name: "Exact task or thread reference" });
    fireEvent.change(reference, { target: { value: "thr_uncertainpreview" } });
    const preview = await f.slot.findByRole("button", { name: "Preview route" });
    await waitFor(() => expect(preview.hasAttribute("disabled")).toBe(false));
    fireEvent.click(preview);
    await f.slot.findByRole("alert");
    expect(f.persistence.journal(f.item.id).filter(entry => entry.operationId !== "seed-advice")).toMatchObject([{ operationId: operations[0], state: "reserved" }]);
    expect(f.persistence.proposal(f.item.id)?.revision).toBe(1);
    fireEvent.click(f.slot.getByRole("button", { name: "Close · no execution" }));
    await waitFor(() => expect(f.slot.queryByRole("dialog", { name: "Advisory routing and local-action away" })).toBeNull());
    fireEvent.click(trigger);
    await f.slot.findByRole("dialog", { name: "Advisory routing and local-action away" });
    const retry = f.slot.getByRole("button", { name: "Preview route" });
    await waitFor(() => expect(retry.hasAttribute("disabled")).toBe(false));
    fireEvent.click(retry);
    await replaySettled.promise;
    await waitFor(() => expect(f.slot.getByRole("button", { name: "Preview route" }).hasAttribute("disabled")).toBe(false));
    expect(operations).toHaveLength(2);
    expect(operations[1]).toBe(operations[0]);
    expect(f.persistence.journal(f.item.id).filter(entry => entry.operationId !== "seed-advice")).toMatchObject([{ operationId: operations[0], state: "reserved" }]);
  } finally {
    release.resolve();
    if (operations.length) await act(async () => { await serverResult.promise; });
  }
  await act(async () => { await f.slot.behavior.emitRealtime("inbox:changed", { id: f.item.id }); });
  fireEvent.click(await f.slot.findByRole("button", { name: "Load server advice · keep local draft" }));
  await f.slot.findByRole("button", { name: "Open retained executor" });
  expect(f.persistence.journal(f.item.id).filter(entry => entry.operationId !== "seed-advice")).toMatchObject([{ operationId: operations[0], state: "applied" }]);
  expect(f.persistence.proposal(f.item.id)).toMatchObject({ revision: 2, decision: { kind: "existing-thread", threadId: "thr_uncertainpreview" } });
  expect(new InboxStore(f.store.database).get(f.item.id)).toMatchObject({ taskId: null, threadId: null, state: "open" });
  expect(f.persistence.grants(f.item.id)).toEqual([]);
  expect(f.host.harness.sdk.callsTo("threads.spawn")).toEqual([]);
  expect(f.host.harness.sdk.callsTo("threads.send")).toEqual([]);
  expect(f.host.harness.sdk.callsTo("system.experimental_classifyTaskRoute")).toEqual([]);
});
