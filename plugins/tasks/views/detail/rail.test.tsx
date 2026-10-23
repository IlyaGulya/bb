// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import { makeTask } from "../../test-fixtures.js";
import type { Preset } from "../../shared/contract.js";
import type { ExecutionTarget } from "../../shared/execution.js";

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

installTestPluginRuntime();
const { PropertiesRail } = await import("./rail");
const { TasksRefreshProvider } = await import("../../shell/refresh");

function RailHarness(props: ComponentProps<typeof PropertiesRail>) {
  return (
    <TasksRefreshProvider>
      <PropertiesRail {...props} />
    </TasksRefreshProvider>
  );
}

afterEach(cleanup);

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const BB_PROJECT_ID = "proj_bb0000000000000000000001";

function projectRow(linkedBbProjectId: string | null) {
  return {
    id: PROJECT_ID,
    name: "Tasks Plugin",
    prefix: "TSK",
    nextTaskNumber: 6,
    color: "blue",
    folderId: null,
    linkedBbProjectId,
    createdAt: "2026-07-15T00:00:00.000Z",
  };
}

const task = makeTask({
  id: "01HZZZZZZZZZZZZZZZZZZZZZT5",
  projectId: PROJECT_ID,
  number: 5,
  key: "TSK-5",
  title: "Ship the rail",
  position: 1,
});

const HOME_PROJECT = {
  ...projectRow(null),
  id: "01HZZZZZZZZZZZZZZZZZZZZZP2",
  name: "Home",
  prefix: "HOME",
  color: "purple",
};
const PROFILE: Preset = {
  id: "01HZZZZZZZZZZZZZZZZZZZZZS1",
  name: "Code profile",
  providerId: "codex",
  modelId: "gpt-5",
  reasoningLevel: "medium",
  serviceTier: null,
  permissionMode: "auto",
  environmentKind: "project-default",
  baseBranch: null,
  machineId: null,
  instructions: "",
  builtin: false,
  createdAt: "2026-07-15T00:00:00.000Z",
};
const TARGET: ExecutionTarget = {
  bbProjectId: BB_PROJECT_ID,
  hostId: "host_target",
  workspace: { kind: "project-checkout" },
  presetId: PROFILE.id,
};
const EXECUTION = { override: TARGET, resolved: TARGET, inherited: false, summary: "bb monorepo · Target machine · Project checkout · Code profile" };

function railProps(
  linkedBbProjectId: string | null,
  onMoveToProject: (projectId: string) => void = () => {},
) {
  const project = projectRow(linkedBbProjectId);
  return {
    task,
    project,
    projects: [project, HOME_PROJECT],
    labels: [],
    threads: [],
    presets: [],
    onUpdate: () => {},
    onMoveToProject,
    onError: () => {},
  };
}

describe("project rail control", () => {
  it("moves the task only when a different project is picked", async () => {
    const moves: string[] = [];
    const slot = renderSlot(
      { component: RailHarness },
      railProps(null, (projectId) => moves.push(projectId)),
      { rpc: { listBbProjects: () => ({ bbProjects: [] }) } },
    );
    fireEvent.click(slot.getByRole("button", { name: "Move to project" }));
    fireEvent.click(await slot.findByRole("option", { name: /Tasks Plugin/ }));
    expect(moves).toEqual([]);

    fireEvent.click(slot.getByRole("button", { name: "Move to project" }));
    fireEvent.click(await slot.findByRole("option", { name: /Home/ }));
    expect(moves).toEqual([HOME_PROJECT.id]);
  });
});

describe("task execution rail control", () => {

  it("keeps routing errors visible in the editor", async () => {
    const slot = renderSlot({ component: RailHarness }, { ...railProps(null), presets: [PROFILE], execution: EXECUTION }, {
      rpc: {
        listBbProjects: () => ({ bbProjects: [{ id: BB_PROJECT_ID, name: "bb monorepo" }] }),
        listMachines: () => ({ machines: [{ id: "host_target", name: "Target machine" }] }),
        setTaskExecution: () => { throw new Error("Target provider unavailable"); },
      },
    });
    fireEvent.click(slot.getByRole("button", { name: "Configure task execution" }));
    fireEvent.click(await slot.findByRole("button", { name: "Save execution target" }));
    expect(await slot.findByRole("alert")).toHaveProperty("textContent", "Target provider unavailable");
    expect(slot.getByRole("combobox", { name: "Code project" })).toBeTruthy();
  });
});

describe("task workspace execution modes", () => {
  it.each([
    { kind: "managed-worktree", baseBranch: "release" },
    { kind: "project-checkout" },
  ] as const)("saves $kind without changing the existing profile", async (workspace) => {
    const slot = renderSlot({ component: RailHarness }, { ...railProps(null), presets: [PROFILE], execution: EXECUTION }, {
      rpc: {
        listBbProjects: () => ({ bbProjects: [{ id: BB_PROJECT_ID, name: "bb monorepo" }] }),
        listMachines: () => ({ machines: [{ id: "host_target", name: "Target machine" }] }),
        setTaskExecution: () => EXECUTION,
      },
    });
    fireEvent.click(slot.getByRole("button", { name: "Configure task execution" }));
    fireEvent.change(await slot.findByRole("combobox", { name: "Workspace" }), { target: { value: workspace.kind } });
    if (workspace.kind === "managed-worktree") {
      fireEvent.change(slot.getByRole("textbox", { name: "Base branch (optional)" }), { target: { value: workspace.baseBranch } });
    }
    fireEvent.click(slot.getByRole("button", { name: "Save execution target" }));
    await waitFor(() => expect(slot.rpcCalls).toContainEqual({ method: "setTaskExecution", input: { taskId: task.id, target: { ...TARGET, workspace } } }));
  });
});
