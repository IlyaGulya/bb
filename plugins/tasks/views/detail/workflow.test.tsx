// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { createFakePluginHost, makeHostResponse, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createStore } from "../../api/index.js";
import { WorkflowPreparationStore } from "../../workflow/preparation-store.js";
import { workflowSetupContract } from "../../shared/workflow-preparation.js";
import { TasksRefreshProvider } from "../../shell/refresh.js";
import { TaskWorkflowPanel } from "./workflow.js";
import { registerTaskWorkflows } from "../../workflow/index.js";
import { seedWorkflowOwnership } from "../../workflow/ownership.test-fixtures.js";
import { workflowRpcContract } from "../../shared/workflow-contract.js";
import { buildReviewStartSchema, type BuildReviewStart } from "../../workflow/remote-contract.js";
import type { WorkflowSelection } from "../../shared/workflow-preparation.js";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];
afterEach(async () => {
  cleanup();
  await Promise.all(hosts.splice(0).map(host => host.harness.dispose()));
});

function WorkflowHarness({ taskId }: { taskId: string }) {
  return <TasksRefreshProvider><TaskWorkflowPanel taskId={taskId} profiles={[]} /></TasksRefreshProvider>;
}

it("keeps one actionable workflow entry across draft saves, refresh and reopen without launching", async () => {
  const host = createFakePluginHost({ pluginId: "tasks" });
  hosts.push(host);
  const store = createStore(host.bb);
  const project = store.tasks.createProject({ name: "Lifecycle project", prefix: "LC", color: "blue" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Lifecycle owner" });
  const drafts = new WorkflowPreparationStore(store);
  const slot = renderSlot({ component: WorkflowHarness }, { taskId: task.id }, {
    sdk: { experimental_executionContexts: { list: async () => [] }, experimental_modelConnections: { list: async () => [] } },
    rpc: {
      listMachines: () => ({ machines: [] }),
      taskWorkflows: () => ({ runs: [] }),
      getTaskWorkflowPreparation: () => null,
      getTaskWorkflowProject: () => ({ id: "proj_lifecycle", name: "Lifecycle code" }),
      getProjectWorkflowSettings: () => ({ revision: 0, selection: null }),
      getTaskWorkflowDraft: () => drafts.draft(task.id),
      saveTaskWorkflowDraft: input => {
        const parsed = workflowSetupContract.saveTaskWorkflowDraft.input.parse(input);
        return drafts.saveDraft(parsed.taskId, parsed.revision, parsed.selection);
      },
    },
  });
  const trigger = await slot.findByRole("button", { name: "Launch workflow" });
  trigger.focus();
  fireEvent.click(trigger);
  await slot.findByRole("dialog", { name: "Launch workflow" });
  const checks = await slot.findByRole("textbox", { name: /Required platform smoke commands/ });
  fireEvent.change(checks, { target: { value: "node smoke.mjs" } });
  await waitFor(() => expect(drafts.draft(task.id).selection.smokeCommands).toEqual(["node smoke.mjs"]));
  slot.rerender(<WorkflowHarness taskId={task.id} />);
  await slot.behavior.emitRealtime("projects:changed", {});
  expect(slot.getAllByRole("button", { name: "Launch workflow" })).toHaveLength(1);
  expect(slot.getAllByRole("dialog", { name: "Launch workflow" })).toHaveLength(1);
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(slot.queryByRole("dialog", { name: "Launch workflow" })).toBeNull());
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  await slot.findByRole("dialog", { name: "Launch workflow" });
  expect((slot.getByRole("textbox", { name: /Required platform smoke commands/ }) as HTMLTextAreaElement).value).toBe("node smoke.mjs");
  expect(slot.rpcCalls.some(call => ["prepareTaskWorkflow", "launchTaskWorkflow"].includes(call.method))).toBe(false);
});

it.each(["pending acknowledgement", "failed save"] as const)("first-writer retry respects repair autosave %s", async boundary => {
  const nativeRequests: BuildReviewStart[] = [];
  const sdk = {
    hosts: { list: async () => [makeHostResponse({ id: "owned-host", name: "Owned machine" })] },
    projects: { get: async () => ({ id: "proj_ui", name: "Owned UI code" }) },
    experimental_executionContexts: {
      list: async () => [
        { id: "owned-context", name: "Original context", enabled: true, projectIds: ["proj_ui"] },
        { id: "repaired-context", name: "Repaired context", enabled: true, projectIds: ["proj_ui"] },
      ],
      getProjectDefaults: async () => ({ projectId: "proj_ui", executionContextId: null, modelConnectionId: null }),
    },
    experimental_modelConnections: { list: async () => [{ id: "owned-account", name: "Owned account", provider: "acp-omp", hostId: null, gateway: { allowedHostIds: ["owned-host"], accountPrefix: "personal-codex" }, enabled: true, revoked: false }] },
    providers: { models: async () => ({ models: [{ id: "sol", model: "bb-cpa/personal-codex/gpt-6.1-sol", displayName: "Sol 6.1", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }], selectedOnlyModels: [], modelLoadError: null }) },
    environments: {
      get: async () => ({ id: "owned-environment", hostId: "owned-host", projectId: "proj_ui", path: "/owned/workflow", status: "ready", lifecycle: { phase: "active" }, hostLifecycle: "active" }),
    },
    threads: {
      get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "proj_ui", environmentId: "owned-environment", status: "idle" }),
      list: async () => [],
    },
    plugins: { callRpc: async ({ method, input }: { method: string; input: unknown }) => {
      if (method !== "startBuildReview") throw new Error(`Unexpected native action ${method}`);
      const request = buildReviewStartSchema.parse(input);
      nativeRequests.push(request);
      return { runId: "retried-native", key: request.key, contextStarted: false, status: "queued", phase: null, error: null, result: null, workers: [], policyLimitations: [] };
    } },
  };
  const host = createFakePluginHost({ pluginId: "tasks", sdk });
  hosts.push(host);
  const store = createStore(host.bb);
  const project = store.tasks.createProject({ name: "Repair UI", prefix: "RUI", color: "blue", linkedBbProjectId: "proj_ui" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Owned first writer repair" });
  const owner = seedWorkflowOwnership(store, task.id, "proj_ui", "sending");
  owner.workflows.publish(owner.request.group, { runId: "rejected-native", key: owner.request.key, contextStarted: false, status: "failed", phase: null, error: "First context was definitively rejected", result: null, workers: [], policyLimitations: [] });
  const selection: WorkflowSelection = {
    template: "development-review", hostId: "owned-host", baseBranch: "",
    writer: { ...owner.request.writer, executionContextId: "owned-context", modelConnectionId: "owned-account" },
    reviewer: { ...owner.request.reviewer, executionContextId: "owned-context", modelConnectionId: "owned-account" },
    smokeCommands: owner.request.smokeCommands, uiRequired: false,
  };
  registerTaskWorkflows(host.bb, store, { background: false });
  const drafts = new WorkflowPreparationStore(store);
  drafts.saveDraft(task.id, 0, selection);
  let enter!: () => void;
  let release!: () => void;
  let finish!: () => void;
  let saveStarted = false;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const rpc = Object.fromEntries([...Object.keys(workflowSetupContract), ...Object.keys(workflowRpcContract)].map(method => [method, (input: unknown) => host.harness.callRpc(method, input)]));
  const slot = renderSlot({ component: WorkflowHarness }, { taskId: task.id }, {
    sdk,
    rpc: {
      ...rpc,
      listMachines: async () => ({ machines: await sdk.hosts.list() }),
      saveTaskWorkflowDraft: async input => {
        saveStarted = true;
        enter();
        try {
          await released;
          if (boundary === "failed save") throw new Error("Owned repair save rejected");
          return await host.harness.callRpc("saveTaskWorkflowDraft", input);
        } finally { finish(); }
      },
    },
  });
  try {
    fireEvent.click(await slot.findByRole("button", { name: "Workflow details" }));
    const dialog = await slot.findByRole("dialog", { name: "Launch workflow" });
    const writer = await within(dialog).findByRole("group", { name: "Writer" });
    fireEvent.click(writer.querySelector("summary")!);
    fireEvent.click(await within(writer).findByRole("combobox", { name: "Writer context" }));
    fireEvent.click(await slot.findByRole("option", { name: "Repaired context" }));
    await entered;
    if (boundary === "failed save") await act(async () => { release(); await finished; });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close", exact: true }));
    await waitFor(() => expect(slot.queryByRole("dialog", { name: "Launch workflow" })).toBeNull());
    fireEvent.change(slot.getByRole("textbox", { name: "Human feedback" }), { target: { value: "Retry only my acknowledged repair choices" } });
    await act(async () => { fireEvent.click(slot.getByRole("button", { name: "Retry first writer with feedback" })); });
    expect(owner.workflows.get(owner.request.group)).toMatchObject({ revision: 1, state: "failed" });
    expect(owner.workflows.request(owner.request.group)).toEqual(owner.request);
    expect(nativeRequests).toEqual([]);
    if (boundary === "pending acknowledgement") {
      await act(async () => { release(); await finished; });
      if (owner.workflows.get(owner.request.group).revision === 1) await act(async () => { fireEvent.click(slot.getByRole("button", { name: "Retry first writer with feedback" })); });
      await waitFor(() => expect(owner.workflows.get(owner.request.group)).toMatchObject({ revision: 2, state: "running" }));
      expect(owner.workflows.request(owner.request.group).writer.executionContextId).toBe("repaired-context");
      expect(drafts.savedDraft(task.id)?.selection.writer?.executionContextId).toBe("repaired-context");
      expect(nativeRequests.map(request => request.writer.executionContextId)).toEqual(["repaired-context"]);
    } else {
      expect(drafts.savedDraft(task.id)?.selection.writer?.executionContextId).toBe("owned-context");
      expect(store.tasks.getTask(task.id)?.status).not.toBe("done");
    }
  } finally {
    release();
    if (saveStarted) await act(async () => { await finished; });
  }
});
