// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeTask } from "../../test-fixtures.js";
import type { RepositoryCheckpoint } from "../../shared/repositories";

if (!window.matchMedia)
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
const app = await loadPluginApp(() => import("../../app"));
afterEach(cleanup);
const task = makeTask({
  id: "01HZZZZZZZZZZZZZZZZZZZZZT5",
  projectId: "01HZZZZZZZZZZZZZZZZZZZZZP1",
  number: 5,
  key: "TSK-5",
  title: "Coherent repository task",
  position: 1,
});
function checkpoint(required: boolean): RepositoryCheckpoint {
  return {
    id: "repositories-ui",
    taskId: task.id,
    state: "partial",
    createdAt: "2026-10-23T00:00:00.000Z",
    updatedAt: "2026-10-23T00:00:00.000Z",
    roots: ["android", "actions"].map((name, index) => ({
      binding: {
        id: name,
        bbProjectId: `proj_${name}`,
        role: name,
        owner: `owner-${name}`,
        required: index === 0 || required,
        sourceEnvironmentId: `env_source_${name}`,
        sourceHostId: "host_source",
        sourcePath: `/source/${name}`,
        sourceBranch: "main",
        sourceHead: "a".repeat(40),
        targetHostId: "host_target",
        targetPath: `/target/${name}`,
        branch: `bb/task-${name}`,
        presetId: "01HZZZZZZZZZZZZZZZZZZZZZR1",
        instructions: `Scope for ${name}`,
        instructionPaths: ["AGENTS.md"],
        includePaths: [],
      },
      state: index === 0 ? "ready" : "failed",
      transferOperationId: index === 0 ? "transfer_android" : null,
      environmentId: index === 0 ? "env_target_android" : null,
      threadId: null,
      head: index === 0 ? "a".repeat(40) : null,
      handoff: `Source ${name} remains unchanged`,
      error: index === 0 ? null : "Actions target unavailable",
      attempts: [],
    })),
  };
}
function renderRepositories(
  receipt: RepositoryCheckpoint,
  continueTaskRepositories = vi.fn(async (_input: unknown) => receipt),
) {
  return {
    continueTaskRepositories,
    slot: renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        openUrl: () => true,
        rpc: {
          listProjects: () => ({
            projects: [
              {
                id: task.projectId,
                name: "Repository tasks",
                prefix: "TSK",
                nextTaskNumber: 6,
                color: "blue",
                folderId: null,
                linkedBbProjectId: null,
                createdAt: receipt.createdAt,
              },
            ],
          }),
          listFolders: () => ({ folders: [] }),
          listPresets: () => ({ presets: [] }),
          sidebarSummary: () => ({ projects: [] }),
          getTaskByKey: () => ({ task }),
          listTasks: () => ({ tasks: [] }),
          listLabels: () => ({ labels: [] }),
          listAttachments: () => ({ attachments: [] }),
          listTaskThreads: () => ({ taskThreads: [] }),
          listTaskPullRequests: () => ({
            pullRequests: [],
            unavailableThreadIds: [],
          }),
          listComments: () => ({ comments: [] }),
          listBbProjects: () => ({ bbProjects: [] }),
          listMachines: () => ({ machines: [{ id: "host_source", name: "Source laptop" }, { id: "host_target", name: "Target worker" }] }),
          getTaskExecution: () => ({
            override: null,
            resolved: null,
            inherited: true,
            summary: "No code project configured",
          }),
          getTaskContinuations: () => ({ continuations: [] }),
          getTaskRepositories: () => ({ checkpoints: [receipt] }),
          continueTaskRepositories,
        },
      },
    ),
  };
}
describe("multi-repository task preparation surface", () => {
  it("shows each source, target and failure and blocks all continuation while a required root failed", async () => {
    const { slot, continueTaskRepositories } = renderRepositories(
      checkpoint(true),
    );
    const button = await slot.findByRole("button", {
      name: "Continue verified repositories",
    });
    expect(button).toHaveProperty("disabled", true);
    expect(slot.getByText("Actions target unavailable")).toBeTruthy();
    expect(await slot.findByText(/Source laptop:\/source\/android/u)).toBeTruthy();
    expect(slot.getByText(/Target worker:\/target\/actions/u)).toBeTruthy();
    fireEvent.click(button);
    expect(continueTaskRepositories).not.toHaveBeenCalled();
  });
  it("starts one aggregate continuation with an explicitly optional unavailable root and presents its failure", async () => {
    const receipt = checkpoint(false);
    const { slot, continueTaskRepositories } = renderRepositories(receipt);
    const button = await slot.findByRole("button", {
      name: "Continue verified repositories",
    });
    expect(button).toHaveProperty("disabled", false);
    fireEvent.click(button);
    await waitFor(() =>
      expect(continueTaskRepositories).toHaveBeenCalledOnce(),
    );
    expect(continueTaskRepositories.mock.calls[0]?.[0]).toEqual({
      taskId: task.id,
      checkpointId: receipt.id,
    });
    expect(slot.getByText("Actions target unavailable")).toBeTruthy();
  });
  it("renders the same native writer across every bound folder", async () => {
    const receipt = checkpoint(true);
    receipt.state = "started";
    for (const root of receipt.roots) {
      root.state = "started";
      root.threadId = "thr_coherent_writer";
      root.error = null;
    }
    const { slot } = renderRepositories(receipt);
    const actions = await slot.findAllByRole("button", { name: "Open repository writer" });
    fireEvent.click(actions[1]!);
    expect(slot.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr_coherent_writer" });
  });
});
