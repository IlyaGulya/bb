import { describe, expect, it } from "vitest";
import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import { createStore } from "../api/index.js";
import { workflowDraftSchema } from "../shared/workflow-preparation.js";

function output(result: { exitCode: number; stdout: string; stderr: string }) {
  expect(result, result.stderr).toMatchObject({ exitCode: 0, stderr: "" });
  return JSON.parse(result.stdout);
}
describe("named workflow CLI choices", () => {
  it("persists same-model/account task choices and changes project settings only through explicit commands", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks", sdk: {
      hosts: { list: async () => [makeHostResponse({ id: "execution-host", name: "Execution machine" })] },
      experimental_executionContexts: { list: async () => [{ id: "personal-context", name: "Personal" }] },
      experimental_modelConnections: { list: async () => [{ id: "personal-account", name: "Personal CPA", provider: "acp-omp" }] },
      providers: { models: async () => ({ models: [{ id: "bb-cpa/personal-codex/gpt-6.1-sol", model: "bb-cpa/personal-codex/gpt-6.1-sol", displayName: "Sol6.1" }], selectedOnlyModels: [], modelLoadError: null }) },
    } });
    await plugin(bb);
    try {
      const store = createStore(bb);
      const project = store.tasks.createProject({ name: "Owned", prefix: "OWN", color: "blue", linkedBbProjectId: "proj_code" });
      const other = store.tasks.createProject({ name: "Other", prefix: "OTHER", color: "blue" });
      const task = store.tasks.createTask({ projectId: project.id, title: "Native workflow" });
      const sibling = store.tasks.createTask({ projectId: project.id, title: "Sibling" });
      const foreign = store.tasks.createTask({ projectId: other.id, title: "Foreign" });
      store.tasks.createPreset({ name: "Personal OMP Sol6.1", providerId: "acp-omp", modelId: "bb-cpa/personal-codex/gpt-6.1-sol", executionContextId: "personal-context", modelConnectionId: "personal-account", reasoningLevel: "high", permissionMode: "full", serviceTier: null, environmentKind: "new-worktree", baseBranch: null, machineId: "execution-host", instructions: "Owned role work" });
      const presets = store.tasks.listPresets();
      const saved = workflowDraftSchema.parse(output(await harness.runCli([
        "workflow", "draft", "set", task.key, "--machine", "Execution machine",
        "--writer-model", "Sol6.1", "--reviewer-model", "Sol6.1",
        "--writer-reasoning", "high", "--reviewer-reasoning", "high",
        "--writer-permission", "full", "--reviewer-permission", "full",
        "--writer-context", "Personal", "--reviewer-context", "Personal",
        "--writer-account", "Personal CPA", "--reviewer-account", "Personal CPA",
        "--checks", '["owned-smoke"]', "--json",
      ])));
      expect(saved.selection.writer?.model).toBe("bb-cpa/personal-codex/gpt-6.1-sol");
      expect(saved.selection.reviewer?.model).toBe(saved.selection.writer?.model);
      expect(saved.selection.reviewer?.modelConnectionId).toBe("personal-account");
      expect(workflowDraftSchema.parse(output(await harness.runCli(["workflow", "draft", "show", sibling.key, "--json"]))).selection.writer).toBeNull();
      output(await harness.runCli(["workflow", "settings", "save", task.key, "--json"]));
      output(await harness.runCli(["workflow", "settings", "apply", sibling.key, "--json"]));
      output(await harness.runCli(["workflow", "draft", "set", task.key, "--checks", '["task-specific-smoke"]', "--json"]));
      expect(workflowDraftSchema.parse(output(await harness.runCli(["workflow", "draft", "show", task.key, "--json"]))).selection.smokeCommands).toEqual(["task-specific-smoke"]);
      expect(workflowDraftSchema.parse(output(await harness.runCli(["workflow", "draft", "show", sibling.key, "--json"]))).selection.smokeCommands).toEqual(["owned-smoke"]);
      expect(workflowDraftSchema.parse(output(await harness.runCli(["workflow", "draft", "show", foreign.key, "--json"]))).selection.writer).toBeNull();
      expect(store.tasks.listPresets()).toEqual(presets);
      expect(harness.sdk.callsTo("threads.spawn")).toEqual([]);
    } finally { await harness.dispose(); }
  });
});
