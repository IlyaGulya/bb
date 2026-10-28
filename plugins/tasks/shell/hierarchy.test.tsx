// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakePluginHost, type FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createStore, registerTasksApi } from "../api/index.js";
import { tasksRpcContract } from "../shared/contract.js";
import { EMPTY_FILTERS } from "../views/list/filter-bar.js";
import { listPreferenceScope, storeListPreference } from "../views/list/list-preference.js";

const app = await loadPluginApp(() => import("../app.js"));
const harnesses: FakePluginHarness[] = [];

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(async () => {
  cleanup();
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
  harnesses.push(harness);
  const store = createStore(bb);
  registerTasksApi(bb, store);
  const project = store.tasks.createProject({ name: "Hierarchy", prefix: "HIER", color: "blue" });
  const other = store.tasks.createProject({ name: "Other", prefix: "OTHER", color: "green" });
  const first = store.tasks.createTask({ projectId: project.id, title: "First epic", status: "in_progress" });
  const second = store.tasks.createTask({ projectId: project.id, title: "Second epic", status: "in_progress" });
  const review = store.tasks.createTask({ projectId: project.id, title: "Review child", parentTaskId: first.id, status: "in_review", priority: "high" });
  const backlog = store.tasks.createTask({ projectId: project.id, title: "Backlog child", parentTaskId: second.id });
  const done = store.tasks.createTask({ projectId: project.id, title: "Done child", parentTaskId: first.id, status: "done" });
  const foreign = store.tasks.createTask({ projectId: other.id, title: "Other project task", status: "in_review" });
  const label = store.tasks.createLabel({ projectId: project.id, name: "Release", color: "blue" });
  store.tasks.addTaskLabel(review.id, label.id);
  const rpc = Object.fromEntries(Object.keys(tasksRpcContract).map((method) => [
    method,
    (input: unknown) => harness.callRpc(method, input),
  ]));
  const open = (subPath: string) => renderSlot(app.navPanels[0]!, { subPath }, { rpc });
  return { store, harness, project, other, first, second, review, backlog, done, foreign, open };
}

type Slot = ReturnType<typeof renderSlot>;

function taskKeys(slot: Slot): string[] {
  return [...slot.container.querySelectorAll("[data-task-key]")]
    .map((element) => element.getAttribute("data-task-key")!)
    .sort();
}

async function choose(slot: Slot, filter: RegExp, option: string) {
  fireEvent.keyDown(slot.getByRole("button", { name: filter }), { key: "ArrowDown" });
  const item = await slot.findByRole("menuitemcheckbox", { name: option });
  fireEvent.click(item);
  fireEvent.keyDown(item, { key: "Escape" });
}

async function mutate(setupResult: ReturnType<typeof setup>, slot: Slot, method: string, input: unknown) {
  const offset = setupResult.harness.realtimeSignals.length;
  const result = await setupResult.harness.callRpc(method, input);
  for (const signal of setupResult.harness.realtimeSignals.slice(offset)) {
    await slot.behavior.emitRealtime(signal.channel, signal.payload);
  }
  return result;
}

describe.each(["list", "board"] as const)("%s task hierarchy", (view) => {
  it("shows children in their own status, filters by parent and opens a filtered-out parent", async () => {
    const fixture = setup();
    const { project, first, second, review, backlog, done, foreign } = fixture;
    const slot = fixture.open(`${project.id}?view=${view}`);
    const allKeys = [first.key, second.key, review.key, backlog.key, done.key].sort();
    await waitFor(() => expect(taskKeys(slot)).toEqual(allKeys));
    expect(taskKeys(slot)).not.toContain(foreign.key);
    expect(slot.getByText("5 tasks")).toBeDefined();
    if (view === "board") {
      const epic = slot.container.querySelector<HTMLElement>(`[data-task-key="${first.key}"]`)!;
      expect(within(epic).getByText("1/2")).toBeDefined();
    }
    fixture.store.tasks.upsertTaskThread({ taskId: review.id, threadId: "thr_child_worker", presetName: "Child worker", title: "Working", liveStatus: "working" });
    await slot.behavior.emitRealtime("threads:changed", { taskId: review.id });
    await slot.findByText(view === "board" ? "Child worker" : "Active", { selector: "span" });

    await choose(slot, /^Status/, "In Review");
    await waitFor(() => expect(taskKeys(slot)).toEqual([review.key]));
    const badge = await slot.findByRole("button", { name: `Open parent ${first.key} · First epic` });
    fireEvent.click(badge);
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel", path: "tasks", options: { subPath: `task/${first.key}` },
    });
    await mutate(fixture, slot, "updateTask", { taskId: first.id, title: "Renamed epic" });
    await slot.findByRole("button", { name: `Open parent ${first.key} · Renamed epic` });
    expect(taskKeys(slot)).toEqual([review.key]);
    await mutate(fixture, slot, "updateTask", { taskId: review.id, status: "backlog" });
    await waitFor(() => expect(taskKeys(slot)).toEqual([]));
    await mutate(fixture, slot, "updateTask", { taskId: review.id, status: "in_review" });
    await waitFor(() => expect(taskKeys(slot)).toEqual([review.key]));

    await choose(slot, /^Parent\/Epic/, `${second.key} · Second epic`);
    await waitFor(() => expect(taskKeys(slot)).toEqual([]));
    fireEvent.click(slot.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(taskKeys(slot)).toEqual(allKeys));
    await choose(slot, /^Parent\/Epic/, `${first.key} · Renamed epic`);
    await waitFor(() => expect(taskKeys(slot)).toEqual([review.key, done.key].sort()));
    await choose(slot, /^Parent\/Epic/, "All");
    await waitFor(() => expect(taskKeys(slot)).toEqual(allKeys));
    await choose(slot, /^Parent\/Epic/, `${first.key} · Renamed epic`);
    await choose(slot, /^Priority/, "High");
    await choose(slot, /^Label/, "Release");
    await waitFor(() => expect(taskKeys(slot)).toEqual([review.key]));
    fireEvent.click(slot.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(taskKeys(slot)).toEqual(allKeys));
  });

  it("keeps parent filters, badges and progress correct across mutations and reconnect", async () => {
    const fixture = setup();
    const { store, project, first, second, review, backlog, done } = fixture;
    const slot = fixture.open(`${project.id}?view=${view}`);
    await waitFor(() => expect(taskKeys(slot)).toEqual([first.key, second.key, review.key, backlog.key, done.key].sort()));
    await choose(slot, /^Parent\/Epic/, `${first.key} · First epic`);
    await waitFor(() => expect(taskKeys(slot)).toEqual([review.key, done.key].sort()));

    await mutate(fixture, slot, "updateTask", { taskId: review.id, parentTaskId: second.id });
    await waitFor(() => expect(taskKeys(slot)).toEqual([done.key]));
    await mutate(fixture, slot, "updateTask", { taskId: backlog.id, parentTaskId: first.id, status: "in_review" });
    await waitFor(() => expect(taskKeys(slot)).toEqual([backlog.key, done.key].sort()));
    await within(slot.container.querySelector<HTMLElement>(`[data-task-key="${backlog.key}"]`)!)
      .findByRole("button", { name: `Open parent ${first.key} · First epic` });

    const created = tasksRpcContract.createTask.output.parse(await mutate(fixture, slot, "createTask", {
      projectId: project.id, title: "New child", parentTaskId: first.id, status: "backlog",
    }));
    if (!created.ok) throw new Error(created.error.message);
    await waitFor(() => expect(taskKeys(slot)).toEqual([backlog.key, done.key, created.task.key].sort()));
    await mutate(fixture, slot, "updateTask", { taskId: created.task.id, status: "done", title: "Completed new child" });
    await slot.findByText("Completed new child");
    fireEvent.click(slot.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(taskKeys(slot)).toEqual([first.key, second.key, review.key, backlog.key, done.key, created.task.key].sort()));
    if (view === "board") {
      const epic = slot.container.querySelector<HTMLElement>(`[data-task-key="${first.key}"]`)!;
      expect(within(epic).getByText("2/3")).toBeDefined();
    }

    await mutate(fixture, slot, "deleteTask", { taskId: first.id });
    await waitFor(() => expect(taskKeys(slot)).toEqual([second.key, review.key, backlog.key, done.key, created.task.key].sort()));
    expect(slot.queryByRole("button", { name: `Open parent ${first.key} · First epic` })).toBeNull();
    await mutate(fixture, slot, "deleteTask", { taskId: created.task.id });
    await waitFor(() => expect(taskKeys(slot)).toEqual([second.key, review.key, backlog.key, done.key].sort()));

    await slot.behavior.setRealtimeConnectionState("reconnecting");
    store.tasks.updateTask(second.id, { title: "Reconnected epic" });
    store.tasks.updateTask(review.id, { title: "Reconnected child", status: "backlog" });
    const missed = store.tasks.createTask({ projectId: project.id, title: "Created offline", parentTaskId: second.id });
    await slot.behavior.setRealtimeConnectionState("connected");
    await slot.findByText("Reconnected child");
    await slot.findByText("Created offline");
    await within(slot.container.querySelector<HTMLElement>(`[data-task-key="${review.key}"]`)!)
      .findByRole("button", { name: `Open parent ${second.key} · Reconnected epic` });
    await waitFor(() => expect(taskKeys(slot)).toEqual([second.key, review.key, backlog.key, done.key, missed.key].sort()));
    await choose(slot, /^Parent\/Epic/, `${second.key} · Reconnected epic`);
    await waitFor(() => expect(taskKeys(slot)).toEqual([review.key, missed.key].sort()));
    await mutate(fixture, slot, "deleteTask", { taskId: second.id });
    await waitFor(() => expect(taskKeys(slot)).toEqual([]));
    expect(slot.getByRole("button", { name: /Parent\/Epic.*Unavailable parent/ })).toBeDefined();
    fireEvent.click(slot.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(taskKeys(slot)).toEqual([review.key, backlog.key, done.key, missed.key].sort()));
  });
});

