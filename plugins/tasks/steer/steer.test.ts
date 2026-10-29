import {
  createFakePluginHost,
  makeThreadResponse,
  makeHostResponse,
} from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { deliverCommentToLatestAgent } from ".";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createComment, createStore, registerTasksApi } from "../api/index.js";
import { tasksRpcContract } from "../shared/contract.js";
import { registerTaskWorkflows, releaseTaskWorkflowContexts } from "../workflow/index.js";
import { TaskWorkflowStore } from "../workflow/store.js";
import { HELD_WORKFLOW_STATES, seedWorkflowOwnership } from "../workflow/ownership.test-fixtures.js";
import { buildReviewStartSchema, type BuildReviewStart } from "../../workflows/src/build-review-contract.js";
import type { WorkflowSelection } from "../shared/workflow-preparation.js";

const notificationHosts: Array<ReturnType<typeof createFakePluginHost>> = [];
afterEach(async () => {
  await Promise.all(notificationHosts.splice(0).map(host => host.harness.dispose()));
});

function setup(
  getThread: (threadId: string) => ReturnType<typeof makeThreadResponse> = (
    threadId,
  ) => makeThreadResponse({ id: threadId, status: "active" }),
) {
  const host = createFakePluginHost({
    pluginId: "tasks",
    sdk: {
      threads: {
        get: async ({ threadId }) => getThread(threadId),
        send: async () => undefined,
      },
    },
  });
  const store = createStore(host.bb);
  const db = store.database;
  const project = store.tasks.createProject({
    name: "Plugin",
    prefix: "PLUG",
    color: "blue",
  });
  const task = store.tasks.createTask({ projectId: project.id, title: "Steer work" });
  return { ...host, db, store, task };
}

const input = {
  commentId: "01J00000000000000000000000",
  authorName: "Sawyer",
  body: "Please include the regression test.",
};

