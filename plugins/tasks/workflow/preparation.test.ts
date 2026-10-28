import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createFakePluginHost, makeHostResponse, makeThreadResponse, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createStore } from "../api/index.js";
import { createWorkflowPreparation } from "./preparation.js";
import { registerTaskWorkflows } from "./index.js";
import type { WorkflowSelection } from "../shared/workflow-preparation.js";
import { TaskWorkflowStore } from "./store.js";
import type { BuildReviewStart } from "./remote-contract.js";

const hosts: FakePluginHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.dispose(); });
const selection: WorkflowSelection = {
  template: "development-review", hostId: "owned-host", baseBranch: "",
  writer: { provider: "acp-omp", model: "bb-cpa/personal-codex/gpt-6.1-sol", executionContextId: "personal", modelConnectionId: "personal-account", reasoningLevel: "high", permissionMode: "full", serviceTier: null, instructions: "Owned writer" },
  reviewer: { provider: "acp-omp", model: "bb-cpa/personal-codex/gpt-6.1-sol", executionContextId: "personal", modelConnectionId: "personal-account", reasoningLevel: "high", permissionMode: "full", serviceTier: null, instructions: "Independent reviewer" },
  smokeCommands: ["owned-smoke"], uiRequired: false,
};
function setup(launch = false) {
  let revoked = false;
  let loseResponse = false;
  let hideOwnership = false;
  let roots = 0;
  let nativeStarts = 0;
  let preparationContexts = 0;
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const metadata = new Map<string, NonNullable<Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0]["pluginMetadata"]>>();
  const host = createFakePluginHost({ pluginId: "tasks", sdk: {
    hosts: { list: async () => [makeHostResponse({ id: "owned-host" })] },
    experimental_executionContexts: { list: async () => [{ id: "personal", name: "Personal", enabled: true, projectIds: ["proj_code"] }] },
    experimental_modelConnections: { list: async () => [{ id: "personal-account", name: "Personal CPA", provider: "acp-omp", hostId: null, gateway: { allowedHostIds: ["owned-host"] }, enabled: true, revoked }] },
    providers: { models: async () => ({ models: [{ id: selection.writer!.model, model: selection.writer!.model, supportedReasoningEfforts: [{ reasoningEffort: "high" }] }], selectedOnlyModels: [], modelLoadError: null }) },
    environments: {
      get: async () => ({ id: "owned-environment", hostId: "owned-host", projectId: "proj_code", path: "/owned/workflow", status: "ready", lifecycle: { phase: "active" }, hostLifecycle: "active" }),
      status: async () => ({ outcome: "available", workspace: { checkout: { kind: "branch", branchName: "owned-branch", headSha: "a".repeat(40) }, workingTree: { hasUncommittedChanges: false } } }),
    },
    threads: {
      get: async ({ threadId }) => { const thread = threads.get(threadId); if (!thread) throw new Error("Unknown thread"); return thread; },
      list: async () => hideOwnership ? [] : [...threads.values()],
      getPluginMetadata: async ({ threadId }) => metadata.get(threadId),
      spawn: async args => {
        if (args.environment.type === "provider") roots++;
        const thread = makeThreadResponse({ id: `prepared-${++preparationContexts}`, projectId: "proj_code", environmentId: "owned-environment", originPluginId: "tasks" });
        threads.set(thread.id, thread);
        metadata.set(thread.id, args.pluginMetadata!);
        if (loseResponse) { loseResponse = false; throw new Error("Connection lost after native create"); }
        return thread;
      },
    },
    plugins: { callRpc: async args => {
      if (args.method === "startBuildReview") nativeStarts++;
      return { runId: "native-run", key: z.object({ key: z.string() }).parse(args.input).key, contextStarted: false, status: "queued", phase: null, error: null, result: null, workers: [], policyLimitations: [] };
    } },
  } });
  hosts.push(host);
  const store = createStore(host.bb);
  const project = store.tasks.createProject({ name: "Owned project", prefix: "OWN", color: "blue", linkedBbProjectId: "proj_code" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Owned native workflow" });
  const preparation = launch ? null : createWorkflowPreparation(host.bb, store);
  return { host, store, task, preparation, revoke: () => { revoked = true; }, restore: () => { revoked = false; }, loseResponse: () => { loseResponse = true; }, hideOwnership: () => { hideOwnership = true; }, revealOwnership: () => { hideOwnership = false; }, counts: () => ({ roots, nativeStarts, preparationContexts }) };
}

describe("native workflow preparation receipts", () => {
  it("reconciles a lost preparation response without creating another branch or losing draft choices", async () => {
    const fixture = setup();
    const { preparation, task } = fixture;
    const draft = preparation!.persistence.saveDraft(task.id, 0, selection);
    fixture.loseResponse();
    await preparation!.handlers.prepareTaskWorkflow({ taskId: task.id, revision: draft.revision });
    const interrupted = await preparation!.advance(task.id);
    expect(interrupted.state).toBe("uncertain");
    const recovered = await preparation!.advance(task.id);
    expect(recovered.state).toBe("ready");
    expect(recovered.environmentId).toBe("owned-environment");
    expect(fixture.counts()).toEqual({ roots: 1, nativeStarts: 0, preparationContexts: 2 });
    expect(preparation!.persistence.draft(task.id).selection).toEqual(selection);
    await preparation!.advance(task.id);
    expect(fixture.counts().roots).toBe(1);
  });
  it("does not let a draft edit bypass an uncertain native create and allocate a second branch", async () => {
    const fixture = setup();
    const { preparation, task } = fixture;
    const draft = preparation!.persistence.saveDraft(task.id, 0, selection);
    fixture.loseResponse();
    fixture.hideOwnership();
    await preparation!.handlers.prepareTaskWorkflow({ taskId: task.id, revision: draft.revision });
    expect((await preparation!.advance(task.id)).state).toBe("uncertain");
    const changed = preparation!.persistence.saveDraft(task.id, draft.revision, { ...selection, uiRequired: true });
    await expect(preparation!.handlers.prepareTaskWorkflow({ taskId: task.id, revision: changed.revision })).rejects.toThrow(/Reconcile/);
    expect(fixture.counts()).toEqual({ roots: 1, nativeStarts: 0, preparationContexts: 1 });
    preparation!.persistence.saveDraft(task.id, changed.revision, selection);
    fixture.revealOwnership();
    expect((await preparation!.advance(task.id)).state).toBe("ready");
    expect(fixture.counts().roots).toBe(1);
  });
  it("does not prepare a workspace for a revoked account and does not replace the payer", async () => {
    const fixture = setup();
    const { preparation, task } = fixture;
    const draft = preparation!.persistence.saveDraft(task.id, 0, selection);
    fixture.revoke();
    await expect(preparation!.handlers.prepareTaskWorkflow({ taskId: task.id, revision: draft.revision })).rejects.toThrow(/revoked/);
    expect(fixture.counts()).toEqual({ roots: 0, nativeStarts: 0, preparationContexts: 0 });
    expect(preparation!.persistence.draft(task.id).selection.writer?.modelConnectionId).toBe("personal-account");
    fixture.restore();
    await preparation!.handlers.prepareTaskWorkflow({ taskId: task.id, revision: draft.revision });
    expect((await preparation!.advance(task.id)).state).toBe("ready");
  });
  it("allows explicit pre-start verification changes while reusing the owned workspace", async () => {
    const fixture = setup();
    const { preparation, task } = fixture;
    const draft = preparation!.persistence.saveDraft(task.id, 0, selection);
    await preparation!.handlers.prepareTaskWorkflow({ taskId: task.id, revision: draft.revision });
    const first = await preparation!.advance(task.id);
    const changed = preparation!.persistence.saveDraft(task.id, draft.revision, { ...selection, uiRequired: true });
    await preparation!.handlers.prepareTaskWorkflow({ taskId: task.id, revision: changed.revision });
    const next = await preparation!.advance(task.id);
    expect(next.id).toBe(first.id);
    expect(next.environmentId).toBe(first.environmentId);
    expect(next.selection.uiRequired).toBe(true);
    expect(fixture.counts().roots).toBe(1);
  });
  it("retries explicit Start against one durable workflow receipt, without preparing or launching a replacement", async () => {
    const fixture = setup(true);
    const handlers = registerTaskWorkflows(fixture.host.bb, fixture.store, { background: false });
    const draft = await handlers.saveTaskWorkflowDraft({ taskId: fixture.task.id, revision: 0, selection });
    await handlers.prepareTaskWorkflow({ taskId: fixture.task.id, revision: draft.revision });
    let prepared = await handlers.getTaskWorkflowPreparation({ taskId: fixture.task.id });
    if (prepared?.state !== "ready") prepared = await handlers.getTaskWorkflowPreparation({ taskId: fixture.task.id });
    expect(prepared?.state).toBe("ready");
    fixture.revoke();
    await expect(handlers.launchTaskWorkflow({ taskId: fixture.task.id, preparationId: prepared!.id })).rejects.toThrow(/revoked/);
    expect(fixture.counts()).toEqual({ roots: 1, nativeStarts: 0, preparationContexts: 2 });
    expect(fixture.store.tasks.getTask(fixture.task.id)?.status).toBe(fixture.task.status);
    fixture.restore();
    const first = await handlers.launchTaskWorkflow({ taskId: fixture.task.id, preparationId: prepared!.id });
    const again = await handlers.launchTaskWorkflow({ taskId: fixture.task.id, preparationId: prepared!.id });
    expect(again.id).toBe(first.id);
    expect(fixture.counts()).toEqual({ roots: 1, nativeStarts: 1, preparationContexts: 2 });
    expect(fixture.store.tasks.getTask(fixture.task.id)?.status).toBe("in_progress");
    expect((await handlers.getTaskWorkflowDraft({ taskId: fixture.task.id })).selection).toEqual(selection);
  });
  it.each([
    ["preparation", false],
    ["preparation", true],
    ["final readiness", false],
    ["final readiness", true],
  ] as const)("fences Start after a concurrent draft revision during %s (restored choices: %s)", async (boundary, restoreChoices) => {
    const fixture = setup(true);
    const { host, store, task } = fixture;
    const handlers = registerTaskWorkflows(host.bb, store, { background: false });
    const draft = await handlers.saveTaskWorkflowDraft({ taskId: task.id, revision: 0, selection });
    await handlers.prepareTaskWorkflow({ taskId: task.id, revision: draft.revision });
    const prepared = await handlers.getTaskWorkflowPreparation({ taskId: task.id });
    expect(prepared?.state).toBe("ready");
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    let preparedStatusObserved = false;
    host.harness.sdk.stub("environments.status", async () => {
      preparedStatusObserved = true;
      return { outcome: "available", workspace: { checkout: { kind: "branch", branchName: "owned-branch", headSha: "a".repeat(40) }, workingTree: { hasUncommittedChanges: false } } };
    });
    host.harness.sdk.stub("providers.models", async () => {
      if (boundary === "preparation" || preparedStatusObserved) {
        enter();
        await released;
      }
      return { models: [{ id: selection.writer!.model, model: selection.writer!.model, supportedReasoningEfforts: [{ reasoningEffort: "high" }] }], selectedOnlyModels: [], modelLoadError: null };
    });
    const launch = Promise.resolve(
      handlers.launchTaskWorkflow({ taskId: task.id, preparationId: prepared!.id }),
    ).then(
      value => ({ value, error: null }),
      (error: unknown) => ({ value: null, error }),
    );
    let revision = draft.revision;
    const changed = { ...selection, smokeCommands: ["newly-selected-smoke"] };
    try {
      await entered;
      const saved = await handlers.saveTaskWorkflowDraft({ taskId: task.id, revision, selection: changed });
      revision = saved.revision;
      expect(saved.selection.smokeCommands).toEqual(["newly-selected-smoke"]);
      if (restoreChoices) revision = (await handlers.saveTaskWorkflowDraft({ taskId: task.id, revision, selection })).revision;
      expect(revision).toBeGreaterThan(draft.revision);
    } finally {
      release();
    }
    expect(await launch).toMatchObject({ value: null, error: expect.objectContaining({ message: expect.stringMatching(/draft|changed|stale/i) }) });
    expect(store.database.prepare("SELECT id FROM task_workflow_runs WHERE task_id = ?").all(task.id)).toEqual([]);
    expect(store.tasks.getTask(task.id)?.status).toBe(task.status);
    expect(fixture.counts()).toEqual({ roots: 1, nativeStarts: 0, preparationContexts: 2 });
    expect(await handlers.getTaskWorkflowDraft({ taskId: task.id })).toMatchObject({ revision, selection: restoreChoices ? selection : changed });
    await handlers.saveTaskWorkflowDraft({ taskId: task.id, revision, selection });
    const started = await handlers.launchTaskWorkflow({ taskId: task.id, preparationId: prepared!.id });
    expect((await handlers.launchTaskWorkflow({ taskId: task.id, preparationId: prepared!.id })).id).toBe(started.id);
    expect(fixture.counts()).toEqual({ roots: 1, nativeStarts: 1, preparationContexts: 2 });
    expect(store.tasks.getTask(task.id)?.status).toBe("in_progress");
  });
});

describe("legacy first-writer Return handlers", () => {
  const repair: WorkflowSelection = {
    ...selection,
    writer: { ...selection.writer!, model: "bb-cpa/personal-codex/repaired-model", executionContextId: "repair-context", modelConnectionId: "repair-account", instructions: "Explicit writer repair" },
    reviewer: { ...selection.reviewer!, executionContextId: "repair-context", modelConnectionId: "repair-account" },
    smokeCommands: ["current-project-smoke"],
  };
  function legacyFixture() {
    const fixture = setup(true);
    const { host, store, task } = fixture;
    const handlers = registerTaskWorkflows(host.bb, store, { background: false });
    const workflows = new TaskWorkflowStore(store);
    const original: BuildReviewStart = {
      key: "legacy-workflow:1", group: "legacy-workflow", projectId: "proj_code", originThreadId: "legacy-origin",
      task: task.title, template: "development-review", writer: selection.writer!, reviewer: selection.reviewer!,
      smokeCommands: selection.smokeCommands, uiRequired: selection.uiRequired, feedback: "",
    };
    const launch = JSON.stringify({ taskId: task.id, launchKey: "legacy-launch", originThreadId: original.originThreadId, writer: original.writer, reviewer: original.reviewer, smokeCommands: original.smokeCommands, uiRequired: original.uiRequired });
    workflows.create("legacy-launch", task.id, original, launch);
    workflows.publish(original.group, { runId: "legacy-native-run", key: original.key, contextStarted: false, status: "failed", phase: null, error: "Core rejected the first context before creating a worker", result: null, workers: [], policyLimitations: [] });
    host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "proj_code", environmentId: "owned-environment", status: "idle" }));
    host.harness.sdk.stub("experimental_executionContexts.list", async () => [
      { id: "personal", name: "Personal", enabled: true, projectIds: ["proj_code"] },
      { id: "repair-context", name: "Explicit repair", enabled: true, projectIds: ["proj_code"] },
    ]);
    host.harness.sdk.stub("experimental_modelConnections.list", async () => [
      { id: "personal-account", name: "Original CPA", provider: "acp-omp", hostId: null, gateway: { allowedHostIds: ["owned-host"] }, enabled: true, revoked: false },
      { id: "repair-account", name: "Repair CPA", provider: "acp-omp", hostId: null, gateway: { allowedHostIds: ["owned-host"] }, enabled: true, revoked: false },
    ]);
    host.harness.sdk.stub("providers.models", async () => ({ models: [selection.writer!.model, repair.writer!.model].map(model => ({ id: model, model, supportedReasoningEfforts: [{ reasoningEffort: "high" }] })), selectedOnlyModels: [], modelLoadError: null }));
    return { ...fixture, handlers, workflows, original, launch };
  }

  it.each([false, true])("preserves stored legacy selections without a new draft on first-writer Return (project settings: %s)", async projectSettings => {
    const fixture = legacyFixture();
    const { store, task, handlers, workflows, original, launch } = fixture;
    if (projectSettings) await handlers.saveProjectWorkflowSettings({ taskId: task.id, revision: 0, selection: repair });
    expect(store.database.prepare("SELECT task_id FROM task_workflow_drafts WHERE task_id = ?").all(task.id)).toEqual([]);
    const feedback = "Provider admission repaired; retry the original stored choices";
    const returned = await handlers.returnTaskWorkflow({ id: original.group, revision: 1, feedback });
    expect(returned).toMatchObject({ id: original.group, revision: 2, state: "running" });
    expect(workflows.request(original.group)).toEqual({ ...original, key: "legacy-workflow:2", feedback });
    expect(store.database.prepare("SELECT launch_json FROM task_workflow_runs WHERE id = ?").get(original.group)).toEqual({ launch_json: launch });
    expect(store.database.prepare("SELECT task_id FROM task_workflow_drafts WHERE task_id = ?").all(task.id)).toEqual([]);
    expect((await handlers.returnTaskWorkflow({ id: original.group, revision: 1, feedback })).revision).toBe(2);
    expect(fixture.counts()).toEqual({ roots: 0, nativeStarts: 1, preparationContexts: 0 });
    expect(store.tasks.getTask(task.id)?.status).toBe("in_progress");
  });

  it("applies an explicitly saved repair draft to a definitively rejected legacy first writer without replacing its workspace", async () => {
    const fixture = legacyFixture();
    const { handlers, task, workflows, original } = fixture;
    await handlers.saveProjectWorkflowSettings({ taskId: task.id, revision: 0, selection });
    await handlers.saveTaskWorkflowDraft({ taskId: task.id, revision: 0, selection: repair });
    const feedback = "Use the explicitly selected repaired account and model for the first context";
    expect(await handlers.returnTaskWorkflow({ id: original.group, revision: 1, feedback })).toMatchObject({ revision: 2, state: "running" });
    expect(workflows.request(original.group)).toEqual({ ...original, writer: repair.writer, reviewer: repair.reviewer, key: "legacy-workflow:2", feedback });
    expect(fixture.counts()).toEqual({ roots: 0, nativeStarts: 1, preparationContexts: 0 });
    expect(fixture.store.tasks.getTask(task.id)?.status).toBe("in_progress");
  });
  it.each([false, true])("fences first-writer Return after a concurrent repair draft save (restored choices: %s)", async restoreChoices => {
    const fixture = legacyFixture();
    const { host, handlers, store, task, workflows, original } = fixture;
    const saved = await handlers.saveTaskWorkflowDraft({ taskId: task.id, revision: 0, selection });
    const before = workflows.get(original.group);
    const taskStatus = store.tasks.getTask(task.id)?.status;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    host.harness.sdk.stub("providers.models", async () => {
      enter();
      await released;
      return { models: [selection.writer!.model, repair.writer!.model].map(model => ({ id: model, model, supportedReasoningEfforts: [{ reasoningEffort: "high" }] })), selectedOnlyModels: [], modelLoadError: null };
    });
    const input = { id: original.group, revision: before.revision, feedback: "Retry with my saved repair choices" };
    const returning = Promise.resolve(handlers.returnTaskWorkflow(input)).then(
      value => ({ value, error: null }),
      (error: unknown) => ({ value: null, error }),
    );
    let changed = saved;
    try {
      await entered;
      changed = await handlers.saveTaskWorkflowDraft({ taskId: task.id, revision: saved.revision, selection: repair });
      if (restoreChoices) changed = await handlers.saveTaskWorkflowDraft({ taskId: task.id, revision: changed.revision, selection });
    } finally {
      release();
    }
    const outcome = await returning;
    expect(workflows.get(original.group)).toMatchObject({ revision: before.revision, state: "failed" });
    expect(workflows.request(original.group)).toEqual(original);
    expect(store.tasks.getTask(task.id)?.status).toBe(taskStatus);
    expect(fixture.counts().nativeStarts).toBe(0);
    expect(outcome).toMatchObject({ value: null, error: expect.any(Error) });
    expect(await handlers.getTaskWorkflowDraft({ taskId: task.id })).toMatchObject({ revision: changed.revision, selection: restoreChoices ? selection : repair });
    const retried = await handlers.returnTaskWorkflow(input);
    expect(retried).toMatchObject({ revision: before.revision + 1, state: "running" });
    expect(workflows.request(original.group).writer).toEqual((restoreChoices ? selection : repair).writer);
    expect((await handlers.returnTaskWorkflow(input)).revision).toBe(retried.revision);
    expect(fixture.counts()).toEqual({ roots: 0, nativeStarts: 1, preparationContexts: 0 });
  });

  it("returns a retained writer without applying an unrelated incomplete repair draft", async () => {
    const { handlers, workflows, original, task } = legacyFixture();
    workflows.publish(original.group, { runId: "retained-native", key: original.key, contextStarted: true, status: "failed", phase: "Build", error: "Human feedback required", result: null, workers: [{ role: "writer", threadId: "retained-writer", callIndex: 1 }], policyLimitations: [] });
    await handlers.saveTaskWorkflowDraft({ taskId: task.id, revision: 0, selection: { ...selection, hostId: null, writer: null, reviewer: null } });
    const feedback = "Continue the same retained writer without changing its binding";
    expect(await handlers.returnTaskWorkflow({ id: original.group, revision: 1, feedback })).toMatchObject({ revision: 2, state: "running" });
    expect(workflows.request(original.group)).toEqual({ ...original, key: "legacy-workflow:2", feedback });
  });
});
