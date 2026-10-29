// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFakePluginHost, makeHostResponse, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createStore } from "../../api/index.js";
import { WorkflowPreparationStore } from "../../workflow/preparation-store.js";
import { workflowSetupContract } from "../../shared/workflow-preparation.js";
import { TasksRefreshProvider } from "../../shell/refresh.js";
import { TaskWorkflowPanel } from "./workflow.js";
import { registerTaskWorkflows } from "../../workflow/index.js";
import { seedWorkflowOwnership } from "../../workflow/ownership.test-fixtures.js";
import { workflowRpcContract, type TaskWorkflow } from "../../shared/workflow-contract.js";
import { buildReviewStartSchema, type BuildReviewStart } from "../../workflow/remote-contract.js";
import type { WorkflowSelection } from "../../shared/workflow-preparation.js";
import { CompactViewportOverrideProvider } from "@/components/ui/hooks/use-compact-viewport";
import { TaskWorkflowStore } from "../../workflow/store.js";

function WorkflowRunHarness({ taskId, compact }: { taskId: string; compact: boolean }) {
  return <CompactViewportOverrideProvider isCompactViewport={compact}><WorkflowHarness taskId={taskId} /></CompactViewportOverrideProvider>;
}

function workflowViewGate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function workflowRunFixture() {
  let withdrawn = false;
  let holdAcknowledgement = false;
  let rejectStart = false;
  let holdSnapshot = false;
  let workspaceBranch = "owned-ui";
  let capturedSnapshot: { runs: TaskWorkflow[] } | null = null;
  let acknowledgedMutation: TaskWorkflow | null = null;
  const mutationAcknowledged = workflowViewGate();
  const acknowledged = workflowViewGate();
  const releaseAcknowledgement = workflowViewGate();
  const observed = workflowViewGate();
  const snapshotEntered = workflowViewGate();
  const releaseSnapshot = workflowViewGate();
  const snapshotReturned = workflowViewGate();
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  let serial = 0;
  const metadata = new Map<string, object>();
  const requests: BuildReviewStart[] = [];
  const native = {
    runId: "ui-native-run", contextStarted: true, status: "running" as const,
    phase: "Build / platform smoke", error: null, result: null,
    workers: [{ role: "writer" as const, threadId: "thr_ui_native_writer", callIndex: 1 }],
    policyLimitations: [],
  };
  const host = createFakePluginHost({ pluginId: "tasks", sdk: {
    hosts: { list: async () => [makeHostResponse({ id: "ui-host", name: "UI host" })] },
    projects: { get: async () => ({ id: "proj_view", name: "Workflow view code" }) },
    experimental_executionContexts: {
      list: async () => withdrawn ? [] : [{ id: "ui-context", name: "UI context", enabled: true, projectIds: ["proj_view"] }],
      getProjectDefaults: async () => ({ projectId: "proj_view", executionContextId: null, modelConnectionId: null }),
    },
    experimental_modelConnections: { list: async () => withdrawn ? [] : [{ id: "ui-account", name: "UI account", provider: "acp-omp", hostId: null, gateway: { allowedHostIds: ["ui-host"], accountPrefix: "personal-codex" }, enabled: true, revoked: false }] },
    providers: { models: async () => ({ models: [{ id: "bb-cpa/personal-codex/gpt-6.1-sol", model: "bb-cpa/personal-codex/gpt-6.1-sol", displayName: "Sol 6.1", description: "Owned UI model", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }], defaultReasoningEffort: "high", isDefault: true }], selectedOnlyModels: [], modelLoadError: null }) },
    environments: {
      get: async () => ({ id: "ui-environment", hostId: "ui-host", projectId: "proj_view", path: "/owned/ui-workflow", status: "ready", lifecycle: { phase: "active" }, hostLifecycle: "active" }),
      status: async () => ({ outcome: "available", workspace: { checkout: { kind: "branch", branchName: workspaceBranch, headSha: "a".repeat(40) }, workingTree: { hasUncommittedChanges: false } } }),
    },
    threads: {
      get: async ({ threadId }) => { const thread = threads.get(threadId); if (!thread) throw new Error(`Unknown UI thread ${threadId}`); return thread; },
      list: async () => [...threads.values()],
      getPluginMetadata: async ({ threadId }) => metadata.get(threadId) ?? {},
      spawn: async args => {
        if (!args.preparationOnly) throw new Error("Only zero-turn preparation is permitted in this fixture");
        const thread = makeThreadResponse({ id: `thr_ui_prepared_${++serial}`, projectId: "proj_view", environmentId: "ui-environment", originPluginId: "tasks" });
        threads.set(thread.id, thread);
        metadata.set(thread.id, args.pluginMetadata ?? {});
        return thread;
      },
    },
    plugins: { callRpc: async args => {
      if (args.method === "releaseBuildReviewContexts") return { released: true };
      if (args.method === "startBuildReview") {
        const request = buildReviewStartSchema.parse(args.input);
        requests.push(request);
        const writer = native.workers[0];
        if (!writer) throw new Error("Owned workflow fixture has no retained writer");
        threads.set(writer.threadId, makeThreadResponse({ id: writer.threadId, projectId: "proj_view", environmentId: "ui-environment", status: "active" }));
        return { ...native, key: request.key };
      }
      const request = requests[0];
      if (args.method !== "inspectBuildReview" || !request) throw new Error(`Unexpected UI native action ${args.method}`);
      return { ...native, key: request.key };
    } },
  } });
  hosts.push(host);
  const store = createStore(host.bb);
  const project = store.tasks.createProject({ name: "Workflow view tracker", prefix: "VIEW", color: "blue", linkedBbProjectId: "proj_view" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Post-start workflow view" });
  const handlers = registerTaskWorkflows(host.bb, store, { background: false });
  const role = { provider: "acp-omp", model: "bb-cpa/personal-codex/gpt-6.1-sol", executionContextId: "ui-context", modelConnectionId: "ui-account", reasoningLevel: "high", permissionMode: "full" as const, serviceTier: null, instructions: "Owned UI role" };
  const selection: WorkflowSelection = { template: "development-review", hostId: "ui-host", baseBranch: "", writer: role, reviewer: { ...role, instructions: "Fresh reviewer" }, smokeCommands: ["owned-ui-check"], uiRequired: false };
  const draft = await handlers.saveTaskWorkflowDraft({ taskId: task.id, revision: 0, selection });
  await handlers.prepareTaskWorkflow({ taskId: task.id, revision: draft.revision });
  const preparation = await handlers.getTaskWorkflowPreparation({ taskId: task.id });
  if (preparation?.state !== "ready") throw new Error("UI fixture preparation did not become ready");
  const launch = { taskId: task.id, preparationId: preparation.id };
  function reviewed() {
    const owner = seedWorkflowOwnership(store, task.id, "proj_view", "in_review");
    const result = owner.view.native?.result;
    const writer = native.workers[0];
    if (!result || !writer) throw new Error("Owned workflow fixture has no reviewed result or writer");
    workspaceBranch = result.build.branch;
    writer.threadId = "thr_ownedretainedwriter";
    for (const id of [owner.request.originThreadId, "thr_ownedretainedwriter", "thr_ownedretainedreviewer"]) {
      threads.set(id, makeThreadResponse({ id, projectId: "proj_view", environmentId: "ui-environment", status: "idle" }));
    }
    return owner;
  }
  function advanceNativeReview() {
    const writer = native.workers[0];
    const thread = writer && threads.get(writer.threadId);
    if (!thread) throw new Error("Owned retained writer is unavailable");
    threads.set(thread.id, { ...thread, status: "idle" });
    native.phase = "Independent review";
  }
  const rpc = Object.fromEntries([...Object.keys(workflowSetupContract), ...Object.keys(workflowRpcContract)].map(method => [method, (input: unknown) => host.harness.callRpc(method, input)]));
  function render(compact: boolean) {
    return renderSlot({ component: WorkflowRunHarness }, { taskId: task.id, compact }, {
      sdk: {
        hosts: { list: host.bb.sdk.hosts.list },
        projects: { get: host.bb.sdk.projects.get },
        experimental_executionContexts: { list: host.bb.sdk.experimental_executionContexts.list, getProjectDefaults: host.bb.sdk.experimental_executionContexts.getProjectDefaults },
        experimental_modelConnections: { list: host.bb.sdk.experimental_modelConnections.list },
        providers: { models: host.bb.sdk.providers.models },
        environments: { get: host.bb.sdk.environments.get, status: host.bb.sdk.environments.status },
        threads: { get: host.bb.sdk.threads.get, list: host.bb.sdk.threads.list },
        plugins: { callRpc: host.bb.sdk.plugins.callRpc },
      },
      rpc: {
        ...rpc,
        listMachines: async () => ({ machines: await host.bb.sdk.hosts.list() }),
        launchTaskWorkflow: async input => {
          if (rejectStart) throw new Error("Owned Start rejected before admission");
          const run = await host.harness.callRpc("launchTaskWorkflow", input);
          acknowledged.release();
          if (holdAcknowledgement) await releaseAcknowledgement.promise;
          return run;
        },
        returnTaskWorkflow: async input => {
          const run = workflowRpcContract.returnTaskWorkflow.output.parse(await host.harness.callRpc("returnTaskWorkflow", input));
          acknowledgedMutation = run;
          mutationAcknowledged.release();
          return run;
        },
        acceptTaskWorkflow: async input => {
          const run = workflowRpcContract.acceptTaskWorkflow.output.parse(await host.harness.callRpc("acceptTaskWorkflow", input));
          acknowledgedMutation = run;
          mutationAcknowledged.release();
          return run;
        },
        taskWorkflows: async input => {
          const result = workflowRpcContract.taskWorkflows.output.parse(await host.harness.callRpc("taskWorkflows", input));
          if (holdSnapshot) {
            holdSnapshot = false;
            capturedSnapshot = result;
            snapshotEntered.release();
            await releaseSnapshot.promise;
            snapshotReturned.release();
          }
          if (result.runs.some(run => run.native?.phase === native.phase)) observed.release();
          return result;
        },
      },
    });
  }
  return { store, task, handlers, launch, selection, requests, native, render, reviewed, advanceNativeReview, acknowledged: acknowledged.promise, observed: observed.promise, release: releaseAcknowledgement.release, hold: () => { holdAcknowledgement = true; }, withdraw: () => { withdrawn = true; }, reject: () => { rejectStart = true; }, holdSnapshot: () => { holdSnapshot = true; }, snapshot: () => capturedSnapshot, snapshotEntered: snapshotEntered.promise, snapshotReturned: snapshotReturned.promise, releaseSnapshot: releaseSnapshot.release, mutationAcknowledged: mutationAcknowledged.promise, mutation: () => acknowledgedMutation };
}

function expectRunDetails(dialog: HTMLElement, phase: string) {
  const details = within(dialog).getByRole("region", { name: "Workflow run details" });
  expect(within(details).getByRole("article").textContent).toContain(phase);
  expect(within(details).getByRole("button", { name: "Open writer" }).hasAttribute("disabled")).toBe(false);
  expect(within(dialog).queryByRole("group", { name: "Writer" })).toBeNull();
  expect(within(dialog).queryByRole("group", { name: "Independent reviewer" })).toBeNull();
  expect(within(dialog).queryByRole("textbox", { name: /Required platform smoke commands/ })).toBeNull();
  expect(within(dialog).queryByRole("button", { name: "Start workflow" })).toBeNull();
  expect(within(dialog).queryByRole("button", { name: "Prepare workspace" })).toBeNull();
}

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];
afterEach(async () => {
  cleanup();
  await Promise.all(hosts.splice(0).map(host => host.harness.dispose()));
  vi.unstubAllGlobals();
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
    plugins: { callRpc: async ({ method, input }: { method: string; input?: unknown }) => {
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
    sdk: {
      hosts: { list: host.bb.sdk.hosts.list },
      projects: { get: host.bb.sdk.projects.get },
      experimental_executionContexts: {
        list: host.bb.sdk.experimental_executionContexts.list,
        getProjectDefaults: host.bb.sdk.experimental_executionContexts.getProjectDefaults,
      },
      experimental_modelConnections: { list: host.bb.sdk.experimental_modelConnections.list },
      providers: { models: host.bb.sdk.providers.models },
      environments: { get: host.bb.sdk.environments.get },
      threads: { get: host.bb.sdk.threads.get, list: host.bb.sdk.threads.list },
      plugins: { callRpc: host.bb.sdk.plugins.callRpc },
    },
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
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
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

it.each([false, true])("acknowledged Start closes setup and reopens run details without live catalogs (compact=%s)", async compact => {
  const fixture = await workflowRunFixture();
  const slot = fixture.render(compact);
  const trigger = await slot.findByRole("button", { name: "Launch workflow" });
  trigger.focus();
  fireEvent.click(trigger);
  const start = await slot.findByRole("button", { name: "Start workflow" });
  await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
  fireEvent.click(start);
  await fixture.acknowledged;
  await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(trigger);
  fixture.withdraw();
  fireEvent.click(await slot.findByRole("button", { name: "Workflow details" }));
  const dialog = await slot.findByRole("dialog", { name: "Workflow details" });
  expectRunDetails(dialog, fixture.native.phase);
  expect(new WorkflowPreparationStore(fixture.store).savedDraft(fixture.task.id)?.selection).toEqual(fixture.selection);
});

it.each([false, true])("polling hands an open setup to run details before the Start response arrives (compact=%s)", async compact => {
  const fixture = await workflowRunFixture();
  fixture.hold();
  const slot = fixture.render(compact);
  try {
    fireEvent.click(await slot.findByRole("button", { name: "Launch workflow" }));
    const start = await slot.findByRole("button", { name: "Start workflow" });
    await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
    fireEvent.click(start);
    await fixture.acknowledged;
    fixture.withdraw();
    await fixture.observed;
    const dialog = await slot.findByRole("dialog", { name: "Workflow details" });
    expectRunDetails(dialog, fixture.native.phase);
    const request = fixture.requests[0];
    if (!request) throw new Error("The owned native workflow was not admitted");
    expect(new TaskWorkflowStore(fixture.store).get(request.group)).toMatchObject({ state: "running", native: { contextStarted: true } });
    await act(async () => { fixture.release(); });
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
  } finally {
    fixture.release();
  }
});

it.each([false, true])("a delayed pre-start poll cannot restore setup after Start acknowledgement (compact=%s)", async compact => {
  const fixture = await workflowRunFixture();
  const slot = fixture.render(compact);
  try {
    const trigger = await slot.findByRole("button", { name: "Launch workflow" });
    fireEvent.click(trigger);
    const start = await slot.findByRole("button", { name: "Start workflow" });
    await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
    fixture.holdSnapshot();
    await fixture.snapshotEntered;
    fireEvent.click(start);
    await fixture.acknowledged;
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    await act(async () => { fixture.releaseSnapshot(); await fixture.snapshotReturned; });
    expect(slot.getByRole("button", { name: "Workflow details" })).toBe(trigger);
    fireEvent.click(trigger);
    expectRunDetails(await slot.findByRole("dialog", { name: "Workflow details" }), fixture.native.phase);
  } finally {
    fixture.releaseSnapshot();
  }
});

it.each([
  [false, "running"], [true, "running"], [false, "failed"], [true, "failed"],
] as const)("reload retains immutable run details (compact=%s, state=%s)", async (compact, state) => {
  const fixture = await workflowRunFixture();
  const run = await fixture.handlers.launchTaskWorkflow(fixture.launch);
  if (state === "failed") {
    const request = fixture.requests[0];
    if (!request) throw new Error("The owned native workflow was not admitted");
    new TaskWorkflowStore(fixture.store).publish(run.id, { ...fixture.native, key: request.key, status: "failed", error: "Owned smoke failure after writer execution" });
  }
  fixture.withdraw();
  const slot = fixture.render(compact);
  fireEvent.click(await slot.findByRole("button", { name: "Workflow details" }));
  const dialog = await slot.findByRole("dialog", { name: "Workflow details" });
  await within(dialog).findByRole("region", { name: "Workflow run details" });
  expectRunDetails(dialog, fixture.native.phase);
  expect(new WorkflowPreparationStore(fixture.store).savedDraft(fixture.task.id)?.selection).toEqual(fixture.selection);
});

it.each([false, true])("a true Start rejection preserves the open setup and saved selections (compact=%s)", async compact => {
  const fixture = await workflowRunFixture();
  fixture.reject();
  const slot = fixture.render(compact);
  fireEvent.click(await slot.findByRole("button", { name: "Launch workflow" }));
  const dialog = await slot.findByRole("dialog", { name: "Launch workflow" });
  const start = await within(dialog).findByRole("button", { name: "Start workflow" });
  await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
  fireEvent.click(start);
  await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toContain("Owned Start rejected before admission"));
  expect(slot.getByRole("dialog", { name: "Launch workflow" })).toBe(dialog);
  expect(within(dialog).getByRole("group", { name: "Writer" }).hasAttribute("disabled")).toBe(false);
  expect((within(dialog).getByRole("textbox", { name: /Required platform smoke commands/ }) as HTMLTextAreaElement).value).toBe(fixture.selection.smokeCommands.join("\n"));
  expect(new WorkflowPreparationStore(fixture.store).savedDraft(fixture.task.id)?.selection).toEqual(fixture.selection);
  expect(fixture.store.database.prepare("SELECT id FROM task_workflow_runs WHERE task_id = ?").all(fixture.task.id)).toEqual([]);
  expect(fixture.requests).toEqual([]);
});

it("an older same-ID poll cannot undo an acknowledged Return revision", async () => {
  const fixture = await workflowRunFixture();
  const owner = fixture.reviewed();
  const slot = fixture.render(false);
  try {
    fireEvent.click(await slot.findByRole("button", { name: "Workflow details" }));
    const dialog = await slot.findByRole("dialog", { name: "Workflow details" });
    const details = await within(dialog).findByRole("region", { name: "Workflow run details" });
    await within(details).findByRole("button", { name: "Accept reviewed result" });
    fixture.holdSnapshot();
    await fixture.snapshotEntered;
    expect(fixture.snapshot()?.runs).toMatchObject([{ id: owner.request.group, revision: 1, state: "in_review" }]);
    fireEvent.change(within(details).getByRole("textbox", { name: "Human feedback" }), { target: { value: "Keep the retained writer and implement the review feedback" } });
    await act(async () => {
      fireEvent.click(within(details).getByRole("button", { name: "Return to same writer" }));
      await fixture.mutationAcknowledged;
    });
    expect(fixture.mutation()).toMatchObject({ id: owner.request.group, revision: 2, state: "running" });
    expect(owner.workflows.get(owner.request.group)).toMatchObject({ revision: 2, state: "running" });
    expectRunDetails(dialog, fixture.native.phase);
    expect(within(dialog).queryByRole("button", { name: "Accept reviewed result" })).toBeNull();
    await act(async () => { fixture.releaseSnapshot(); await fixture.snapshotReturned; });
    expect(within(dialog).getByRole("article").textContent).toMatch(/\brevision\s+2\b/);
    expectRunDetails(dialog, fixture.native.phase);
    expect(within(dialog).queryByRole("button", { name: "Accept reviewed result" })).toBeNull();
    expect(within(dialog).queryByRole("textbox", { name: "Human feedback" })).toBeNull();
    expect(owner.workflows.get(owner.request.group)).toMatchObject({ revision: 2, state: "running" });
  } finally {
    fixture.releaseSnapshot();
  }
});

it("an older same-revision poll cannot restore Accept after acknowledged acceptance", async () => {
  const fixture = await workflowRunFixture();
  const owner = fixture.reviewed();
  const slot = fixture.render(false);
  try {
    fireEvent.click(await slot.findByRole("button", { name: "Workflow details" }));
    const dialog = await slot.findByRole("dialog", { name: "Workflow details" });
    const details = await within(dialog).findByRole("region", { name: "Workflow run details" });
    const accept = await within(details).findByRole("button", { name: "Accept reviewed result" });
    fixture.holdSnapshot();
    await fixture.snapshotEntered;
    expect(fixture.snapshot()?.runs).toMatchObject([{ id: owner.request.group, revision: 1, state: "in_review" }]);
    await act(async () => { fireEvent.click(accept); await fixture.mutationAcknowledged; });
    expect(fixture.mutation()).toMatchObject({ id: owner.request.group, revision: 1, state: "accepted" });
    expect(owner.workflows.get(owner.request.group)).toMatchObject({ revision: 1, state: "accepted" });
    expect(within(dialog).queryByRole("button", { name: "Accept reviewed result" })).toBeNull();
    expect(within(dialog).queryByRole("textbox", { name: "Human feedback" })).toBeNull();
    await act(async () => { fixture.releaseSnapshot(); await fixture.snapshotReturned; });
    expect(within(dialog).getByRole("article").textContent).toMatch(/\brevision\s+1\b/);
    expect(within(dialog).queryByRole("button", { name: "Accept reviewed result" })).toBeNull();
    expect(within(dialog).queryByRole("textbox", { name: "Human feedback" })).toBeNull();
    expect(owner.workflows.get(owner.request.group)).toMatchObject({ revision: 1, state: "accepted" });
  } finally {
    fixture.releaseSnapshot();
  }
});

it("a poll begun after Return acknowledgement still admits current same-ID progress", async () => {
  const fixture = await workflowRunFixture();
  const owner = fixture.reviewed();
  const slot = fixture.render(false);
  try {
    fireEvent.click(await slot.findByRole("button", { name: "Workflow details" }));
    const dialog = await slot.findByRole("dialog", { name: "Workflow details" });
    const details = await within(dialog).findByRole("region", { name: "Workflow run details" });
    const feedback = await within(details).findByRole("textbox", { name: "Human feedback" });
    fireEvent.change(feedback, { target: { value: "Continue the retained writer with the requested correction" } });
    await act(async () => {
      fireEvent.click(within(details).getByRole("button", { name: "Return to same writer" }));
      await fixture.mutationAcknowledged;
    });
    expect(fixture.mutation()).toMatchObject({ id: owner.request.group, revision: 2, state: "running" });
    expectRunDetails(dialog, fixture.native.phase);
    fixture.advanceNativeReview();
    fixture.holdSnapshot();
    await fixture.snapshotEntered;
    expect(fixture.snapshot()?.runs).toMatchObject([{ id: owner.request.group, revision: 2, state: "running", native: { phase: fixture.native.phase } }]);
    await act(async () => { fixture.releaseSnapshot(); await fixture.snapshotReturned; });
    expectRunDetails(dialog, fixture.native.phase);
    expect(within(dialog).queryByRole("button", { name: "Accept reviewed result" })).toBeNull();
    expect(owner.workflows.get(owner.request.group)).toMatchObject({ revision: 2, state: "running", native: { phase: fixture.native.phase } });
  } finally {
    fixture.releaseSnapshot();
  }
});