describe("comment notification delivery", () => {
  it("notifies only the latest replying agent despite newer unrelated task activity", async () => {
    const { bb, db, harness, store, task } = setup();
    const older = store.tasks.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "First agent",
      threadId: "thr_first",
      body: "First reply",
    });
    const latest = store.tasks.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "Second agent",
      threadId: "thr_second",
      body: "Latest reply",
    });
    store.tasks.upsertTaskThread({
      taskId: task.id,
      threadId: "thr_second",
      presetName: "Default",
      title: "Second agent",
      liveStatus: "working",
    });
    const unrelated = store.tasks.upsertTaskThread({
      taskId: task.id,
      threadId: "thr_first",
      presetName: "Default",
      title: "First agent",
      liveStatus: "working",
    });
    db.prepare("UPDATE comments SET created_at = ? WHERE id = ?").run(
      "2026-07-16T10:00:00.000Z",
      older.id,
    );
    db.prepare("UPDATE comments SET created_at = ? WHERE id = ?").run(
      "2026-07-16T11:00:00.000Z",
      latest.id,
    );
    db.prepare("UPDATE task_threads SET updated_at = ? WHERE id = ?").run(
      "2026-07-16T12:00:00.000Z",
      unrelated.id,
    );

    await expect(
      deliverCommentToLatestAgent(bb, store, { taskId: task.id, ...input }),
    ).resolves.toBe(1);
    expect(harness.sdk.callsTo("threads.send")).toEqual([
      [
        {
          threadId: "thr_second",
          input: [
            {
              type: "text",
              text:
                "New comment on task PLUG-1 from Sawyer: Please include the regression test.\n\n" +
                "Treat this as updated context for your work on this task; reply via bb tasks comment PLUG-1 when relevant.",
              mentions: [],
            },
          ],
          mode: "steer-if-active",
        },
      ],
    ]);
  });

  it("uses resume-capable delivery for an idle latest responder", async () => {
    const { bb, harness, store, task } = setup((threadId) =>
      makeThreadResponse({ id: threadId, status: "idle" }),
    );
    store.tasks.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "Idle agent",
      threadId: "thr_idle",
      body: "Ready for more context",
    });

    await expect(
      deliverCommentToLatestAgent(bb, store, { taskId: task.id, ...input }),
    ).resolves.toBe(1);
    expect(harness.sdk.callsTo("threads.send")).toEqual([
      [
        expect.objectContaining({
          threadId: "thr_idle",
          mode: "steer-if-active",
        }),
      ],
    ]);
  });

  it("does nothing when no agent has replied", async () => {
    const { bb, harness, store, task } = setup();

    await expect(
      deliverCommentToLatestAgent(bb, store, { taskId: task.id, ...input }),
    ).resolves.toBe(0);
    expect(harness.sdk.callsTo("threads.get")).toEqual([]);
    expect(harness.sdk.callsTo("threads.send")).toEqual([]);
  });

  it("does not fall back when the latest agent reply has no thread", async () => {
    const { bb, harness, store, task } = setup();
    store.tasks.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "Older linked agent",
      threadId: "thr_older",
      body: "Older reply",
    });
    store.tasks.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "Legacy agent",
      body: "Latest unlinked reply",
    });

    await expect(
      deliverCommentToLatestAgent(bb, store, { taskId: task.id, ...input }),
    ).resolves.toBe(0);
    expect(harness.sdk.callsTo("threads.get")).toEqual([]);
    expect(harness.sdk.callsTo("threads.send")).toEqual([]);
  });

  it("preserves side-chat privacy and does not fall back", async () => {
    const { bb, harness, store, task } = setup((threadId) =>
      makeThreadResponse({
        id: threadId,
        status: "idle",
        originKind: "fork",
        originPluginId: "side-chat",
        visibility: "hidden",
      }),
    );
    store.tasks.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "Side chat",
      threadId: "thr_side_chat",
      body: "Private reply",
    });

    await expect(
      deliverCommentToLatestAgent(bb, store, { taskId: task.id, ...input }),
    ).resolves.toBe(0);
    expect(harness.sdk.callsTo("threads.get")).toEqual([
      [{ threadId: "thr_side_chat" }],
    ]);
    expect(harness.sdk.callsTo("threads.send")).toEqual([]);
  });

  it("records delivery failure without trying another agent", async () => {
    const { bb, harness, store, task } = setup();
    store.tasks.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "Latest agent",
      threadId: "thr_latest",
      body: "Latest reply",
    });
    harness.sdk.stub("threads.send", async () => {
      throw Object.assign(new Error("thread awaiting interaction"), {
        status: 409,
      });
    });

    await expect(
      deliverCommentToLatestAgent(bb, store, { taskId: task.id, ...input }),
    ).resolves.toBe(0);
    expect(harness.sdk.callsTo("threads.send")).toHaveLength(1);
    expect(harness.logEntries).toContainEqual({
      level: "warn",
      message:
        "failed to deliver comment 01J00000000000000000000000 to thread thr_latest: thread awaiting interaction",
    });
  });
});

