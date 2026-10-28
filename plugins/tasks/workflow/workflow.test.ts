import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createStore } from "../api/index.js";
import { TaskWorkflowStore } from "./store.js";
import { assertTaskWorkflowStatusTransition } from "./index.js";
import type { BuildReviewStart } from "./remote-contract.js";
import type { TaskWorkflow } from "../shared/workflow-contract.js";
import { registerInbox } from "../inbox/index.js";

const hosts: FakePluginHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
});
function setup(explicitBindings = true) {
  const statuses = new Map<string, "idle" | "active">();
  const host = createFakePluginHost({
    pluginId: "tasks",
    sdk: {
      threads: {
        get: async ({ threadId }) =>
          makeThreadResponse({
            id: threadId,
            status: statuses.get(threadId) ?? "idle",
          }),
        listRunning: async () =>
          [...statuses]
            .filter(([, status]) => status === "active")
            .map(([id]) => ({ id, hostId: "host_fixture" })),
        interactions: { list: async () => [] },
      },
    },
  });
  hosts.push(host);
  const store = createStore(host.bb);
  const project = store.tasks.createProject({
    name: "Owned fixture",
    prefix: "WR",
    color: "blue",
  });
  const task = store.tasks.createTask({
    projectId: project.id,
    title: "Disposable workflow task",
  });
  const request: BuildReviewStart = {
    template: "development-review",
    key: "twf_fixture:1",
    group: "twf_fixture",
    projectId: "prj_fixture",
    originThreadId: "thr_origin",
    task: task.title,
    writer: {
      provider: "codex",
      model: "writer",
      ...(explicitBindings
        ? { executionContextId: "context-writer", modelConnectionId: "personal-cpa" }
        : {}),
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: null,
      instructions: "",
    },
    reviewer: {
      provider: "claude",
      model: "reviewer",
      ...(explicitBindings
        ? { executionContextId: "context-reviewer", modelConnectionId: "work-cpa" }
        : {}),
      reasoningLevel: "medium",
      permissionMode: "auto",
      serviceTier: null,
      instructions: "",
    },
    smokeCommands: ["owned-platform-smoke"],
    uiRequired: true,
    feedback: "",
  };
  const workflows = new TaskWorkflowStore(store);
  workflows.create("launch-one", task.id, request, "{}");
  const native: NonNullable<TaskWorkflow["native"]> = {
    runId: "wfr_fixture",
    key: request.key,
    contextStarted: true,
    status: "succeeded",
    phase: "Independent review",
    error: null,
    result: {
      plan: "Implement the bounded change",
      build: {
        branch: "owned-fixture",
        commit: "a".repeat(40),
        diff: "owned file +1",
        commands: [
          {
            command: "owned-platform-smoke",
            exitCode: 0,
            output: "Fixture smoke passed",
          },
        ],
        uiEvidence: [
          {
            kind: "screenshot",
            location: "fixture.png",
            description: "Actual fixture UI",
          },
        ],
        limitations: [],
        nextDecision: "Human Accept or Return",
      },
      review: { verdict: "ready", findings: [], summary: "Reviewed" },
    },
    workers: [
      { threadId: "thr_writer", role: "writer", callIndex: 1 },
      { threadId: "thr_reviewer", role: "reviewer", callIndex: 2 },
    ],
    policyLimitations: ["No read-only sandbox"],
  };
  return { host, statuses, store, workflows, task, request, native };
}
describe("task workflow durable human review", () => {
  it("publishes duplicate native completion exactly once across store restart without accepting", () => {
    const { store, workflows, task, native } = setup();
    workflows.publish("twf_fixture", native);
    new TaskWorkflowStore(store).publish("twf_fixture", native);
    expect(store.tasks.listComments(task.id)).toHaveLength(1);
    expect(store.tasks.getTask(task.id)?.status).toBe("in_review");
    expect(() =>
      assertTaskWorkflowStatusTransition(store, task.id, "done"),
    ).toThrow(/explicit workflow Accept/);
  });
  it("makes human acceptance idempotent and rejects stale revisions", () => {
    const { store, workflows, task, native } = setup();
    workflows.publish("twf_fixture", native);
    expect(() => workflows.accept("twf_fixture", 2)).toThrow(/Stale/);
    workflows.accept("twf_fixture", 1);
    new TaskWorkflowStore(store).accept("twf_fixture", 1);
    expect(store.tasks.listComments(task.id)).toHaveLength(2);
    expect(store.tasks.getTask(task.id)?.status).toBe("done");
    expect(() =>
      assertTaskWorkflowStatusTransition(store, task.id, "done"),
    ).not.toThrow();
  });
  it("returns once to the same durable group, origin and profiles and publishes the next revision separately", () => {
    const { store, workflows, task, request, native } = setup();
    workflows.publish("twf_fixture", native);
    const first = workflows.return("twf_fixture", 1, "Fix mobile layout");
    const restarted = new TaskWorkflowStore(store);
    expect(restarted.return("twf_fixture", 1, "Fix mobile layout")).toEqual(
      first,
    );
    expect(restarted.request("twf_fixture")).toEqual({
      ...request,
      key: "twf_fixture:2",
      feedback: "Fix mobile layout",
    });
    expect(() => restarted.return("twf_fixture", 1, "Other feedback")).toThrow(
      /Stale/,
    );
    expect(restarted.publish("twf_fixture", native).state).toBe("launching");
    restarted.publish("twf_fixture", {
      ...native,
      key: "twf_fixture:2",
      runId: "wfr_second",
    });
    restarted.publish("twf_fixture", {
      ...native,
      key: "twf_fixture:2",
      runId: "wfr_second",
    });
    expect(store.tasks.listComments(task.id)).toHaveLength(3);
    expect(store.tasks.getTask(task.id)?.status).toBe("in_review");
  });
  it("rolls publication back when the task was closed elsewhere", () => {
    const { store, workflows, task, native } = setup();
    store.tasks.updateTask(task.id, { status: "canceled" });
    expect(() => workflows.publish("twf_fixture", native)).toThrow(/closed/);
    expect(store.tasks.listComments(task.id)).toHaveLength(0);
    store.tasks.updateTask(task.id, { status: "in_progress" });
    workflows.publish("twf_fixture", native);
    expect(store.tasks.listComments(task.id)).toHaveLength(1);
  });
  it("prevents concurrent task workflows and duplicate durable launch receipts", () => {
    const { workflows, task, request } = setup();
    expect(() =>
      workflows.create(
        "launch-one",
        task.id,
        { ...request, group: "twf_duplicate" },
        "{}",
      ),
    ).toThrow();
    expect(() =>
      workflows.create(
        "launch-two",
        task.id,
        { ...request, group: "twf_parallel" },
        "{}",
      ),
    ).toThrow();
  });
});