it("resolves a child's parent beyond the first page of roots while filtering by child status", async () => {
  const { store, project, first, review, open } = setup();
  store.database.transaction(() => {
    for (let index = 0; index < 501; index += 1) {
      store.tasks.createTask({ projectId: project.id, title: `Closed root ${index}`, status: "done" });
    }
  })();
  storeListPreference(listPreferenceScope(project.id, false), {
    filters: { ...EMPTY_FILTERS, statuses: ["in_review"] }, sort: "manual",
  });
  const slot = open(`${project.id}?view=list`);
  await waitFor(() => expect(taskKeys(slot)).toEqual([review.key]));
  await slot.findByRole("button", { name: `Open parent ${first.key} · First epic` });
});

it("shows a working child in Active and reaches it through the project pager", async () => {
  const fixture = setup();
  const { store, review, project, second } = fixture;
  store.tasks.upsertTaskThread({ taskId: review.id, threadId: "thr_child_worker", presetName: "Child worker", title: "Working", liveStatus: "working" });
  const active = fixture.open("active");
  await waitFor(() => expect(taskKeys(active)).toEqual([review.key]));
  expect(within(active.container.querySelector<HTMLElement>(`[data-task-key="${review.key}"]`)!).getByText("Active")).toBeDefined();
  active.lifecycle.unmount();

  const slot = fixture.open(`task/${second.key}`);
  await slot.findByText("3 / 5");
  fireEvent.click(slot.getByRole("button", { name: "Next task" }));
  expect(slot.navigateCalls).toContainEqual({
    method: "toPluginPanel", path: "tasks", options: { subPath: `task/${review.key}` },
  });
  expect(tasksRpcContract.sidebarSummary.output.parse(await fixture.harness.callRpc("sidebarSummary", null))).toEqual({
    projects: [
      { projectId: project.id, taskCount: 5, activeAgentCount: 1 },
      { projectId: fixture.other.id, taskCount: 1, activeAgentCount: 0 },
    ],
  });
});