function notificationGate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function notificationFixture() {
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const metadata = new Map<string, NonNullable<Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0]["pluginMetadata"]>>();
  const effects: Array<{ threadId: string; kind: "new-turn" | "steer" }> = [];
  const nativeStarts: BuildReviewStart[] = [];
  let responderId = "thr_notification_latest";
  let lookupPause: { entered: ReturnType<typeof notificationGate>; gate: ReturnType<typeof notificationGate> } | null = null;
  let startPause: { entered: ReturnType<typeof notificationGate>; gate: ReturnType<typeof notificationGate> } | null = null;
  let idleAfterSnapshot = false;
  let preparedThreads = 0;
  const host = createFakePluginHost({ pluginId: "tasks", sdk: {
    hosts: { list: async () => [makeHostResponse({ id: "host_notification", name: "Owned notification host" })] },
    experimental_executionContexts: { list: async () => [{ id: "notification-context", name: "Owned context", enabled: true, projectIds: ["proj_notification"] }] },
    experimental_modelConnections: { list: async () => [{ id: "notification-account", name: "Owned model account", provider: "acp-omp", hostId: null, gateway: { allowedHostIds: ["host_notification"] }, enabled: true, revoked: false }] },
    providers: { models: async () => ({ models: [{ id: "bb-cpa/personal-codex/gpt-6.1-sol", model: "bb-cpa/personal-codex/gpt-6.1-sol", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }], selectedOnlyModels: [], modelLoadError: null }) },
    environments: {
      get: async () => ({ id: "env_notification", hostId: "host_notification", projectId: "proj_notification", path: "/owned/notification-workflow", status: "ready", lifecycle: { phase: "active" }, hostLifecycle: "active" }),
      status: async () => ({ outcome: "available", workspace: { checkout: { kind: "branch", branchName: "owned-notification", headSha: "a".repeat(40) }, workingTree: { hasUncommittedChanges: false } } }),
    },
    threads: {
      get: async ({ threadId }) => {
        if (threadId === responderId && lookupPause) {
          const paused = lookupPause;
          lookupPause = null;
          paused.entered.release();
          await paused.gate.promise;
        }
        const thread = threads.get(threadId);
        if (!thread) throw new Error(`Unknown owned thread ${threadId}`);
        if (threadId === responderId && idleAfterSnapshot) threads.set(threadId, { ...thread, status: "idle" });
        return thread;
      },
      list: async ({ environmentId, projectId } = {}) => [...threads.values()].filter(thread => (!environmentId || thread.environmentId === environmentId) && (!projectId || thread.projectId === projectId)),
      getPluginMetadata: async ({ threadId }) => metadata.get(threadId) ?? {},
      spawn: async args => {
        if (!args.preparationOnly) throw new Error("Only zero-turn preparation is permitted in this fixture");
        const thread = makeThreadResponse({ id: `thr_notification_prepared_${++preparedThreads}`, projectId: "proj_notification", environmentId: "env_notification", providerId: args.providerId, originPluginId: "tasks" });
        threads.set(thread.id, thread);
        metadata.set(thread.id, args.pluginMetadata ?? {});
        return thread;
      },
      send: async ({ threadId }) => {
        const thread = threads.get(threadId);
        if (!thread) throw new Error(`Unknown owned notification target ${threadId}`);
        effects.push({ threadId, kind: thread.status === "active" ? "steer" : "new-turn" });
        threads.set(threadId, { ...thread, status: "active" });
        return { ok: true, delivery: "sent" };
      },
    },
    plugins: { callRpc: async args => {
      if (args.method === "releaseBuildReviewContexts") return { released: true };
      if (args.method !== "startBuildReview") throw new Error(`Unexpected workflow RPC ${args.method}`);
      const request = buildReviewStartSchema.parse(args.input);
      nativeStarts.push(request);
      if (startPause) {
        const paused = startPause;
        startPause = null;
        paused.entered.release();
        await paused.gate.promise;
      }
      return { runId: "notification-native-run", key: request.key, contextStarted: false, status: "queued", phase: null, error: null, result: null, workers: [], policyLimitations: [] };
    } },
  } });
  notificationHosts.push(host);
  const api = createStore(host.bb);
  registerTasksApi(host.bb, api);
  const workflows = registerTaskWorkflows(host.bb, api, { background: false });
  const project = api.tasks.createProject({ name: "Notification ownership", prefix: "NOTIFY", color: "blue", linkedBbProjectId: "proj_notification" });
  const task = api.tasks.createTask({ projectId: project.id, title: "Persist context without starting a competing writer" });
  const body = "Keep this task context without starting independent work.";
  function reply(status: "idle" | "error" | "active" = "idle", threadId = "thr_notification_latest", sideChat = false) {
    responderId = threadId;
    threads.set(threadId, makeThreadResponse({ id: threadId, projectId: "proj_notification", environmentId: "env_notification_legacy", status, ...(sideChat ? { originKind: "fork", originPluginId: "side-chat", visibility: "hidden" } : {}) }));
    api.tasks.upsertTaskThread({ taskId: task.id, threadId, presetName: "Existing responder", title: "Existing responder", liveStatus: "idle" });
    return api.tasks.createComment({ taskId: task.id, kind: "agent", authorName: "Existing responder", threadId, body: "Previous agent reply" });
  }
  function own(state: typeof HELD_WORKFLOW_STATES[number] | "failed") {
    const owner = seedWorkflowOwnership(api, task.id, "proj_notification", state === "failed" ? "sending" : state);
    if (state === "failed") owner.workflows.publish(owner.request.group, { runId: "failed-notification-native", key: owner.request.key, contextStarted: false, status: "failed", phase: null, error: "Definitive native failure; ownership retained", result: null, workers: [], policyLimitations: [] });
    return { ...owner, view: owner.workflows.get(owner.request.group) };
  }
  async function post(path: "awaited" | "queued RPC") {
    if (path === "awaited") return createComment(host.bb, api, { taskId: task.id, kind: "user", authorName: "You", presetName: null, threadId: null, body, notify: true, awaitDelivery: true });
    return tasksRpcContract.createComment.output.parse(await host.harness.callRpc("createComment", { taskId: task.id, body, notify: true })).comment;
  }
  async function settle() {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  async function prepare() {
    const role = { provider: "acp-omp", model: "bb-cpa/personal-codex/gpt-6.1-sol", executionContextId: "notification-context", modelConnectionId: "notification-account", reasoningLevel: "high", permissionMode: "full" as const, serviceTier: null, instructions: "Owned workflow role" };
    const selection: WorkflowSelection = { template: "development-review", hostId: "host_notification", baseBranch: "", writer: role, reviewer: { ...role, instructions: "Fresh independent review" }, smokeCommands: ["owned-notification-smoke"], uiRequired: false };
    const draft = await workflows.saveTaskWorkflowDraft({ taskId: task.id, revision: 0, selection });
    await workflows.prepareTaskWorkflow({ taskId: task.id, revision: draft.revision });
    const prepared = await workflows.getTaskWorkflowPreparation({ taskId: task.id });
    if (!prepared || prepared.state !== "ready") throw new Error("Owned workflow preparation did not become ready");
    return { taskId: task.id, preparationId: prepared.id };
  }
  function pauseLookup() {
    const paused = { entered: notificationGate(), gate: notificationGate() };
    lookupPause = paused;
    return { entered: paused.entered.promise, release: paused.gate.release };
  }
  function pauseStart() {
    const paused = { entered: notificationGate(), gate: notificationGate() };
    startPause = paused;
    return { entered: paused.entered.promise, release: paused.gate.release };
  }
  return { ...host, api, task, body, effects, nativeStarts, threads, reply, own, post, settle, prepare, workflows, pauseLookup, pauseStart, idleAfterLookup: () => { idleAfterSnapshot = true; } };
}

