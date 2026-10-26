// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeTask, rpcInput } from "../../test-fixtures.js";

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

const app = await loadPluginApp(() => import("../../app"));

afterEach(cleanup);

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const TASK_ID = "01HZZZZZZZZZZZZZZZZZZZZZT5";
const THREAD_ROW_ID = "01HZZZZZZZZZZZZZZZZZZZZZR1";
const OFFLINE_ROW_ID = "01HZZZZZZZZZZZZZZZZZZZZZR2";

const task = makeTask({
  id: TASK_ID,
  projectId: PROJECT_ID,
  number: 5,
  key: "TSK-5",
  title: "Ship the PR pill",
  position: 1,
});

function taskThreadRow(id: string, threadId: string, title: string) {
  return {
    id,
    taskId: TASK_ID,
    threadId,
    presetName: "Attached",
    title,
    liveStatus: "working",
    attachedAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  };
}

function detailRpc(overrides: Record<string, unknown> = {}) {
  return {
    listProjects: () => ({
      projects: [
        {
          id: PROJECT_ID,
          name: "Tasks Plugin",
          prefix: "TSK",
          nextTaskNumber: 6,
          color: "blue",
          folderId: null,
          linkedBbProjectId: null,
          createdAt: "2026-07-15T00:00:00.000Z",
        },
      ],
    }),
    listFolders: () => ({ folders: [] }),
    listPresets: () => ({ presets: [] }),
    sidebarSummary: () => ({ projects: [] }),
    getTaskByKey: () => ({ task }),
    listTasks: (input: unknown) =>
      input !== null && rpcInput(input).parentTaskId
        ? { tasks: [] }
        : { tasks: [task] },
    listLabels: () => ({ labels: [] }),
    listAttachments: () => ({ attachments: [] }),
    listTaskThreads: () => ({
      taskThreads: [taskThreadRow(THREAD_ROW_ID, "thr_worker000", "Worker")],
    }),
    listTaskPullRequests: () => ({
      pullRequests: [],
      unavailableThreadIds: [],
    }),
    listComments: () => ({ comments: [] }),
    listBbProjects: () => ({ bbProjects: [] }),
    listMachines: () => ({ machines: [] }),
    getTaskExecution: () => ({
      override: null,
      resolved: null,
      inherited: true,
      summary: "No code project configured",
    }),
    getTaskContinuations: () => ({ continuations: [] }),
    ...overrides,
  };
}

describe("task detail pull request pills", () => {
  it("links a thread's pull request as a keyboard-reachable anchor", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        openUrl: () => true,
        rpc: detailRpc({
          listTaskPullRequests: () => ({
            pullRequests: [
              {
                url: "https://github.com/acme/bb/pull/12",
                number: 12,
                title: "Ship the PR pill",
                state: "merged",
                updatedAt: "2026-07-16T10:00:00.000Z",
                threadIds: ["thr_worker000"],
              },
            ],
            unavailableThreadIds: [],
          }),
        }),
      },
    );

    const link = (await slot.findByRole("link", {
      name: "Pull request #12: Ship the PR pill (Merged)",
    })) as HTMLAnchorElement;
    expect(link.href).toBe("https://github.com/acme/bb/pull/12");
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
    expect(link.textContent).toContain("#12");
    fireEvent.click(link);
    expect(slot.navigateCalls).toEqual([]);
  });

  it("marks threads whose PR lookup failed and stays quiet otherwise", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: detailRpc({
          listTaskThreads: () => ({
            taskThreads: [
              taskThreadRow(THREAD_ROW_ID, "thr_worker000", "Worker"),
              taskThreadRow(OFFLINE_ROW_ID, "thr_offline00", "Offline worker"),
            ],
          }),
          listTaskPullRequests: () => ({
            pullRequests: [],
            unavailableThreadIds: ["thr_offline00"],
          }),
        }),
      },
    );

    await slot.findByText("Offline worker");
    expect(slot.getAllByText("PR unavailable")).toHaveLength(1);
    expect(slot.queryByRole("link")).toBeNull();
  });

  it("detaches a thread from its card after confirmation and refetches the list", async () => {
    let detached = false;
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: detailRpc({
          listTaskThreads: () => ({
            taskThreads: detached
              ? []
              : [taskThreadRow(THREAD_ROW_ID, "thr_worker000", "Worker")],
          }),
          taskThreadsDetach: (input: unknown) => {
            detached = true;
            return { threadId: rpcInput(input).threadId };
          },
        }),
      },
    );

    fireEvent.click(await slot.findByRole("button", { name: "Detach Worker" }));
    fireEvent.click(await slot.findByRole("button", { name: "Detach" }));

    await waitFor(() => {
      expect(slot.rpcCalls).toContainEqual({
        method: "taskThreadsDetach",
        input: { taskId: TASK_ID, threadId: "thr_worker000" },
      });
    });
    await waitFor(() => expect(slot.queryByText("Worker")).toBeNull());
  });

  it("revalidates PR state on window focus without a task-thread mutation", async () => {
    const basePullRequest = {
      url: "https://github.com/acme/bb/pull/12",
      number: 12,
      title: "Ship the PR pill",
      updatedAt: "2026-07-16T10:00:00.000Z",
      threadIds: ["thr_worker000"],
    };
    let lookupCount = 0;
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: detailRpc({
          listTaskPullRequests: () => {
            lookupCount += 1;
            return {
              pullRequests: [
                {
                  ...basePullRequest,
                  state: lookupCount === 1 ? "open" : "merged",
                },
              ],
              unavailableThreadIds: [],
            };
          },
        }),
      },
    );

    await slot.findByRole("link", {
      name: "Pull request #12: Ship the PR pill (Open)",
    });

    window.dispatchEvent(new Event("focus"));

    await waitFor(() => {
      expect(
        slot.getByRole("link", {
          name: "Pull request #12: Ship the PR pill (Merged)",
        }),
      ).toBeTruthy();
    });
  });
});

