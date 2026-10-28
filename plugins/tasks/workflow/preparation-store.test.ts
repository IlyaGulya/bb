import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore } from "../api/index.js";
import { WorkflowPreparationStore } from "./preparation-store.js";
import { requireWorkflowSelection } from "./preparation.js";
import type { WorkflowSelection } from "../shared/workflow-preparation.js";

const hosts: FakePluginHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.dispose(); });
function setup() {
  const host = createFakePluginHost({ pluginId: "tasks" });
  hosts.push(host);
  const api = createStore(host.bb);
  const project = api.tasks.createProject({ name: "First project", prefix: "ONE", color: "blue" });
  const otherProject = api.tasks.createProject({ name: "Second project", prefix: "TWO", color: "blue" });
  const task = api.tasks.createTask({ projectId: project.id, title: "First task" });
  const sibling = api.tasks.createTask({ projectId: project.id, title: "Sibling task" });
  const foreign = api.tasks.createTask({ projectId: otherProject.id, title: "Foreign task" });
  return { api, task, sibling, foreign, drafts: new WorkflowPreparationStore(api) };
}
const selection: WorkflowSelection = {
  template: "development-review", hostId: "machine", baseBranch: "",
  writer: { provider: "acp-omp", model: "bb-cpa/personal-codex/gpt-6.1-sol", executionContextId: "personal", modelConnectionId: "personal-account", reasoningLevel: "high", permissionMode: "full", serviceTier: null, instructions: "Owned work only" },
  reviewer: { provider: "acp-omp", model: "bb-cpa/personal-codex/gpt-6.1-sol", executionContextId: "personal", modelConnectionId: "personal-account", reasoningLevel: "high", permissionMode: "full", serviceTier: null, instructions: "Independent review only" },
  smokeCommands: ["repository-smoke"], uiRequired: false,
};

describe("server-owned workflow drafts", () => {
  it("retains incomplete choices across clients without leaking between tasks or projects", () => {
    const { api, task, sibling, foreign, drafts } = setup();
    const partial = { ...selection, writer: { ...selection.writer!, model: "", modelConnectionId: "" } };
    drafts.saveDraft(task.id, 0, partial);
    const reopened = new WorkflowPreparationStore(api);
    expect(reopened.draft(task.id).selection).toEqual(partial);
    expect(reopened.draft(sibling.id).selection.writer).toBeNull();
    expect(reopened.draft(foreign.id).selection.writer).toBeNull();
  });
  it("rejects a conflicting stale save without discarding the current draft and reconciles uncertain delivery once", () => {
    const { drafts, task } = setup();
    const saved = drafts.saveDraft(task.id, 0, selection);
    expect(drafts.saveDraft(task.id, 0, selection)).toEqual(saved);
    expect(() => drafts.saveDraft(task.id, 0, { ...selection, uiRequired: true })).toThrow(/another session/);
    expect(drafts.draft(task.id)).toEqual(saved);
    const changed = drafts.saveDraft(task.id, saved.revision, { ...selection, uiRequired: true });
    expect(changed.selection.writer).toEqual(selection.writer);
    expect(changed.selection.smokeCommands).toEqual(selection.smokeCommands);
  });
  it("applies project/template settings only through explicit saves without rewriting existing drafts", () => {
    const { drafts, task, sibling, foreign } = setup();
    drafts.saveDraft(task.id, 0, { ...selection, smokeCommands: ["task-specific-smoke"] });
    expect(drafts.settings(sibling.id, "development-review").selection).toBeNull();
    drafts.saveSettings(task.id, 0, selection);
    expect(drafts.draft(task.id).selection.smokeCommands).toEqual(["task-specific-smoke"]);
    expect(drafts.draft(sibling.id).selection.smokeCommands).toEqual(["repository-smoke"]);
    expect(drafts.settings(sibling.id, "bugfix").selection).toBeNull();
    expect(drafts.settings(foreign.id, "development-review").selection).toBeNull();
    expect(() => drafts.saveSettings(task.id, 0, { ...selection, uiRequired: true })).toThrow(/another session/);
    expect(drafts.settings(task.id, "development-review").selection).toEqual(selection);
  });
  it("keeps the same preparation and workspace reservation after restart or duplicate prepare", () => {
    const { api, drafts, task } = setup();
    const reserved = drafts.reserve(task.id, "code-project", selection);
    drafts.savePreparation({ ...reserved, threadId: "prepared-context", environmentId: "owned-environment", state: "preparing" });
    const reopened = new WorkflowPreparationStore(api);
    const repeated = reopened.reserve(task.id, "code-project", { ...selection, uiRequired: true });
    expect(repeated.id).toBe(reserved.id);
    expect(repeated.threadId).toBe("prepared-context");
    expect(repeated.environmentId).toBe("owned-environment");
    expect(repeated.selection).toEqual(selection);
  });
  it("refuses unbound payer selection and missing real smoke configuration", () => {
    expect(() => requireWorkflowSelection({ ...selection, writer: { ...selection.writer!, modelConnectionId: "" } })).toThrow(/explicitly select/);
    expect(() => requireWorkflowSelection({ ...selection, smokeCommands: [] })).toThrow(/Checks/);
  });
});
