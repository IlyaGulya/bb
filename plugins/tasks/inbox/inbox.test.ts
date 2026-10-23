import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createStore } from "../api/index.js";
import { registerTasksCli } from "../cli/index.js";
import { registerJiraSync } from "../jira/index.js";
import { ExecutionStore } from "../delegate/execution-store.js";
import { inboxRpcContract } from "../shared/inbox-contract.js";
import { registerInbox } from "./index.js";

const hosts: FakePluginHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
});
function setup() {
  const state: {
    now: string;
    status: "active" | "idle" | "error";
    question: boolean;
    unavailable: boolean;
    questionsUnavailable: boolean;
    failureSeq: number;
    threadStatuses: Map<string, "active" | "idle" | "error">;
    questionThreads: Set<string>;
    runningIds: string[];
  } = {
    now: "2026-10-23T10:00:00.000Z",
    status: "active",
    question: false,
    unavailable: false,
    questionsUnavailable: false,
    failureSeq: 1,
    threadStatuses: new Map(),
    questionThreads: new Set(),
    runningIds: [],
  };
  const host = createFakePluginHost({
    pluginId: "tasks",
    sdk: {
      threads: {
        listRunning: async () =>
          state.runningIds.map((id) => ({ id, hostId: "host_synthetic" })),
        events: {
          list: async ({ threadId }) => [
            {
              id: `event_${threadId}_${state.failureSeq}`,
              threadId,
              seq: state.failureSeq,
              createdAt: 1,
              scope: {
                kind: "turn" as const,
                turnId: `turn_${state.failureSeq}`,
              },
              type: "system/error" as const,
              data: { message: "Synthetic provider execution failed" },
            },
          ],
        },
        get: async ({ threadId }) => {
          if (state.unavailable) throw new Error("Synthetic host unreachable");
          return makeThreadResponse({
            id: threadId,
            status:
              state.threadStatuses.get(threadId) ??
              (threadId === "thr_retired" ? "error" : state.status),
          });
        },
        interactions: {
          list: async ({ threadId }) => {
            if (state.questionsUnavailable)
              throw new Error("Synthetic interactions unavailable");
            return state.question || state.questionThreads.has(threadId)
              ? [
                  {
                    id: `pint_${threadId}`,
                    threadId,
                    turnId: "turn_inbox",
                    status: "pending" as const,
                    statusReason: null,
                    createdAt: 1,
                    resolvedAt: null,
                    origin: {
                      kind: "plugin" as const,
                      pluginId: "ask-user-question",
                      rendererId: "question",
                    },
                    payload: {
                      kind: "plugin" as const,
                      title: "Choose a branch",
                      data: {},
                    },
                    resolution: null,
                  },
                ]
              : [];
          },
        },
      },
    },
  });
  hosts.push(host);
  const store = createStore(host.bb);
  const project = store.tasks.createProject({
    name: "Synthetic Inbox",
    prefix: "IBX",
    color: "blue",
  });
  const handlers = registerInbox(host.bb, store, {
    now: () => state.now,
    background: false,
  });
  return { ...host, store, project, handlers, state };
}
const source = {
  sourceKind: "machine_health",
  sourceKey: "host_synthetic:disk",
  revision: "incident-1",
  title: "Synthetic disk warning",
  body: "Threshold crossed",
  context: "unknown" as const,
  active: true,
};

