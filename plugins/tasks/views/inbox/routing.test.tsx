// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
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

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];
beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(async () => { cleanup(); for (const host of hosts.splice(0)) await host.harness.dispose(); vi.unstubAllGlobals(); });
function Harness({ item }: { item: InboxEntry }) { return <TasksRefreshProvider><InboxRoutingControl item={item} refresh={() => undefined} /></TasksRefreshProvider>; }
async function fixture(pending?: { entered: () => void; release: Promise<void> }) {
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
    rpc: { ...rpc, ...(pending ? { applyInboxRoute: async (input: unknown) => { pending.entered(); await pending.release; return host.harness.callRpc("applyInboxRoute", input); } } : {}) },
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
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
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