describe.each(["awaited", "queued RPC"] as const)("owned task comment notification through %s", path => {
  it.each([...HELD_WORKFLOW_STATES, "failed"] as const)("persists a comment without resuming the non-owning latest responder while workflow ownership is %s", async state => {
    const fixture = notificationFixture();
    const owner = fixture.own(state);
    fixture.reply(state === "failed" ? "error" : "idle");
    const comment = await fixture.post(path);
    await fixture.settle();
    expect(fixture.api.tasks.getComment(comment.id)).toMatchObject({ taskId: fixture.task.id, body: fixture.body, kind: "user", notifiedCount: 0 });
    expect(fixture.harness.sdk.callsTo("threads.send")).toEqual([]);
    expect(fixture.harness.sdk.callsTo("threads.spawn")).toEqual([]);
    expect(fixture.effects).toEqual([]);
    expect(owner.workflows.get(owner.request.group)).toEqual(owner.view);
  });

  it("does not auto-notify an owning writer whose active snapshot becomes idle before native delivery", async () => {
    const fixture = notificationFixture();
    const owner = fixture.own("in_review");
    fixture.reply("active", "thr_ownedretainedwriter");
    fixture.idleAfterLookup();
    const comment = await fixture.post(path);
    await fixture.settle();
    expect(fixture.api.tasks.getComment(comment.id)).toMatchObject({ body: fixture.body, notifiedCount: 0 });
    expect(fixture.harness.sdk.callsTo("threads.send")).toEqual([]);
    expect(fixture.effects).toEqual([]);
    expect(owner.workflows.get(owner.request.group)).toEqual(owner.view);
  });

  it("persists context without native delivery while Start holds the task lock awaiting its native acknowledgement", async () => {
    const fixture = notificationFixture();
    const launch = await fixture.prepare();
    fixture.reply();
    const paused = fixture.pauseStart();
    const starting = Promise.resolve(fixture.workflows.launchTaskWorkflow(launch)).then(value => ({ value, error: null }), error => ({ value: null, error }));
    try {
      await paused.entered;
      const request = fixture.nativeStarts[0];
      if (!request) throw new Error("Start reached no native ownership boundary");
      const owner = new TaskWorkflowStore(fixture.api);
      const held = owner.get(request.group);
      expect(held.state).toBe("launching");
      const comment = await fixture.post(path);
      await fixture.settle();
      expect(fixture.api.tasks.getComment(comment.id)).toMatchObject({ body: fixture.body, notifiedCount: 0 });
      expect(fixture.harness.sdk.callsTo("threads.send")).toEqual([]);
      expect(fixture.effects).toEqual([]);
      expect(owner.get(request.group)).toEqual(held);
    } finally {
      paused.release();
      await starting;
    }
    expect(await starting).toMatchObject({ error: null, value: { state: "running", native: { status: "queued" } } });
  });

  it("keeps Start from claiming ownership while an earlier comment notification holds its native target lookup", async () => {
    const fixture = notificationFixture();
    const launch = await fixture.prepare();
    fixture.reply();
    const paused = fixture.pauseLookup();
    const posting = fixture.post(path);
    try {
      await paused.entered;
      const starting = await Promise.resolve(fixture.workflows.launchTaskWorkflow(launch)).then(value => ({ value, error: null }), error => ({ value: null, error }));
      expect(starting.error).toBeInstanceOf(Error);
      expect(fixture.api.database.prepare("SELECT id FROM task_workflow_runs WHERE task_id = ?").all(fixture.task.id)).toEqual([]);
      expect(fixture.nativeStarts).toEqual([]);
    } finally {
      paused.release();
      await posting;
      await fixture.settle();
    }
    const comment = await posting;
    expect(fixture.api.tasks.getComment(comment.id)).toMatchObject({ body: fixture.body, notifiedCount: 1 });
    expect(fixture.effects).toEqual([{ threadId: "thr_notification_latest", kind: "new-turn" }]);
    const responder = fixture.threads.get("thr_notification_latest");
    if (!responder) throw new Error("Legacy notification lost its native responder");
    fixture.threads.set(responder.id, { ...responder, status: "idle" });
    const started = await fixture.workflows.launchTaskWorkflow(launch);
    expect(started).toMatchObject({ state: "running", native: { status: "queued" } });
  });

  it.each(["idle", "error", "active"] as const)("preserves unmanaged notification delivery to a latest responder in %s", async status => {
    const fixture = notificationFixture();
    fixture.reply(status);
    const comment = await fixture.post(path);
    await fixture.settle();
    expect(fixture.api.tasks.getComment(comment.id)).toMatchObject({ taskId: fixture.task.id, body: fixture.body, notifiedCount: 1 });
    expect(fixture.effects).toEqual([{ threadId: "thr_notification_latest", kind: status === "active" ? "steer" : "new-turn" }]);
  });

  it.each(["accepted", "released"] as const)("preserves notification delivery after proven workflow %s", async state => {
    const fixture = notificationFixture();
    const owner = fixture.own(state === "accepted" ? "in_review" : "failed");
    if (state === "accepted") {
      owner.workflows.accept(owner.request.group, owner.view.revision);
      expect(owner.workflows.get(owner.request.group).state).toBe("accepted");
    } else {
      await releaseTaskWorkflowContexts(fixture.bb, fixture.api, [fixture.task.id]);
      expect(fixture.api.database.prepare("SELECT released FROM task_workflow_runs WHERE id = ?").get(owner.request.group)).toEqual({ released: 1 });
    }
    fixture.reply();
    const comment = await fixture.post(path);
    await fixture.settle();
    expect(fixture.api.tasks.getComment(comment.id)).toMatchObject({ body: fixture.body, notifiedCount: 1 });
    expect(fixture.effects).toEqual([{ threadId: "thr_notification_latest", kind: "new-turn" }]);
  });

  it.each(["missing", "unlinked latest", "side-chat latest"] as const)("persists context without falling back to an older responder when the target is %s", async target => {
    const fixture = notificationFixture();
    if (target !== "missing") {
      fixture.reply("idle", "thr_notification_older");
      if (target === "unlinked latest") fixture.api.tasks.createComment({ taskId: fixture.task.id, kind: "agent", authorName: "Unlinked agent", threadId: null, body: "Latest reply without a thread" });
      else fixture.reply("idle", "thr_notification_sidechat", true);
    }
    const comment = await fixture.post(path);
    await fixture.settle();
    expect(fixture.api.tasks.getComment(comment.id)).toMatchObject({ taskId: fixture.task.id, body: fixture.body, notifiedCount: 0 });
    expect(fixture.harness.sdk.callsTo("threads.send")).toEqual([]);
    expect(fixture.effects).toEqual([]);
  });
});