describe("first-writer profile repair", () => {
  it("uses repaired profiles only when the native engine proves that no context started", () => {
    const { workflows, request, native } = setup();
    workflows.publish("twf_fixture", {
      ...native,
      status: "failed",
      contextStarted: false,
      workers: [],
      result: null,
      error: "Model unavailable before spawn",
    });
    const profiles = {
      writer: {
        ...request.writer,
        model: "repaired-writer",
        executionContextId: "repaired-context",
        modelConnectionId: "repaired-cpa",
      },
      reviewer: request.reviewer,
    };
    workflows.return("twf_fixture", 1, "Selected profile repaired", profiles);
    expect(workflows.request("twf_fixture").writer).toEqual(profiles.writer);
    expect(workflows.request("twf_fixture").group).toBe(request.group);
    expect(workflows.request("twf_fixture").originThreadId).toBe(
      request.originThreadId,
    );
  });
  it.each([true, undefined])(
    "refuses binding replacement when contextStarted is %s",
    (contextStarted) => {
      const { store, workflows, request, native } = setup();
      workflows.publish("twf_fixture", {
        ...native,
        status: "failed",
        contextStarted: true,
        workers: [],
        result: null,
        error: "Ambiguous delivery",
      });
      if (contextStarted === undefined)
        store.database.prepare(
          "UPDATE task_workflow_runs SET view_json = json_remove(view_json, '$.native.contextStarted') WHERE id = ?",
        ).run("twf_fixture");
      expect(() =>
        workflows.return("twf_fixture", 1, "Switch account", {
          writer: { ...request.writer, modelConnectionId: "other-account" },
          reviewer: request.reviewer,
        }),
      ).toThrow(/existing or uncertain/);
      expect(workflows.get("twf_fixture").revision).toBe(1);
      expect(workflows.request("twf_fixture").writer).toEqual(request.writer);
    },
  );
  it("keeps legacy omitted bindings implicit across replay and Return", () => {
    const { store, workflows, native } = setup(false);
    const original = store.database.prepare<[string], { request_json: string }>(
      "SELECT request_json FROM task_workflow_runs WHERE id = ?",
    ).get("twf_fixture")!.request_json;
    workflows.publish("twf_fixture", native);
    const restarted = new TaskWorkflowStore(store);
    restarted.publish("twf_fixture", native);
    expect(store.database.prepare<[string], { request_json: string }>(
      "SELECT request_json FROM task_workflow_runs WHERE id = ?",
    ).get("twf_fixture")!.request_json).toBe(original);
    restarted.return("twf_fixture", 1, "Correct the result without selecting an account");
    for (const profile of [restarted.request("twf_fixture").writer, restarted.request("twf_fixture").reviewer]) {
      expect(profile).not.toHaveProperty("executionContextId");
      expect(profile).not.toHaveProperty("modelConnectionId");
    }
  });
});

