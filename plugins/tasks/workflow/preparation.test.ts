import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createFakePluginHost, makeHostResponse, makeThreadResponse, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createStore } from "../api/index.js";
import { createWorkflowPreparation } from "./preparation.js";
import { registerTaskWorkflows } from "./index.js";
import type { WorkflowSelection } from "../shared/workflow-preparation.js";

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
});
