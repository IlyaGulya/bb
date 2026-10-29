// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createFakePluginHost, makeThreadResponse, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createStore, registerTasksApi } from "../tasks/api/index.js";
import { tasksRpcContract } from "../tasks/shared/contract.js";
import memoryPlugin, { memoryRpcContract } from "./server.js";
import type { MemorySelection } from "./lineage.js";

const app = await loadPluginApp(() => import("./app"));
const hosts: FakePluginHost[] = [];
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
  Object.defineProperty(window, "matchMedia", { configurable: true, value: (media: string) => ({
    matches: false, media, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
  }) });
});

afterEach(async () => {
  cleanup();
  await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
  vi.useRealTimers();
  if (originalMatchMedia) Object.defineProperty(window, "matchMedia", originalMatchMedia);
  else Reflect.deleteProperty(window, "matchMedia");
});

async function fixture() {
  const tasksHost = createFakePluginHost({ pluginId: "tasks" });
  hosts.push(tasksHost);
  const tasks = createStore(tasksHost.bb);
  registerTasksApi(tasksHost.bb, tasks);
  const projectId = "proj_personal";
  const threadId = "thr_memory_workspace";
  const project = tasks.tasks.createProject({ name: "Owned Memory workspace", prefix: "MEMORY", color: "blue", linkedBbProjectId: projectId });
  const task = tasks.tasks.createTask({ projectId: project.id, title: "Inspect storage evidence", description: "R1: retain originals in SQLite." });
  const selection: MemorySelection = { projectId, task: { taskId: task.id, context: "research" }, executionContextId: null };
  const host = createFakePluginHost({
    pluginId: "memory", agentSkillIds: ["memory"],
    sdk: {
      projects: {
        get: async ({ projectId: selected }) => {
          if (selected !== projectId) throw new Error("Core project not found");
          return { id: projectId, name: "Personal" };
        },
        list: async () => [{ id: projectId, name: "Personal" }],
      },
      threads: { get: async ({ threadId: selected }) => makeThreadResponse({ id: selected, projectId }) },
      experimental_executionContexts: { getThreadBinding: async () => null, list: async () => [] },
      plugins: { callRpc: async (args) => {
        if (args.pluginId !== "tasks") throw new Error("Unexpected source plugin");
        return args.outputSchema.parse(await tasksHost.harness.behavior.callRpc(args.method, args.input));
      } },
    },
  });
  hosts.push(host);
  await memoryPlugin(host.bb);
  async function call<T>(method: string, input: unknown, output: z.ZodType<T>): Promise<T> {
    return output.parse(await host.harness.behavior.callRpc(method, input));
  }
  await call("setTaskBindings", { projectId, threadId, expectedVersion: 0, tasks: [selection.task] }, memoryRpcContract.setTaskBindings.output);
  const source = () => ({ kind: "task" as const, commentId: null, revision: tasks.tasks.getTask(task.id)!.updatedAt, observedAt: Date.now(), quote: "" });
  const read = async (name: string) => (await call("getMemory", { ...selection, name }, memoryRpcContract.getMemory.output)).memory;
  const history = async (name: string) => (await call("memoryHistory", { ...selection, name }, memoryRpcContract.memoryHistory.output)).history;
  const create = async (name: string, summary: string, replaces: { id: string; version: number } | null = null) =>
    (await call("createTaskMemory", { ...selection, draft: {
      name, summary, details: "Owned bounded storage evidence", classification: "decision", source: source(), reason: "Inspected native task evidence", replaces,
    } }, memoryRpcContract.createTaskMemory.output)).memory;
  const propose = (memory: NonNullable<Awaited<ReturnType<typeof read>>>, summary: string) => call("proposeReflection", { ...selection, changes: [{
    id: memory.id, expectedVersion: memory.version, summary, details: memory.details,
    classification: "decision", state: "current", source: source(), reason: "Explicitly reviewed a changed conclusion",
  }] }, memoryRpcContract.proposeReflection.output);
  const decide = (id: string, decision: "apply" | "reject") => call("decideReflection", { ...selection, id, decision }, memoryRpcContract.decideReflection.output);
  const rpc = Object.fromEntries(Object.keys(memoryRpcContract).map((method) => [method, (input: unknown) => host.harness.behavior.callRpc(method, input)]));
  const mount = () => renderSlot(app.threadPanelActions[0]!, { threadId, params: null }, { rpc });
  return { host, tasksHost, tasks, task, project, selection, source, call, read, history, create, propose, decide, mount };
}