describe("durable unified attention", () => {
  it("keeps incoming independent, returns snoozes once, and creates one native task across replay", async () => {
    const f = setup();
    const { item } = await f.handlers.createInbox({
      title: "Investigate warning",
      body: "Keep original context",
      context: "work",
    });
    expect(f.store.tasks.listTasks()).toEqual([]);
    await f.handlers.decideInbox({
      id: item.id,
      action: "snooze",
      until: "2026-10-23T10:05:00.000Z",
    });
    expect((await f.handlers.listInbox({ state: "open" })).items).toEqual([]);
    f.state.now = "2026-10-23T10:05:00.000Z";
    expect((await f.handlers.listInbox({ state: "open" })).items).toMatchObject(
      [{ id: item.id, state: "open" }],
    );
    const before = f.harness.realtimeSignals.length;
    await f.handlers.listInbox({ state: "open" });
    expect(f.harness.realtimeSignals).toHaveLength(before);
    expect(
      (await f.handlers.inboxHistory({ id: item.id })).decisions.map(
        (entry) => entry.decision,
      ),
    ).toEqual(["received", "snooze", "time_return"]);
    const created = await f.handlers.createInboxTask({
      id: item.id,
      projectId: f.project.id,
    });
    const signals = f.harness.realtimeSignals.length;
    expect(
      await f.handlers.createInboxTask({
        id: item.id,
        projectId: f.project.id,
      }),
    ).toEqual(created);
    expect(f.harness.realtimeSignals).toHaveLength(signals);
    expect(f.store.tasks.listTasks()).toMatchObject([
      {
        id: created.item.taskId,
        title: item.title,
        description: item.body,
        status: "todo",
      },
    ]);
    expect(created.item).toMatchObject({
      state: "resolved",
      taskKey: "IBX-1",
      context: "work",
    });
    expect(f.store.tasks.listTaskThreads(created.item.taskId!)).toEqual([]);
    expect(f.harness.sdk.callsTo("threads.spawn")).toEqual([]);
    const restarted = await f.harness.reload((bb) => {
      registerInbox(bb, createStore(bb), { background: false });
    });
    hosts.push(restarted);
    expect(
      await restarted.harness.callRpc("createInboxTask", {
        id: item.id,
        projectId: f.project.id,
      }),
    ).toEqual(created);
    expect(createStore(restarted.bb).tasks.listTasks()).toHaveLength(1);
  });

  it("preserves dismissal and history through closing/reopening SQLite, without duplicate source events", async () => {
    const f = setup();
    const { item } = await f.handlers.upsertInboxSource(source);
    await f.handlers.decideInbox({ id: item.id, action: "resolve" });
    const before = await f.handlers.inboxHistory({ id: item.id });
    const restarted = await f.harness.reload((bb) => {
      registerInbox(bb, createStore(bb), { background: false });
    });
    hosts.push(restarted);
    const replay = inboxRpcContract.upsertInboxSource.output.parse(
      await restarted.harness.callRpc("upsertInboxSource", source),
    );
    expect(replay).toMatchObject({
      changed: false,
      item: { id: item.id, state: "resolved" },
    });
    expect(
      await restarted.harness.callRpc("inboxHistory", { id: item.id }),
    ).toEqual(before);
    expect(restarted.harness.realtimeSignals).toEqual([]);
    const revised = inboxRpcContract.upsertInboxSource.output.parse(
      await restarted.harness.callRpc("upsertInboxSource", {
        ...source,
        revision: "incident-2",
      }),
    );
    expect(revised).toMatchObject({
      changed: true,
      item: { id: item.id, state: "open" },
    });
    const all = inboxRpcContract.listInbox.output.parse(
      await restarted.harness.callRpc("listInbox", { state: "all" }),
    );
    expect(all.items).toHaveLength(1);
  });

  it("wakes only meaningful revisions and recovery never completes its linked native task", async () => {
    const f = setup();
    const { item } = await f.handlers.upsertInboxSource(source);
    await f.handlers.decideInbox({
      id: item.id,
      action: "snooze",
      until: "2026-10-24T10:00:00.000Z",
    });
    expect(
      await f.handlers.upsertInboxSource({
        ...source,
        body: "Polling timestamp noise",
      }),
    ).toMatchObject({
      changed: false,
      item: { state: "snoozed", body: source.body },
    });
    expect(
      await f.handlers.upsertInboxSource({
        ...source,
        revision: "incident-1:critical",
      }),
    ).toMatchObject({ item: { state: "open", snoozedUntil: null } });
    const linked = await f.handlers.createInboxTask({
      id: item.id,
      projectId: f.project.id,
    });
    await f.handlers.upsertInboxSource({
      ...source,
      revision: "incident-1:critical",
      active: false,
    });
    expect(f.store.tasks.getTask(linked.item.taskId!)?.status).toBe("todo");
    expect(
      await f.handlers.upsertInboxSource({
        ...source,
        revision: "incident-1:critical",
        active: true,
      }),
    ).toMatchObject({ item: { state: "resolved" } });
    expect((await f.handlers.listInbox({ state: "all" })).items).toHaveLength(
      1,
    );
  });
  it("records recovery arriving before first active delivery without phantom attention", async () => {
    const f = setup();
    const recovered = await f.handlers.upsertInboxSource({
      ...source,
      active: false,
    });
    expect(recovered).toMatchObject({
      changed: true,
      item: { state: "resolved", active: false },
    });
    expect((await f.handlers.listInbox({ state: "open" })).items).toEqual([]);
    const count = f.harness.realtimeSignals.length;
    expect(
      await f.handlers.upsertInboxSource({ ...source, active: false }),
    ).toMatchObject({ changed: false });
    expect(f.harness.realtimeSignals).toHaveLength(count);
    expect(
      await f.handlers.upsertInboxSource({ ...source, revision: "incident-2" }),
    ).toMatchObject({ item: { id: recovered.item.id, state: "open" } });
  });

  it("links an existing task once and rejects relinking and invalid snooze boundaries", async () => {
    const f = setup();
    const task = f.store.tasks.createTask({
      projectId: f.project.id,
      title: "Existing",
    });
    const other = f.store.tasks.createTask({
      projectId: f.project.id,
      title: "Other",
    });
    const { item } = await f.handlers.createInbox({
      title: "Incoming",
      body: "",
      context: "personal",
    });
    await f.handlers.linkInboxTask({ id: item.id, taskId: task.id });
    expect(
      await f.handlers.createInboxTask({
        id: item.id,
        projectId: f.project.id,
      }),
    ).toMatchObject({ item: { taskId: task.id } });
    await expect(
      f.harness.callRpc("linkInboxTask", { id: item.id, taskId: other.id }),
    ).rejects.toThrow("already links");
    await expect(
      f.harness.callRpc("decideInbox", {
        id: item.id,
        action: "snooze",
        until: "2026-10-23T09:00:00Z",
      }),
    ).rejects.toThrow("future");
    await expect(
      f.harness.callRpc("decideInbox", {
        id: item.id,
        action: "resolve",
        until: "2026-10-24T09:00:00Z",
      }),
    ).rejects.toThrow("only valid");
    await f.handlers.decideInbox({ id: item.id, action: "unsnooze" });
    expect(
      (await f.handlers.listInbox({ state: "open", context: "personal" }))
        .items,
    ).toMatchObject([{ id: item.id }]);
    expect(
      (await f.handlers.listInbox({ state: "open", context: "work" })).items,
    ).toEqual([]);
    expect(f.store.tasks.listTasks()).toHaveLength(2);
  });

  it("projects native questions and running separately, then review, never accepting idle", async () => {
    const f = setup();
    const { item } = await f.handlers.createInbox({
      title: "Native lifecycle",
      body: "",
      context: "work",
    });
    const linked = await f.handlers.createInboxTask({
      id: item.id,
      projectId: f.project.id,
    });
    const taskId = linked.item.taskId!;
    f.store.tasks.upsertTaskThread({
      taskId,
      threadId: "thr_worker",
      title: "Worker",
      presetName: "Synthetic",
      liveStatus: "working",
    });
    expect((await f.handlers.listWorking({})).items).toMatchObject([
      { taskId, threadId: "thr_worker", context: "work" },
    ]);
    f.state.question = true;
    const attention = await f.handlers.listInbox({ state: "open" });
    expect(attention.items).toMatchObject([
      {
        lane: "needs_input",
        sourceKind: "native_interaction",
        threadId: "thr_worker",
        title: "IBX-1: Choose a branch",
      },
    ]);
    expect((await f.handlers.listWorking({})).items).toEqual([]);
    await f.handlers.decideInbox({
      id: attention.items[0]!.id,
      action: "resolve",
    });
    expect((await f.handlers.listInbox({ state: "open" })).items).toEqual([]);
    expect(f.state.question).toBe(true);
    f.state.question = false;
    f.state.status = "idle";
    await f.handlers.listInbox({ state: "all" });
    expect(f.store.tasks.getTask(taskId)?.status).toBe("todo");
    expect((await f.handlers.listWorking({})).items).toEqual([]);
    f.store.tasks.updateTask(taskId, { status: "in_review" });
    const review = (await f.handlers.listInbox({ state: "open" })).items[0]!;
    expect(review).toMatchObject({
      lane: "review",
      threadId: "thr_worker",
      context: "work",
    });
    await f.handlers.decideInbox({ id: review.id, action: "resolve" });
    f.store.tasks.updateTask(taskId, { priority: "high" });
    expect((await f.handlers.listInbox({ state: "open" })).items).toEqual([]);
    expect(f.store.tasks.getTask(taskId)?.status).toBe("in_review");
    f.store.tasks.updateTask(taskId, {
      description: "Meaningfully revised review result",
    });
    expect((await f.handlers.listInbox({ state: "open" })).items).toMatchObject(
      [{ id: review.id, lane: "review" }],
    );
    await f.handlers.decideInbox({ id: review.id, action: "resolve" });
    f.store.tasks.updateTask(taskId, { status: "in_progress" });
    f.store.tasks.updateTask(taskId, { status: "in_review" });
    expect((await f.handlers.listInbox({ state: "open" })).items).toMatchObject(
      [{ id: review.id, state: "open" }],
    );
  });

  it("distinguishes a current native failure from a question and resolves recovery without accepting work", async () => {
    const f = setup();
    const task = f.store.tasks.createTask({
      projectId: f.project.id,
      title: "Current failure",
      status: "in_progress",
    });
    f.store.tasks.upsertTaskThread({
      taskId: task.id,
      threadId: "thr_worker",
      title: "Worker",
      presetName: "Synthetic",
      liveStatus: "failed",
    });
    f.state.status = "error";
    const failed = await f.handlers.listInbox({ state: "open" });
    expect(failed.items).toMatchObject([
      {
        sourceKind: "native_failure",
        lane: "needs_input",
        threadId: "thr_worker",
      },
    ]);
    expect(failed.items[0]!.reason).toContain("not a pending question");
    expect(failed.warnings).toEqual([]);
    const events = f.harness.realtimeSignals.length;
    await f.handlers.listInbox({ state: "open" });
    expect(f.harness.realtimeSignals).toHaveLength(events);
    f.state.status = "idle";
    expect((await f.handlers.listInbox({ state: "open" })).items).toEqual([]);
    expect(f.store.tasks.getTask(task.id)?.status).toBe("in_progress");
  });

  it("does not resurrect older failed attempts after successful replacement or task acceptance", async () => {
    const f = setup();
    const task = f.store.tasks.createTask({
      projectId: f.project.id,
      title: "Retry succeeded",
      status: "in_progress",
    });
    f.store.tasks.upsertTaskThread({
      taskId: task.id,
      threadId: "thr_old_failure",
      title: "Old attempt",
      presetName: "Synthetic",
      liveStatus: "failed",
    });
    f.state.threadStatuses.set("thr_old_failure", "error");
    const old = (await f.handlers.listInbox({ state: "open" })).items[0]!;
    expect(old.sourceKind).toBe("native_failure");
    f.store.tasks.upsertTaskThread({
      taskId: task.id,
      threadId: "thr_success",
      title: "Successful retry",
      presetName: "Synthetic",
      liveStatus: "idle",
    });
    f.state.threadStatuses.set("thr_success", "idle");
    const reads = f.harness.sdk.callsTo("threads.get").length;
    expect((await f.handlers.listInbox({ state: "open" })).items).toEqual([]);
    expect(
      f.harness.sdk.callsTo("threads.get").slice(reads).flat(),
    ).not.toContainEqual({ threadId: "thr_old_failure" });
    expect(
      (await f.handlers.listInbox({ state: "resolved" })).items,
    ).toMatchObject([{ id: old.id, active: false }]);
    f.store.tasks.updateTask(task.id, { status: "done" });
    f.state.threadStatuses.set("thr_success", "error");
    expect((await f.handlers.listInbox({ state: "open" })).items).toEqual([]);
    f.state.questionThreads.add("thr_old_failure");
    expect((await f.handlers.listInbox({ state: "open" })).items).toMatchObject(
      [{ sourceKind: "native_interaction", threadId: "thr_old_failure" }],
    );
    expect(f.store.tasks.getTask(task.id)?.status).toBe("done");
  });

  it("reopens a later failed turn on the same thread even without observing its recovery", async () => {
    const f = setup();
    const task = f.store.tasks.createTask({
      projectId: f.project.id,
      title: "Repeated execution",
      status: "in_progress",
    });
    f.store.tasks.upsertTaskThread({
      taskId: task.id,
      threadId: "thr_worker",
      title: "Worker",
      presetName: "Synthetic",
      liveStatus: "failed",
    });
    f.state.status = "error";
    const initial = (await f.handlers.listInbox({ state: "open" })).items[0]!;
    await f.handlers.decideInbox({ id: initial.id, action: "resolve" });
    expect((await f.handlers.listInbox({ state: "open" })).items).toEqual([]);
    f.state.failureSeq = 20;
    const newer = (await f.handlers.listInbox({ state: "open" })).items[0]!;
    expect(newer.id).toBe(initial.id);
    expect(newer.revision).not.toBe(initial.revision);
    await f.handlers.decideInbox({ id: newer.id, action: "resolve" });
    const restarted = await f.harness.reload((bb) => {
      registerInbox(bb, createStore(bb), { background: false });
    });
    hosts.push(restarted);
    expect(
      inboxRpcContract.listInbox.output.parse(
        await restarted.harness.callRpc("listInbox", { state: "open" }),
      ).items,
    ).toEqual([]);
    expect(restarted.harness.realtimeSignals).toEqual([]);
  });

  it("keeps an older executor genuinely working despite a newer attachment and stale completion cache", async () => {
    const f = setup();
    const task = f.store.tasks.createTask({
      projectId: f.project.id,
      title: "Concurrent native work",
      status: "in_progress",
    });
    for (const threadId of ["thr_older", "thr_newer"])
      f.store.tasks.upsertTaskThread({
        taskId: task.id,
        threadId,
        title: threadId,
        presetName: "Synthetic",
        liveStatus: threadId === "thr_older" ? "completed" : "idle",
      });
    f.state.threadStatuses.set("thr_older", "active");
    f.state.threadStatuses.set("thr_newer", "idle");
    f.state.runningIds = ["thr_older"];
    expect((await f.handlers.listWorking({})).items).toMatchObject([
      { threadId: "thr_older", taskId: task.id },
    ]);
  });

  it("retains attention on unavailable reads and never calls retired continuation sources blockers", async () => {
    const f = setup();
    const task = f.store.tasks.createTask({
      projectId: f.project.id,
      title: "Transferred review",
      status: "in_review",
    });
    for (const threadId of ["thr_worker", "thr_retired"])
      f.store.tasks.upsertTaskThread({
        taskId: task.id,
        threadId,
        title: threadId,
        presetName: "Synthetic",
        liveStatus: threadId === "thr_retired" ? "failed" : "idle",
      });
    new ExecutionStore(f.store.database).create({
      receipt: {
        operationId: "wtx_inbox_retirement",
        taskId: task.id,
        sourceThreadId: "thr_retired",
        bbProjectId: "proj_synthetic",
        sourceEnvironmentId: "env_source",
        targetHostId: "host_target",
        targetPath: "/synthetic/work",
        presetId: task.id,
        environmentId: "env_target",
        state: "started",
        threadId: "thr_worker",
        lastError: null,
        createdAt: f.state.now,
      },
      request: { includePaths: [] },
      handoff: "Synthetic completed transfer",
    });
    f.state.status = "idle";
    expect((await f.handlers.listInbox({ state: "open" })).items).toMatchObject(
      [{ lane: "review", threadId: "thr_worker" }],
    );
    expect(f.harness.sdk.callsTo("threads.get").flat()).not.toContainEqual({
      threadId: "thr_retired",
    });
    f.state.question = true;
    const pending = (await f.handlers.listInbox({ state: "open" })).items.find(
      (item) => item.sourceKind === "native_interaction",
    )!;
    f.state.questionsUnavailable = true;
    const unavailable = await f.handlers.listInbox({ state: "open" });
    expect(unavailable.warnings[0]).toContain("native questions unavailable");
    expect(unavailable.items.some((item) => item.id === pending.id)).toBe(true);
    expect(
      unavailable.items.some((item) => item.sourceKind === "native_failure"),
    ).toBe(false);
    f.state.unavailable = true;
    expect(
      (await f.handlers.listInbox({ state: "open" })).warnings.some((warning) =>
        warning.includes("native thread state unavailable"),
      ),
    ).toBe(true);
  });

  it("serves CLI and RPC from the same persisted decisions with source-kind guards", async () => {
    const f = setup();
    registerTasksCli(
      f.bb,
      f.store,
      { name: "Tasks", version: "0.3.0" },
      registerJiraSync(f.bb, f.store),
      f.handlers,
    );
    const add = await f.harness.runCli([
      "inbox",
      "add",
      "--title",
      "CLI incoming",
      "--context",
      "personal",
      "--json",
    ]);
    expect(add.exitCode).toBe(0);
    const { item } = inboxRpcContract.createInbox.output.parse(
      JSON.parse(add.stdout),
    );
    expect(
      (await f.handlers.listInbox({ state: "open", context: "personal" }))
        .items,
    ).toMatchObject([{ id: item.id }]);
    expect(
      (
        await f.harness.runCli([
          "inbox",
          "task",
          item.id,
          "--project",
          "IBX",
          "--json",
        ])
      ).exitCode,
    ).toBe(0);
    expect(
      (
        await f.harness.runCli([
          "inbox",
          "task",
          item.id,
          "--project",
          "IBX",
          "--json",
        ])
      ).exitCode,
    ).toBe(0);
    expect(f.store.tasks.listTasks()).toHaveLength(1);
    const imported = await f.harness.runCli([
      "inbox",
      "source",
      "--data",
      JSON.stringify(source),
      "--json",
    ]);
    expect(imported.exitCode).toBe(0);
    const external = inboxRpcContract.upsertInboxSource.output.parse(
      JSON.parse(imported.stdout),
    );
    await f.handlers.decideInbox({ id: external.item.id, action: "resolve" });
    const replay = await f.harness.runCli([
      "inbox",
      "source",
      "--data",
      JSON.stringify(source),
      "--json",
    ]);
    expect(
      inboxRpcContract.upsertInboxSource.output.parse(
        JSON.parse(replay.stdout),
      ),
    ).toMatchObject({ changed: false, item: { state: "resolved" } });
    await expect(
      f.harness.callRpc("upsertInboxSource", {
        ...source,
        sourceKind: "native_interaction",
      }),
    ).rejects.toThrow();
    await expect(
      f.harness.callRpc("upsertInboxSource", {
        ...source,
        sourceUrl: "javascript:alert(1)",
      }),
    ).rejects.toThrow();
  });
});