const PROFILE_ID = "01HZZZZZZZZZZZZZZZZZZZZZS1";
const continuationProfile = {
  id: PROFILE_ID,
  name: "Continuation profile",
  providerId: "codex",
  modelId: "gpt-5",
  reasoningLevel: "medium",
  serviceTier: null,
  permissionMode: "auto",
  environmentKind: "project-default",
  baseBranch: null,
  machineId: null,
  instructions: "",
  executionContextId: null,
  modelConnectionId: null,
  builtin: false,
  createdAt: "2026-07-15T00:00:00.000Z",
};
const continuationPreview = {
  projectId: "proj_code",
  sourceEnvironmentId: "env_source",
  sourceHostId: "host_source",
  head: "abc123",
  branch: "feature/source",
  files: [
    {
      path: "src/change.ts",
      kind: "modified",
      tracked: true,
      selectedByDefault: true,
    },
    {
      path: "notes.txt",
      kind: "untracked",
      tracked: false,
      selectedByDefault: true,
    },
    {
      path: "ignored.bin",
      kind: "ignored",
      tracked: false,
      selectedByDefault: false,
    },
    {
      path: ".env",
      kind: "ignored",
      tracked: false,
      selectedByDefault: false,
      excludedReason: "Sensitive file",
    },
  ],
  activeThreadIds: [],
};
const readyContinuation = {
  operationId: "transfer_ready",
  taskId: TASK_ID,
  sourceThreadId: "thr_worker000",
  bbProjectId: "proj_code",
  sourceEnvironmentId: "env_source",
  targetHostId: "host_target",
  targetPath: "/work/prepared",
  presetId: PROFILE_ID,
  environmentId: "env_prepared",
  state: "ready",
  threadId: null,
  lastError: "Provider failed after workspace was prepared",
  createdAt: "2026-07-15T00:00:00.000Z",
};

function continuationRpc(overrides: Record<string, unknown> = {}) {
  return detailRpc({
    listTaskThreads: () => ({
      taskThreads: [
        {
          ...taskThreadRow(THREAD_ROW_ID, "thr_worker000", "Worker"),
          liveStatus: "idle",
        },
      ],
    }),
    listMachines: () => ({
      machines: [
        { id: "host_target", name: "Target machine" },
        { id: "host_source", name: "Source machine" },
      ],
    }),
    listPresets: () => ({ presets: [continuationProfile] }),
    previewTaskContinuation: () => continuationPreview,
    continueTask: () => ({
      threadId: "thr_continued",
      operationId: "transfer_new",
      environmentId: "env_target",
    }),
    ...overrides,
  });
}