async function selectSource(slot: ReturnType<Awaited<ReturnType<typeof fixture>>["mount"]>, label: string) {
  const option = await slot.findByRole("option", { name: label });
  if (!(option instanceof HTMLOptionElement)) throw new Error("Expected an evidence option");
  fireEvent.change(slot.getByLabelText("Task memory source"), { target: { value: option.value } });
}

async function finishRefresh(slot: ReturnType<Awaited<ReturnType<typeof fixture>>["mount"]>) {
  await waitFor(() => {
    expect(slot.container.querySelector('[aria-busy="true"]')).toBeNull();
    const refresh = slot.queryByRole("button", { name: "Refresh evidence" });
    if (refresh) expect(refresh.matches(":disabled")).toBe(false);
  });
}

describe("rendered source selection provenance", () => {
  it.each([false, true])("requires deliberate source reselection after refresh when the revision changes = %s", async (changed) => {
    const f = await fixture();
    const slot = f.mount();
    fireEvent.click(await slot.findByRole("button", { name: "Remember task fact" }));
    fireEvent.change(slot.getByLabelText("Task memory name"), { target: { value: "inspected-conclusion" } });
    fireEvent.change(slot.getByLabelText("Task memory summary"), { target: { value: "Conclusion from the inspected original" } });
    fireEvent.change(slot.getByLabelText("Task memory details"), { target: { value: "Keep the original and its inspected revision." } });
    fireEvent.change(slot.getByLabelText("Task memory reason"), { target: { value: "Inspected source before drafting" } });
    const initial = await f.call("listMemorySources", f.selection, memoryRpcContract.listMemorySources.output);
    const selected = initial.sources[0]!;
    await selectSource(slot, selected.label);
    vi.setSystemTime(new Date("2026-10-29T12:00:01Z"));
    if (changed) f.tasks.tasks.updateTask(f.task.id, { description: "R2: the storage conclusion has changed." });
    fireEvent.click(slot.getByRole("button", { name: "Refresh evidence" }));
    const current = await f.call("listMemorySources", f.selection, memoryRpcContract.listMemorySources.output);
    await slot.findByRole("option", { name: current.sources[0]!.label });
    await finishRefresh(slot);
    await act(async () => { fireEvent.click(slot.getByRole("button", { name: "Save task fact" })); });
    if (changed) {
      expect(await f.read("inspected-conclusion")).toBeNull();
      const retainedDraft = slot.getByLabelText("Task memory summary");
      expect(retainedDraft instanceof HTMLInputElement ? retainedDraft.value : null).toBe("Conclusion from the inspected original");
      await selectSource(slot, current.sources[0]!.label);
      await act(async () => { fireEvent.click(slot.getByRole("button", { name: "Save task fact" })); });
    }
    await waitFor(() => expect(slot.queryByLabelText("Task memory summary")).toBeNull());
    expect(await f.read("inspected-conclusion")).toMatchObject({
      version: 1, summary: "Conclusion from the inspected original",
      lineage: { source: { kind: selected.kind, commentId: selected.commentId, revision: changed ? current.sources[0]!.revision : selected.revision, quote: "" } },
    });
  });
});