describe("workflow native Inbox projection", () => {
  it("lists the active writer then reviewer while the task origin stays idle, even before task-thread attachment", async () => {
    const { host, statuses, store, workflows, task, native } = setup();
    store.tasks.upsertTaskThread({
      taskId: task.id,
      threadId: "thr_origin",
      title: "Idle origin",
      presetName: "Origin",
      liveStatus: "idle",
    });
    workflows.publish("twf_fixture", {
      ...native,
      status: "running",
      result: null,
    });
    statuses.set("thr_writer", "active");
    const inbox = registerInbox(host.bb, store, { background: false });
    expect(
      (await inbox.listWorking({})).items.map((item) => item.threadId),
    ).toEqual(["thr_writer"]);
    statuses.set("thr_writer", "idle");
    statuses.set("thr_reviewer", "active");
    expect(
      (await inbox.listWorking({})).items.map((item) => item.threadId),
    ).toEqual(["thr_reviewer"]);
  });
  it("projects the writer result package even when the reviewer was the latest attached thread", async () => {
    const { host, store, workflows, task, native } = setup();
    store.tasks.upsertTaskThread({
      taskId: task.id,
      threadId: "thr_writer",
      title: "Writer",
      presetName: "Writer",
      liveStatus: "completed",
    });
    store.tasks.upsertTaskThread({
      taskId: task.id,
      threadId: "thr_reviewer",
      title: "Reviewer",
      presetName: "Reviewer",
      liveStatus: "completed",
    });
    workflows.publish("twf_fixture", native);
    const inbox = registerInbox(host.bb, store, { background: false });
    const result = await inbox.listInbox({ state: "open" });
    const review = result.items.find(
      (item) => item.sourceKind === "task_review",
    );
    expect(review?.threadId).toBe("thr_writer");
    expect(review?.body).toContain("Fixture smoke passed");
    expect(review?.body).toContain(native.result!.build.commit);
  });
  it("surfaces pre-spawn failure without inventing an active thread and clears it on Return", async () => {
    const { host, store, workflows, task, native } = setup();
    workflows.publish("twf_fixture", {
      ...native,
      contextStarted: false,
      status: "failed",
      error: "Provider initialization failed before spawn",
      workers: [],
      result: null,
    });
    const inbox = registerInbox(host.bb, store, { background: false });
    const failure = (await inbox.listInbox({ state: "open" })).items.find(
      (item) => item.sourceKind === "task_workflow",
    );
    expect(failure).toMatchObject({
      taskId: task.id,
      threadId: null,
      lane: "needs_input",
    });
    expect(failure?.body).toContain("before spawn");
    expect((await inbox.listWorking({})).items).toEqual([]);
    expect(() =>
      assertTaskWorkflowStatusTransition(store, task.id, "done"),
    ).toThrow();
    expect(
      workflows.return(
        "twf_fixture",
        1,
        "Provider repaired; retry the original bounded task",
      ),
    ).toMatchObject({ revision: 2, state: "launching" });
    expect(
      (await inbox.listInbox({ state: "open" })).items.filter(
        (item) => item.sourceKind === "task_workflow" && item.active,
      ),
    ).toEqual([]);
  });
});
