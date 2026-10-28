// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createStore } from "../../api/index.js";
import { WorkflowPreparationStore } from "../../workflow/preparation-store.js";
import { workflowSetupContract } from "../../shared/workflow-preparation.js";
import { TasksRefreshProvider } from "../../shell/refresh.js";
import { TaskWorkflowPanel } from "./workflow.js";

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