describe("rendered retained-history lifecycle", () => {
  it.each(["delete", "unlink"] as const)("keeps history and explicit rejection accessible after source %s", async (removal) => {
    const f = await fixture();
    const original = await f.create("retained-original", "Original retained conclusion");
    const proposal = await f.propose(original, "A pending conclusion requiring explicit review");
    const slot = f.mount();
    fireEvent.click(await slot.findByRole("button", { name: "History of retained-original" }));
    const before = await slot.findByRole("region", { name: "Memory version history" });
    expect(within(before).getByText(original.summary)).toBeTruthy();
    const initialReview = slot.getByText(proposal.diffs[0]!.after.summary).closest("details");
    if (!(initialReview instanceof HTMLDetailsElement)) throw new Error("Expected a reviewable pending proposal");
    fireEvent.click(within(initialReview).getByText(/^Review pending reflection/));
    await waitFor(() => expect(within(initialReview).getByRole("button", { name: "Reject proposal" }).matches(":disabled")).toBe(false));
    if (removal === "delete") {
      expect(tasksRpcContract.deleteTask.output.parse(await f.tasksHost.harness.behavior.callRpc("deleteTask", { taskId: f.task.id })).deleted).toBe(true);
    } else {
      expect(tasksRpcContract.updateProject.output.parse(await f.tasksHost.harness.behavior.callRpc("updateProject", { projectId: f.project.id, linkedBbProjectId: null })).project.linkedBbProjectId).toBeNull();
    }
    await expect(f.call("listMemorySources", f.selection, memoryRpcContract.listMemorySources.output)).rejects.toThrow();
    await expect(f.decide(proposal.id, "apply")).rejects.toThrow();
    expect((await f.history(original.id)).map((entry) => entry.snapshot)).toEqual([original]);
    fireEvent.click(slot.getByRole("button", { name: "Refresh evidence" }));
    await finishRefresh(slot);
    fireEvent.click(await slot.findByRole("button", { name: "History of retained-original" }));
    const retained = await slot.findByRole("region", { name: "Memory version history" });
    expect(within(retained).getByText(original.summary)).toBeTruthy();
    const review = slot.getByText(proposal.diffs[0]!.after.summary).closest("details");
    if (!(review instanceof HTMLDetailsElement)) throw new Error("Expected an inspectable retained proposal");
    if (!review.open) fireEvent.click(within(review).getByText(/^Review pending reflection/));
    await waitFor(() => expect(within(review).getByRole("button", { name: "Reject proposal" }).matches(":disabled")).toBe(false));
    await act(async () => { fireEvent.click(within(review).getByRole("button", { name: "Reject proposal" })); });
    await waitFor(async () => expect(await f.call("getReflection", { ...f.selection, id: proposal.id }, memoryRpcContract.getReflection.output)).toMatchObject({ state: "rejected" }));
    expect((await f.history(original.id)).map((entry) => entry.snapshot)).toEqual([original]);
    slot.unmount();
    const cold = f.mount();
    fireEvent.click(await cold.findByRole("button", { name: "History of retained-original" }));
    expect(within(await cold.findByRole("region", { name: "Memory version history" })).getByText(original.summary)).toBeTruthy();
  });
});

describe("rendered version-pinned replacement retrieval", () => {
  it("follows the original replacement revision at 100 and 101 versions instead of showing only recent revisions", async () => {
    const f = await fixture();
    const original = await f.create("replaced-decision", "A decision superseded by inspected evidence");
    const first = await f.create("replacement-decision", "Original replacement conclusion at version one", { id: original.id, version: original.version });
    expect((await f.history(first.id)).map((entry) => entry.snapshot)).toEqual([first]);
    let current = first;
    for (let version = 2; version <= 100; version += 1) {
      const proposal = await f.propose(current, `Reviewed replacement revision ${version}`);
      await f.decide(proposal.id, "apply");
      const updated = await f.read(first.id);
      if (!updated) throw new Error("Reviewed replacement disappeared");
      current = updated;
    }
    expect(current.version).toBe(100);
    expect((await f.read(original.id))?.lineage?.replacedBy).toEqual({ id: first.id, version: 1 });
    expect((await f.call("memoryHistory", { ...f.selection, task: { taskId: f.task.id, context: "unrelated" }, name: first.id }, memoryRpcContract.memoryHistory.output)).history).toEqual([]);
    const slot = f.mount();
    fireEvent.click(await slot.findByRole("button", { name: "Inspect replacement v1" }));
    expect(within(await slot.findByRole("region", { name: "Memory version history" })).getByText(first.summary)).toBeTruthy();
    await finishRefresh(slot);
    const proposal = await f.propose(current, "Reviewed replacement revision 101");
    await f.decide(proposal.id, "apply");
    expect(await f.read(first.id)).toMatchObject({ version: 101, summary: "Reviewed replacement revision 101" });
    fireEvent.click(slot.getByRole("button", { name: "Refresh evidence" }));
    const currentHeading = await slot.findByRole("heading", { name: /^replacement-decision · v101 ·/ });
    const currentRecord = currentHeading.closest("li");
    if (!(currentRecord instanceof HTMLLIElement)) throw new Error("Expected the current replacement record");
    expect(within(currentRecord).getByText("Reviewed replacement revision 101")).toBeTruthy();
    await finishRefresh(slot);
    fireEvent.click(slot.getByRole("button", { name: "Inspect replacement v1" }));
    const pinned = await slot.findByRole("region", { name: "Memory version history" });
    expect(within(pinned).getByText(first.summary)).toBeTruthy();
  }, 60_000);
});