describe("native task continuation", () => {
  it("transfers tracked work and only explicitly selected eligible extras with an explicit next operation", async () => {
    let started = false;
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: continuationRpc({
          listTaskThreads: () => ({
            taskThreads: [
              {
                ...taskThreadRow(THREAD_ROW_ID, "thr_worker000", "Worker"),
                liveStatus: "idle",
              },
              ...(started
                ? [
                    taskThreadRow(
                      OFFLINE_ROW_ID,
                      "thr_continued",
                      "Review target",
                    ),
                  ]
                : []),
            ],
          }),
          getTaskContinuations: () => ({
            continuations: started
              ? [
                  {
                    ...readyContinuation,
                    operationId: "transfer_new",
                    targetPath: "/work/new",
                    state: "started",
                    threadId: "thr_continued",
                    lastError: null,
                  },
                ]
              : [],
          }),
          continueTask: () => {
            started = true;
            return {
              threadId: "thr_continued",
              operationId: "transfer_new",
              environmentId: "env_target",
            };
          },
        }),
      },
    );
    fireEvent.click(
      await slot.findByRole("button", { name: "Continue on another machine" }),
    );
    expect(slot.queryByRole("combobox", { name: "Target machine" })).toBeNull();
    expect(
      document.querySelector("[data-responsive-drawer-placeholder]"),
    ).not.toBeNull();
    expect(
      slot
        .getByRole("textbox", { name: "Task title" })
        .closest("[inert], [aria-hidden='true']"),
    ).toBeNull();
    fireEvent.change(
      await slot.findByRole("combobox", { name: "Target machine" }),
      { target: { value: "host_target" } },
    );
    await slot.findByRole("checkbox", { name: "notes.txt" });
    const tracked = slot.getByRole("checkbox", {
      name: "src/change.ts",
    }) as HTMLInputElement;
    expect(tracked.checked).toBe(true);
    expect(tracked.disabled).toBe(true);
    expect(
      (slot.getByRole("checkbox", { name: "notes.txt" }) as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect(
      (slot.getByRole("checkbox", { name: ".env" }) as HTMLInputElement)
        .disabled,
    ).toBe(false);
    expect(
      (slot.getByRole("checkbox", { name: ".env" }) as HTMLInputElement)
        .checked,
    ).toBe(false);
    fireEvent.click(slot.getByRole("checkbox", { name: "ignored.bin" }));
    fireEvent.change(slot.getByRole("textbox", { name: "New target path" }), {
      target: { value: "/work/new" },
    });
    fireEvent.change(
      slot.getByRole("combobox", { name: "Continuation profile" }),
      { target: { value: PROFILE_ID } },
    );
    expect(
      (slot.getByRole("button", { name: "Continue task" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(
      slot.getByRole("textbox", { name: "Next operation / handoff" }),
      { target: { value: "Finish the native continuation regression." } },
    );
    fireEvent.change(
      slot.getByRole("textbox", { name: "New branch (optional)" }),
      { target: { value: "feature/next" } },
    );
    fireEvent.click(slot.getByRole("button", { name: "Continue task" }));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "continueTask",
        input: {
          taskId: TASK_ID,
          sourceThreadId: "thr_worker000",
          targetHostId: "host_target",
          targetPath: "/work/new",
          presetId: PROFILE_ID,
          includePaths: ["ignored.bin"],
          extraInstructions: "Finish the native continuation regression.",
          branch: "feature/next",
        },
      }),
    );
    await slot.findByText(/New native thread started. Operation transfer_new/);
    expect(slot.getByText("Worker")).toBeTruthy();
    await slot.findByText(
      "Continued to thr_continued on host_target; previous executor",
    );
    await slot.findByText("Current executor · continued from thr_worker000");
    expect(
      slot.queryByRole("button", { name: "Continue on another machine" }),
    ).toBeNull();
    expect(
      slot.rpcCalls.some(
        (call) =>
          call.method === "taskThreadsDetach" ||
          call.method === "delegate" ||
          call.method === "transferWorkspace",
      ),
    ).toBe(false);
  });

  it("does not offer continuation on active or completed source cards", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: continuationRpc({
          listTaskThreads: () => ({
            taskThreads: [
              taskThreadRow(THREAD_ROW_ID, "thr_worker000", "Worker"),
              {
                ...taskThreadRow(
                  OFFLINE_ROW_ID,
                  "thr_offline00",
                  "Completed worker",
                ),
                liveStatus: "completed",
              },
            ],
          }),
        }),
      },
    );
    await slot.findByText("Completed worker");
    expect(
      slot.queryByRole("button", { name: "Continue on another machine" }),
    ).toBeNull();
  });

  it("blocks active or unsafe source previews without calling continuation", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: continuationRpc({
          previewTaskContinuation: () => ({
            ...continuationPreview,
            activeThreadIds: ["thr_other000"],
            files: [
              {
                path: "tracked-secret",
                kind: "sensitive-tracked",
                tracked: true,
                selectedByDefault: false,
                excludedReason: "Sensitive tracked file",
              },
            ],
          }),
        }),
      },
    );
    fireEvent.click(
      await slot.findByRole("button", { name: "Continue on another machine" }),
    );
    fireEvent.change(
      await slot.findByRole("combobox", { name: "Target machine" }),
      { target: { value: "host_target" } },
    );
    await slot.findByText(
      "Source threads are active. Wait until every source thread is idle.",
    );
    expect(
      slot.getByText(/Tracked sensitive files require explicit consent/),
    ).toBeTruthy();
    expect(
      (slot.getByRole("button", { name: "Continue task" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(slot.rpcCalls.some((call) => call.method === "continueTask")).toBe(
      false,
    );
  });

  it("requires explicit selection before transferring sensitive tracked files", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: continuationRpc({
          previewTaskContinuation: () => ({
            ...continuationPreview,
            files: [
              {
                path: "tracked-secret",
                kind: "sensitive-tracked",
                tracked: true,
                selectedByDefault: false,
                excludedReason: "Sensitive tracked file",
              },
            ],
          }),
        }),
      },
    );
    fireEvent.click(
      await slot.findByRole("button", { name: "Continue on another machine" }),
    );
    fireEvent.change(
      await slot.findByRole("combobox", { name: "Target machine" }),
      { target: { value: "host_target" } },
    );
    const consent = (await slot.findByRole("checkbox", {
      name: "tracked-secret",
    })) as HTMLInputElement;
    expect(consent.checked).toBe(false);
    expect(consent.disabled).toBe(false);
    fireEvent.change(slot.getByRole("textbox", { name: "New target path" }), {
      target: { value: "/work/new" },
    });
    fireEvent.change(
      slot.getByRole("combobox", { name: "Continuation profile" }),
      { target: { value: PROFILE_ID } },
    );
    fireEvent.change(
      slot.getByRole("textbox", { name: "Next operation / handoff" }),
      { target: { value: "Continue after explicit sensitive-file consent" } },
    );
    expect(
      (slot.getByRole("button", { name: "Continue task" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(consent);
    fireEvent.click(slot.getByRole("button", { name: "Continue task" }));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "continueTask",
        input: {
          taskId: TASK_ID,
          sourceThreadId: "thr_worker000",
          targetHostId: "host_target",
          targetPath: "/work/new",
          presetId: PROFILE_ID,
          includePaths: ["tracked-secret"],
          extraInstructions: "Continue after explicit sensitive-file consent",
        },
      }),
    );
  });

  it("keeps failed transfer errors visible and retains the source card", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: continuationRpc({
          continueTask: () => {
            throw new Error("Workspace changed during capture");
          },
        }),
      },
    );
    fireEvent.click(
      await slot.findByRole("button", { name: "Continue on another machine" }),
    );
    fireEvent.change(
      await slot.findByRole("combobox", { name: "Target machine" }),
      { target: { value: "host_target" } },
    );
    await slot.findByRole("checkbox", { name: "notes.txt" });
    fireEvent.change(slot.getByRole("textbox", { name: "New target path" }), {
      target: { value: "/work/new" },
    });
    fireEvent.change(
      slot.getByRole("combobox", { name: "Continuation profile" }),
      { target: { value: PROFILE_ID } },
    );
    fireEvent.change(
      slot.getByRole("textbox", { name: "Next operation / handoff" }),
      { target: { value: "Implement next operation" } },
    );
    fireEvent.click(slot.getByRole("button", { name: "Continue task" }));
    await slot.findByText("Workspace changed during capture");
    expect(slot.getByText("Worker")).toBeTruthy();
    expect(slot.queryByText(/New native thread started/)).toBeNull();
  });

  it("retries a durable ready operation without requesting another workspace preview", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: continuationRpc({
          getTaskContinuations: () => ({ continuations: [readyContinuation] }),
        }),
      },
    );
    await slot.findByText("Continuation operation transfer_ready · ready");
    await slot.findByText(readyContinuation.lastError);
    fireEvent.click(
      slot.getByRole("button", { name: "Retry prepared continuation" }),
    );
    fireEvent.change(
      await slot.findByRole("textbox", { name: "Next operation / handoff" }),
      {
        target: { value: "Retry the next operation in the prepared workspace" },
      },
    );
    fireEvent.click(slot.getByRole("button", { name: "Retry agent start" }));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "continueTask",
        input: {
          taskId: TASK_ID,
          sourceThreadId: "thr_worker000",
          targetHostId: "host_target",
          targetPath: "/work/prepared",
          presetId: PROFILE_ID,
          includePaths: [],
          extraInstructions:
            "Retry the next operation in the prepared workspace",
          operationId: "transfer_ready",
        },
      }),
    );
    expect(
      slot.rpcCalls.some((call) => call.method === "previewTaskContinuation"),
    ).toBe(false);
    expect(slot.getByText("Worker")).toBeTruthy();
  });
});

