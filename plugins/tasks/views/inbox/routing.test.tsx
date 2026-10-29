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
import { inboxRpcContract, type InboxEntry } from "../../shared/inbox-contract.js";
import { TasksRefreshProvider } from "../../shell/refresh.js";
import { InboxRoutingControl } from "./routing.js";

const hosts: FakePluginHost[] = [];
beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(async () => { cleanup(); for (const host of hosts.splice(0)) await host.harness.dispose(); vi.unstubAllGlobals(); });
function Harness({ item }: { item: InboxEntry }) { return <TasksRefreshProvider><InboxRoutingControl item={item} refresh={() => undefined} /></TasksRefreshProvider>; }
async function fixture(pending?: { entered: () => void; release: Promise<void> }, deliverPreview?: (input: unknown, host: FakePluginHost) => Promise<unknown>, source?: { title: string; body: string }) {
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
  const { item } = source
    ? await inbox.upsertInboxSource({ sourceKind: "review_followup", sourceKey: "incoming", revision: "source-1", active: true, context: "work", ...source })
    : await inbox.createInbox({ title: `Continue ${task.key}`, body: "Untrusted incoming", context: "work" });
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

type PreviewRequest = ReturnType<typeof routingRpcContract.previewInboxRoute.input.parse>;

function semanticAdvice(taskId: string) {
  return { decision: { kind: "existing" as const, taskId, reason: "The supplied native task owns this scope." }, service: null, callbackInvocations: 1 as const, limitation: "Fixture completion callback only; no physical model request." };
}

it.each(["lost", "acknowledged"] as const)("follow-up regressions: a completed %s preview uses the right receipt identity after revision refresh and reopen", async delivery => {
  const requests: PreviewRequest[] = [];
  const retried = createDeferredPromise<void>();
  const f = await fixture(undefined, async (raw, host) => {
    const input = routingRpcContract.previewInboxRoute.input.parse(raw);
    requests.push(input);
    try {
      const result = await host.harness.callRpc("previewInboxRoute", input);
      if (requests.length === 1 && delivery === "lost") throw new Error("Completed preview acknowledgement was lost");
      return result;
    } finally {
      if (requests.length > 1) retried.resolve();
    }
  }, { title: "Investigate a new integration", body: "Untrusted scope without exact task references" });
  let callbacks = 0;
  f.host.harness.sdk.stub("system.experimental_classifyTaskRoute", async () => { callbacks++; return semanticAdvice(f.task.id); });
  const trigger = f.slot.getByRole("button", { name: "Routing & local away" });
  fireEvent.click(trigger);
  fireEvent.click(await f.slot.findByRole("checkbox", { name: /Request semantic advice/ }));
  const preview = await f.slot.findByRole("button", { name: "Preview route" });
  await waitFor(() => expect(preview.hasAttribute("disabled")).toBe(false));
  fireEvent.click(preview);
  await waitFor(() => expect(f.persistence.proposal(f.item.id)?.revision).toBe(2));
  if (delivery === "lost") await f.slot.findByRole("alert");
  await waitFor(() => expect(f.slot.getByRole("button", { name: "Preview route" }).hasAttribute("disabled")).toBe(false));
  expect(callbacks).toBe(1);
  expect(f.persistence.journal(f.item.id).filter(entry => entry.operationId !== "seed-advice")).toMatchObject([{ operationId: requests[0]!.operationId, state: "applied" }]);
  fireEvent.click(f.slot.getByRole("button", { name: "Close · no execution" }));
  await waitFor(() => expect(f.slot.queryByRole("dialog", { name: "Advisory routing and local-action away" })).toBeNull());
  fireEvent.click(trigger);
  await f.slot.findByRole("dialog", { name: "Advisory routing and local-action away" });
  if (delivery === "lost") await f.slot.findByRole("button", { name: "Load server advice · keep local draft" });
  const retry = f.slot.getByRole("button", { name: "Preview route" });
  await waitFor(() => expect(retry.hasAttribute("disabled")).toBe(false));
  fireEvent.click(retry);
  await retried.promise;
  await waitFor(() => expect(f.slot.getByRole("button", { name: "Preview route" }).hasAttribute("disabled")).toBe(false));
  if (delivery === "lost") {
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(callbacks).toBe(1);
    expect(f.persistence.proposal(f.item.id)?.revision).toBe(2);
    expect(f.persistence.journal(f.item.id).filter(entry => entry.operationId !== "seed-advice")).toMatchObject([{ operationId: requests[0]!.operationId, state: "applied" }]);
  } else {
    expect(requests[1]!.operationId).not.toBe(requests[0]!.operationId);
    expect(requests[1]!.expectedRevision).toBe(2);
    expect(callbacks).toBe(2);
    expect(f.persistence.proposal(f.item.id)?.revision).toBe(3);
    expect(f.persistence.journal(f.item.id).filter(entry => entry.operationId !== "seed-advice").map(entry => entry.operationId).sort()).toEqual(requests.map(input => input.operationId).sort());
  }
  expect(new InboxStore(f.store.database).get(f.item.id)).toMatchObject({ taskId: null, threadId: null, state: "open" });
  expect(f.store.tasks.listTasks().map(task => task.id)).toEqual([f.task.id]);
  expect(f.persistence.grants(f.item.id)).toEqual([]);
  expect(f.host.harness.sdk.callsTo("threads.spawn")).toEqual([]);
  expect(f.host.harness.sdk.callsTo("threads.send")).toEqual([]);
});

it.each([
  ["lost", "source"],
  ["lost", "choice"],
  ["acknowledged", "source"],
  ["acknowledged", "choice"],
] as const)("follow-up regressions: %s acknowledgement preserves the right request policy after a %s change", async (delivery, change) => {
  const requests: PreviewRequest[] = [];
  const entered = createDeferredPromise<void>();
  const release = createDeferredPromise<void>();
  const firstReceipt = createDeferredPromise<unknown>();
  const replaySettled = createDeferredPromise<void>();
  const f = await fixture(undefined, async (raw, host) => {
    const input = routingRpcContract.previewInboxRoute.input.parse(raw);
    requests.push(input);
    if (requests.length === 1) {
      const pending = host.harness.callRpc("previewInboxRoute", input);
      void pending.then(result => firstReceipt.resolve(result), error => firstReceipt.reject(error));
      if (delivery === "lost") {
        await entered.promise;
        throw new Error("Reserved preview acknowledgement was lost");
      }
      return pending;
    }
    try {
      return await host.harness.callRpc("previewInboxRoute", input);
    } finally {
      replaySettled.resolve();
    }
  }, { title: "Investigate an independent integration", body: "Untrusted scope without exact task references" });
  let callbacks = 0;
  f.host.harness.sdk.stub("system.experimental_classifyTaskRoute", async () => {
    callbacks++;
    if (delivery === "lost" && callbacks === 1) {
      entered.resolve();
      await release.promise;
    }
    return semanticAdvice(f.task.id);
  });
  try {
    fireEvent.click(f.slot.getByRole("button", { name: "Routing & local away" }));
    const semantic = await f.slot.findByRole("checkbox", { name: /Request semantic advice/ });
    fireEvent.click(semantic);
    const preview = await f.slot.findByRole("button", { name: "Preview route" });
    await waitFor(() => expect(preview.hasAttribute("disabled")).toBe(false));
    fireEvent.click(preview);
    if (delivery === "lost") await f.slot.findByRole("alert");
    else await firstReceipt.promise;
    await waitFor(() => expect(f.slot.getByRole("button", { name: "Preview route" }).hasAttribute("disabled")).toBe(false));
    if (delivery === "acknowledged") {
      const link = await f.slot.findByRole("button", { name: "Link existing owner" });
      await waitFor(() => expect(link.hasAttribute("disabled")).toBe(false));
    }
    expect(callbacks).toBe(1);
    expect(f.persistence.journal(f.item.id).filter(entry => entry.operationId !== "seed-advice")).toMatchObject([{ operationId: requests[0]!.operationId, state: delivery === "lost" ? "reserved" : "applied" }]);
    if (change === "source") {
      const revisedTitle = "Revised incoming scope after preview";
      const revised = inboxRpcContract.upsertInboxSource.output.parse(await f.host.harness.callRpc("upsertInboxSource", { sourceKind: f.item.sourceKind, sourceKey: f.item.sourceKey, revision: "source-2", title: revisedTitle, body: "Updated untrusted scope without exact references", active: true, context: "work" }));
      expect(revised.item).toMatchObject({ id: f.item.id, revision: "source-2" });
      await act(async () => { await f.slot.behavior.emitRealtime("inbox:changed", { id: f.item.id }); });
      await f.slot.findByText(revisedTitle);
    } else {
      fireEvent.click(semantic);
      expect((semantic as HTMLInputElement).checked).toBe(false);
    }
    const retry = f.slot.getByRole("button", { name: "Preview route" });
    await waitFor(() => expect(retry.hasAttribute("disabled")).toBe(false));
    fireEvent.click(retry);
    await replaySettled.promise;
    await waitFor(() => expect(f.slot.getByRole("button", { name: "Preview route" }).hasAttribute("disabled")).toBe(false));
    if (delivery === "lost") {
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(requests[0]);
      expect(callbacks).toBe(1);
      expect(f.persistence.journal(f.item.id).filter(entry => entry.operationId !== "seed-advice")).toMatchObject([{ operationId: requests[0]!.operationId, state: "reserved" }]);
      expect(f.persistence.proposal(f.item.id)?.revision).toBe(1);
    } else {
      expect(requests[1]!.operationId).not.toBe(requests[0]!.operationId);
      expect(requests[1]!.sourceRevision).toBe(change === "source" ? "source-2" : requests[0]!.sourceRevision);
      expect(requests[1]!.semantic).toBe(change === "source");
      expect(callbacks).toBe(change === "source" ? 2 : 1);
      expect(f.persistence.journal(f.item.id).find(entry => entry.operationId === requests[1]!.operationId)?.state).toBe(change === "source" ? "applied" : "parked");
      expect(f.persistence.proposal(f.item.id)?.revision).toBe(3);
    }
  } finally {
    release.resolve();
    if (requests.length) await act(async () => { await firstReceipt.promise; });
  }
  const terminal = routingRpcContract.previewInboxRoute.output.parse(await firstReceipt.promise);
  expect(terminal.state).toBe(delivery === "lost" && change === "source" ? "parked" : "applied");
  expect(f.persistence.journal(f.item.id).find(entry => entry.operationId === requests[0]!.operationId)?.state).toBe(terminal.state);
  expect(new InboxStore(f.store.database).get(f.item.id)).toMatchObject({ taskId: null, threadId: null, state: "open" });
  expect(f.store.tasks.listTasks().map(task => task.id)).toEqual([f.task.id]);
  expect(f.persistence.grants(f.item.id)).toEqual([]);
  expect(f.host.harness.sdk.callsTo("threads.spawn")).toEqual([]);
  expect(f.host.harness.sdk.callsTo("threads.send")).toEqual([]);
});
