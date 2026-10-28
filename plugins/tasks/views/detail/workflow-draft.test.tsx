// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore } from "../../api/index.js";
import { WorkflowPreparationStore } from "../../workflow/preparation-store.js";
import { workflowSetupContract } from "../../shared/workflow-preparation.js";
import { useWorkflowDraft } from "./workflow-draft.js";

const runtime = vi.hoisted(() => ({ rpc: { call: vi.fn() } }));
vi.mock("@get-bb/plugin-sdk/app", () => ({ useRpc: () => runtime.rpc }));
const hosts: FakePluginHost[] = [];
afterEach(async () => { cleanup(); for (const host of hosts.splice(0)) await host.harness.dispose(); });
function fixture() {
  const host = createFakePluginHost({ pluginId: "tasks" });
  hosts.push(host);
  const api = createStore(host.bb);
  const project = api.tasks.createProject({ name: "Draft project", prefix: "DR", color: "blue" });
  const task = api.tasks.createTask({ projectId: project.id, title: "Draft owner" });
  const sibling = api.tasks.createTask({ projectId: project.id, title: "Other task" });
  const store = new WorkflowPreparationStore(api);
  return { task, sibling, store };
}

describe("workflow draft persistence across client lifecycle", () => {
  it("serializes in-flight edits and reopens the final saved choices without affecting another task", async () => {
    const { task, sibling, store } = fixture();
    let release: (() => void) | undefined;
    let firstSave = true;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    runtime.rpc.call.mockImplementation(async (method: string, input: unknown) => {
      if (method === "getTaskWorkflowDraft") return store.draft(workflowSetupContract.getTaskWorkflowDraft.input.parse(input).taskId);
      const parsed = workflowSetupContract.saveTaskWorkflowDraft.input.parse(input);
      if (firstSave) { firstSave = false; await blocked; }
      return store.saveDraft(parsed.taskId, parsed.revision, parsed.selection);
    });
    const client = renderHook(() => useWorkflowDraft(task.id));
    await waitFor(() => expect(client.result.current.draft?.taskId).toBe(task.id));
    const original = client.result.current.draft!.selection;
    const first = { ...original, hostId: "chosen-machine", smokeCommands: ["real-smoke"] };
    const final = { ...first, uiRequired: true };
    act(() => { client.result.current.change(first); client.result.current.change(final); });
    await act(async () => { release!(); await client.result.current.flush(); });
    client.unmount();
    const reopened = renderHook(() => useWorkflowDraft(task.id));
    await waitFor(() => expect(reopened.result.current.draft?.selection).toEqual(final));
    expect(store.draft(sibling.id).selection.hostId).toBeNull();
  });
  it("keeps local choices after an uncertain save and stale retry until explicit reconciliation", async () => {
    const { task, store } = fixture();
    let loseAcknowledgement = true;
    runtime.rpc.call.mockImplementation(async (method: string, input: unknown) => {
      if (method === "getTaskWorkflowDraft") return store.draft(workflowSetupContract.getTaskWorkflowDraft.input.parse(input).taskId);
      const parsed = workflowSetupContract.saveTaskWorkflowDraft.input.parse(input);
      const saved = store.saveDraft(parsed.taskId, parsed.revision, parsed.selection);
      if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error("Save acknowledgement lost"); }
      return saved;
    });
    const client = renderHook(() => useWorkflowDraft(task.id));
    await waitFor(() => expect(client.result.current.draft?.taskId).toBe(task.id));
    const chosen = { ...client.result.current.draft!.selection, hostId: "owned-machine", smokeCommands: ["owned-smoke"] };
    act(() => client.result.current.change(chosen));
    await waitFor(() => expect(client.result.current.error).toBe("Save acknowledgement lost"));
    const changed = { ...chosen, uiRequired: true };
    act(() => client.result.current.change(changed));
    await act(async () => { await client.result.current.retry(); });
    expect(client.result.current.error).toMatch(/another session/);
    expect(client.result.current.draft?.selection).toEqual(changed);
    expect(store.draft(task.id).selection).toEqual(chosen);
    await act(async () => { await client.result.current.keepLocalChoices(); });
    expect(client.result.current.error).toBeNull();
    expect(store.draft(task.id).selection).toEqual(changed);
  });
});