describe("task continuation preview errors", () => {
  it("shows preview failure and never starts a target thread", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: continuationRpc({
          previewTaskContinuation: () => {
            throw new Error("Source environment is no longer current");
          },
        }),
      },
    );
    fireEvent.click(
      await slot.findByRole("button", { name: "Continue on another machine" }),
    );
    fireEvent.change(
      await slot.findByRole("combobox", { name: "Target machine" }),
      { target: { value: "host_target" } },
    );
    await slot.findByText("Source environment is no longer current");
    expect(
      (slot.getByRole("button", { name: "Continue task" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(slot.rpcCalls.some((call) => call.method === "continueTask")).toBe(
      false,
    );
    expect(slot.getByText("Worker")).toBeTruthy();
  });
});

describe("continued task executor labels", () => {
  it("keeps the source inspectable as the previous executor and marks the target current", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: continuationRpc({
          listTaskThreads: () => ({
            taskThreads: [
              {
                ...taskThreadRow(
                  THREAD_ROW_ID,
                  "thr_worker000",
                  "Triage source",
                ),
                liveStatus: "idle",
              },
              {
                ...taskThreadRow(
                  OFFLINE_ROW_ID,
                  "thr_review000",
                  "Review target",
                ),
                liveStatus: "idle",
              },
            ],
          }),
          getTaskContinuations: () => ({
            continuations: [
              {
                ...readyContinuation,
                state: "started",
                threadId: "thr_review000",
                lastError: null,
              },
            ],
          }),
        }),
      },
    );
    await slot.findByText(
      "Continued to thr_review000 on host_target; previous executor",
    );
    expect(slot.getByText("Triage source")).toBeTruthy();
    expect(slot.getByText("Review target")).toBeTruthy();
    expect(
      slot.getByText("Current executor · continued from thr_worker000"),
    ).toBeTruthy();
    expect(
      slot.getAllByRole("button", { name: "Continue on another machine" }),
    ).toHaveLength(1);
    expect(slot.getAllByRole("button", { name: "Open thread" })).toHaveLength(
      2,
    );
    fireEvent.click(slot.getAllByRole("button", { name: "Open thread" })[0]!);
    expect(slot.navigateCalls).toContainEqual({
      method: "toThread",
      threadId: "thr_worker000",
    });
  });

  it("does not label an intermediate executor current after a second continuation", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: continuationRpc({
          listTaskThreads: () => ({
            taskThreads: [
              {
                ...taskThreadRow(
                  THREAD_ROW_ID,
                  "thr_worker000",
                  "Triage source",
                ),
                liveStatus: "idle",
              },
              {
                ...taskThreadRow(
                  OFFLINE_ROW_ID,
                  "thr_review000",
                  "Review target",
                ),
                liveStatus: "idle",
              },
              {
                ...taskThreadRow(
                  "01HZZZZZZZZZZZZZZZZZZZZZR3",
                  "thr_latest000",
                  "Latest target",
                ),
                liveStatus: "idle",
              },
            ],
          }),
          getTaskContinuations: () => ({
            continuations: [
              {
                ...readyContinuation,
                state: "started",
                threadId: "thr_review000",
                lastError: null,
              },
              {
                ...readyContinuation,
                operationId: "transfer_next",
                sourceThreadId: "thr_review000",
                targetHostId: "host_next",
                state: "started",
                threadId: "thr_latest000",
                lastError: null,
              },
            ],
          }),
        }),
      },
    );
    await slot.findByText(
      "Continued to thr_latest000 on host_next; previous executor",
    );
    expect(
      slot.getByText(
        "Continued to thr_review000 on host_target; previous executor",
      ),
    ).toBeTruthy();
    expect(
      slot.queryByText("Current executor · continued from thr_worker000"),
    ).toBeNull();
    expect(
      slot.getByText("Current executor · continued from thr_review000"),
    ).toBeTruthy();
    expect(
      slot.getAllByRole("button", { name: "Continue on another machine" }),
    ).toHaveLength(1);
  });
});
