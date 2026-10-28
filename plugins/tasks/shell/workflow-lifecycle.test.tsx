// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { createFakePluginHost, type FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { CompactViewportOverrideProvider } from "@/components/ui/hooks/use-compact-viewport";
import plugin from "../server.js";
import { createStore } from "../api/index.js";
import { WorkflowPreparationStore } from "../workflow/preparation-store.js";

const app = await loadPluginApp(() => import("../app.js"));
const Panel = app.navPanels[0]!.component;
const harnesses: FakePluginHarness[] = [];

afterEach(async () => {
  cleanup();
  await Promise.all(harnesses.splice(0).map(harness => harness.dispose()));
});

function TasksLifecycleSurface({ compact, ...props }: PluginNavPanelProps & { compact: boolean }) {
  return <StrictMode><CompactViewportOverrideProvider isCompactViewport={compact}><Panel {...props} /></CompactViewportOverrideProvider></StrictMode>;
}

describe.each([false, true])("registered Tasks workflow lifecycle (compact=%s)", compact => {
  it("retains the live launcher, draft and portal across detail queries, refresh, reconnect and dismissal", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks", sdk: {
      hosts: { list: async () => [] },
      projects: { list: async () => [] },
    } });
    harnesses.push(harness);
    await plugin(bb);
    const store = createStore(bb);
    const project = store.tasks.createProject({ name: "Lifecycle tracker", prefix: "LIFE", color: "blue" });
    const task = store.tasks.createTask({ projectId: project.id, title: "Lifecycle task" });
    const drafts = new WorkflowPreparationStore(store);
    const rpc = Object.fromEntries(harness.registrations.rpcMethods.map(method => [
      method,
      (input: unknown) => harness.callRpc(method, input),
    ]));
    const slot = renderSlot({ component: TasksLifecycleSurface }, { compact, subPath: `task/${task.key}` }, {
      rpc,
      sdk: {
        experimental_executionContexts: { list: async () => [] },
        experimental_modelConnections: { list: async () => [] },
      },
    });
    const trigger = await slot.findByRole("button", { name: "Launch workflow" });
    trigger.focus();
    fireEvent.click(trigger);
    const panel = await slot.findByRole("dialog", { name: "Launch workflow" });
    const checks = await within(panel).findByRole("textbox", { name: /Required platform smoke commands/ });
    fireEvent.change(checks, { target: { value: "node smoke.mjs" } });
    await waitFor(() => expect(drafts.draft(task.id).selection.smokeCommands).toEqual(["node smoke.mjs"]));

    store.tasks.updateProject(project.id, { name: "Refreshed tracker" });
    await slot.behavior.emitRealtime("projects:changed", { projectId: project.id });
    await slot.findByRole("button", { name: "Refreshed tracker" });
    expect(slot.getByRole("button", { name: "Launch workflow" })).toBe(trigger);
    expect(slot.getByRole("dialog", { name: "Launch workflow" })).toBe(panel);
    expect(slot.container.querySelectorAll('section[aria-label="Task workflow"]')).toHaveLength(1);

    await slot.behavior.setRealtimeConnectionState("reconnecting");
    store.tasks.updateTask(task.id, { title: "Reconnected task" });
    await slot.behavior.setRealtimeConnectionState("connected");
    await waitFor(() => expect(slot.getByRole("textbox", { name: "Task title" }).textContent).toBe("Reconnected task"));
    expect(slot.getByRole("button", { name: "Launch workflow" })).toBe(trigger);
    expect(slot.getByRole("dialog", { name: "Launch workflow" })).toBe(panel);
    expect((checks as HTMLTextAreaElement).value).toBe("node smoke.mjs");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(slot.queryByRole("dialog", { name: "Launch workflow" })).toBeNull());
    expect(panel.isConnected).toBe(true);
    expect(panel.getAttribute("aria-hidden")).toBe("true");
    expect(panel.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    expect(await slot.findByRole("dialog", { name: "Launch workflow" })).toBe(panel);
    fireEvent.click(within(panel).getByRole("button", { name: "Close", exact: true }));
    await waitFor(() => expect(slot.queryByRole("dialog", { name: "Launch workflow" })).toBeNull());
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    expect(await slot.findByRole("dialog", { name: "Launch workflow" })).toBe(panel);
    const backdrop = document.querySelector<HTMLElement>('[data-persistent-drawer-backdrop][data-state="open"]')!;
    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);
    await waitFor(() => expect(slot.queryByRole("dialog", { name: "Launch workflow" })).toBeNull());
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(slot.getByRole("button", { name: "Refresh tasks" }));
    await waitFor(() => expect(slot.getByRole("button", { name: "Refresh tasks" }).hasAttribute("disabled")).toBe(false));
    expect(slot.getByRole("button", { name: "Launch workflow" })).toBe(trigger);
    slot.lifecycle.rerender(<TasksLifecycleSurface compact={compact} subPath={`task/${task.key}`} />);
    expect(slot.container.querySelectorAll('section[aria-label="Task workflow"]')).toHaveLength(1);

    expect(slot.rpcCalls.filter(call => ["prepareTaskWorkflow", "launchTaskWorkflow", "acceptTaskWorkflow"].includes(call.method))).toEqual([]);
    await act(async () => slot.lifecycle.unmount());
    expect(panel.isConnected).toBe(false);
  });
});
