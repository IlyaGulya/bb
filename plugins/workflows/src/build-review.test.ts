import Database from "better-sqlite3";
import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachCallThread,
  createRun,
  getCall,
  getRunRequired,
  isWorkerRetired,
  listExpiredTerminalRuns,
  migrations,
  recoverInterruptedRuns,
  settleCall,
  startCall,
} from "./data.js";
import { managedContextStarted, managedWorker } from "./build-review-policy.js";
import { DEFAULT_WORKFLOW_SETTINGS } from "./settings.js";
import {
  buildReviewInspectionSchema,
  buildReviewResultSchema,
  type BuildReviewStart,
} from "./build-review-contract.js";
import { executeWorkflowScript } from "./runtime.js";
import { parseWorkflowSource } from "./parser.js";
import { buildReviewSource, registerBuildReview } from "./build-review.js";
import { createWorkflowService } from "./service.js";
import { verifyBuildReviewWorkspace } from "./build-review-workspace.js";
import plugin from "./server.js";

const databases: Database.Database[] = [];
const hosts: FakePluginHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
  for (const db of databases.splice(0)) db.close();
});
const request: BuildReviewStart = {
  key: "task:1",
  group: "task",
  projectId: "project",
  originThreadId: "thr_origin",
  task: "Owned bounded fixture",
  template: "development-review",
  writer: {
    provider: "codex",
    model: "writer",
    executionContextId: "writer-context",
    modelConnectionId: "personal-cpa",
    reasoningLevel: "medium",
    permissionMode: "full",
    serviceTier: null,
    instructions: "",
  },
  reviewer: {
    provider: "claude",
    model: "reviewer",
    executionContextId: "reviewer-context",
    modelConnectionId: "work-cpa",
    reasoningLevel: "medium",
    permissionMode: "auto",
    serviceTier: null,
    instructions: "",
  },
  smokeCommands: ["platform smoke"],
  uiRequired: true,
  feedback: "",
};
const fixtureRunInput = {
  projectId: "project",
  originThreadId: "thr_origin",
  environmentId: "env_fixture",
  originProvider: "codex",
  originModel: "writer",
  originReasoningLevel: "medium",
  originPermissionMode: "full",
  name: "fixture",
  source: "return null",
  sourceHash: "fixture",
  argsJson: "null",
  settingsJson: JSON.stringify(DEFAULT_WORKFLOW_SETTINGS),
  resumedFromRunId: null,
};
function setup(workerStatus: "idle" | "error" = "idle") {
  const db = new Database(":memory:");
  databases.push(db);
  db.pragma("foreign_keys = ON");
  db.exec(migrations.join("\n"));
  const run = createRun(db, fixtureRunInput);
  db.prepare(
    "INSERT INTO workflow_build_reviews(request_key, group_key, run_id, request_json) VALUES (?, ?, ?, ?)",
  ).run(request.key, request.group, run.id, JSON.stringify(request));
  db.prepare("UPDATE workflow_runs SET status = 'running' WHERE id = ?").run(
    run.id,
  );
  const send = vi.fn(async () => ({
    ok: true as const,
    delivery: "sent" as const,
  }));
  const host = createFakePluginHost({
    pluginId: "workflows",
    sdk: {
      threads: {
        get: async ({ threadId }) =>
          makeThreadResponse({
            id: threadId,
            projectId: request.projectId,
            providerId: "codex",
            environmentId: "env_fixture",
            status: workerStatus,
          }),
        defaultExecutionOptions: async () => ({
          model: "writer",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
          source: "client/thread/start",
        }),
        send,
      },
    },
  });
  hosts.push(host);
  const call = (index: number) =>
    startCall(db, {
      runId: run.id,
      callIndex: index,
      cacheKey: `call-${index}`,
      prompt: "owned fixture",
      options: {
        selection: null,
        outputSchema: null,
        title: null,
        phase: null,
      },
      selection: {
        providerId: "codex",
        model: "writer",
        reasoningLevel: "medium",
        permissionMode: "full",
      },
      replay: null,
    });
  return { db, run: getRunRequired(db, run.id), host, send, call };
}

describe("native managed launch receipts", () => {
  it("deduplicates concurrent launch and plugin restart by durable key", async () => {
    const { db, host } = setup();
    const service = createWorkflowService(host.bb, db);
    const launch = { ...request, key: "another:1", group: "another" };
    const input = {
      projectId: launch.projectId,
      originThreadId: launch.originThreadId,
      source: buildReviewSource(launch),
      args: null,
      resumedFromRunId: null,
      buildReview: launch,
    };
    const [first, duplicate] = await Promise.all([
      service.start(input),
      service.start(input),
    ]);
    expect(duplicate.id).toBe(first.id);
    expect((await createWorkflowService(host.bb, db).start(input)).id).toBe(
      first.id,
    );
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM workflow_build_reviews WHERE request_key = 'another:1'",
        )
        .get(),
    ).toEqual({ count: 1 });
    await expect(
      service.start({
        ...input,
        buildReview: { ...launch, task: "Conflicting task" },
      }),
    ).rejects.toThrow(/different input/);
  });
});

describe("same-model independent native roles", () => {
  it("admits the same Sol version/account, creates a distinct reviewer, and retains both role sessions across Return", async () => {
    const { db, host, send } = setup();
    const profile = { ...request.writer, provider: "acp-omp", model: "bb-cpa/personal-codex/gpt-6.1-sol", executionContextId: "personal", modelConnectionId: "personal-account" };
    const shared: BuildReviewStart = { ...request, key: "same-model:1", group: "same-model", writer: profile, reviewer: { ...profile, instructions: "Independent inspection only; do not modify files" } };
    host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: request.projectId, environmentId: "env_fixture", providerId: profile.provider }));
    host.harness.sdk.stub("threads.defaultExecutionOptions", async () => ({ model: profile.model, reasoningLevel: profile.reasoningLevel, permissionMode: profile.permissionMode, serviceTier: "default", source: "client/thread/start" }));
    const handlers = registerBuildReview(host.bb, db, createWorkflowService(host.bb, db));
    const launched = await handlers.startBuildReview(shared);
    const run = getRunRequired(db, launched.runId);
    const nextCall = (runId: string, callIndex: number) => startCall(db, {
      runId, callIndex, cacheKey: `${runId}:${callIndex}`, prompt: "Bounded role work", options: { selection: null, outputSchema: null, title: null, phase: null },
      selection: { providerId: profile.provider, model: profile.model, reasoningLevel: profile.reasoningLevel, permissionMode: profile.permissionMode }, replay: null,
    });
    let created = 0;
    const fresh = vi.fn(async () => ({ id: `thr_same_model_${++created}` }));
    const plan = nextCall(run.id, 0);
    const writer = await managedWorker(host.bb, db, run, plan, "Plan", fresh);
    attachCallThread(db, plan.id, writer!.id);
    settleCall(db, { id: plan.id, status: "succeeded", result: "Plan", error: null });
    const build = nextCall(run.id, 1);
    expect(await managedWorker(host.bb, db, run, build, "Build", fresh)).toEqual(writer);
    settleCall(db, { id: build.id, status: "succeeded", result: { completed: true }, error: null });
    const review = nextCall(run.id, 2);
    const reviewer = await managedWorker(host.bb, db, run, review, "Independent review", fresh);
    expect(reviewer?.id).not.toBe(writer?.id);
    expect(fresh).toHaveBeenCalledTimes(2);
    db.prepare("UPDATE workflow_runs SET status = 'failed' WHERE id = ?").run(run.id);
    const returned = await handlers.startBuildReview({ ...shared, key: "same-model:2", feedback: "Correct the observed consumer defect" });
    const next = getRunRequired(db, returned.runId);
    expect(await managedWorker(host.bb, db, next, nextCall(next.id, 0), "Return feedback", fresh)).toEqual(writer);
    expect(await managedWorker(host.bb, db, next, nextCall(next.id, 2), "Review returned changes", fresh)).toEqual(reviewer);
    expect(fresh).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, expect.objectContaining({ threadId: writer!.id }));
    expect(send).toHaveBeenNthCalledWith(2, expect.objectContaining({ threadId: writer!.id }));
    expect(send).toHaveBeenNthCalledWith(3, expect.objectContaining({ threadId: reviewer!.id }));
  });
});


describe("batch workflow deletion release", () => {
  it("refuses an active later group without releasing any earlier completed context", async () => {
    const { db, run, host } = setup();
    db.prepare(
      "UPDATE workflow_runs SET status = 'succeeded' WHERE id = ?",
    ).run(run.id);
    const active = createRun(db, fixtureRunInput);
    db.prepare(
      "INSERT INTO workflow_build_reviews(request_key, group_key, run_id, request_json) VALUES (?, ?, ?, ?)",
    ).run(
      "other:1",
      "other",
      active.id,
      JSON.stringify({ ...request, key: "other:1", group: "other" }),
    );
    const handlers = registerBuildReview(
      host.bb,
      db,
      createWorkflowService(host.bb, db),
    );
    expect(() =>
      handlers.releaseBuildReviewContexts({ groups: [request.group, "other"] }),
    ).toThrow(/no contexts/);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM workflow_build_reviews WHERE released = 1",
        )
        .get(),
    ).toEqual({ count: 0 });
    db.prepare("UPDATE workflow_runs SET status = 'failed' WHERE id = ?").run(
      active.id,
    );
    expect(
      await handlers.releaseBuildReviewContexts({
        groups: [request.group, "other"],
      }),
    ).toEqual({ released: true });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM workflow_build_reviews WHERE released = 1",
        )
        .get(),
    ).toEqual({ count: 2 });
    await expect(
      createWorkflowService(host.bb, db).start({
        projectId: request.projectId,
        originThreadId: request.originThreadId,
        source: buildReviewSource(request),
        args: null,
        resumedFromRunId: null,
        buildReview: { ...request, key: "task:after-release" },
      }),
    ).rejects.toThrow(/released/);
  });
});

describe("failed initial writer launch recovery", () => {
  it("permits human Return after a definitive rejected spawn without claiming an existing writer session", async () => {
    const { db, run, host, call } = setup();
    const first = call(0);
    const rejection = Object.assign(
      new Error("Invalid initial provider configuration"),
      { status: 400, code: "invalid_request" },
    );
    await expect(
      managedWorker(host.bb, db, run, first, "plan", async () => {
        throw rejection;
      }),
    ).rejects.toBe(rejection);
    expect(
      db
        .prepare(
          "SELECT state FROM workflow_build_review_deliveries WHERE call_id = ?",
        )
        .get(first.id),
    ).toEqual({ state: "rejected" });
    expect(managedContextStarted(db, request.group)).toBe(false);
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM workflow_build_review_workers")
        .get(),
    ).toEqual({ count: 0 });
    db.prepare("UPDATE workflow_runs SET status = 'failed' WHERE id = ?").run(
      run.id,
    );
    const next = createRun(db, fixtureRunInput);
    db.prepare("UPDATE workflow_runs SET status = 'running' WHERE id = ?").run(
      next.id,
    );
    db.prepare(
      "INSERT INTO workflow_build_reviews(request_key, group_key, run_id, request_json) VALUES (?, ?, ?, ?)",
    ).run(
      "task:2",
      request.group,
      next.id,
      JSON.stringify({
        ...request,
        key: "task:2",
        feedback: "Configuration repaired; retry",
      }),
    );
    const nextCall = startCall(db, {
      runId: next.id,
      callIndex: 0,
      cacheKey: "retry-first-writer",
      prompt: "plan",
      options: {
        selection: null,
        outputSchema: null,
        title: null,
        phase: null,
      },
      selection: {
        providerId: "codex",
        model: "writer",
        reasoningLevel: "medium",
        permissionMode: "full",
      },
      replay: null,
    });
    const spawn = vi.fn(async () => ({ id: "thr_first_accepted_writer" }));
    expect(
      await managedWorker(
        host.bb,
        db,
        getRunRequired(db, next.id),
        nextCall,
        "plan",
        spawn,
      ),
    ).toEqual({ id: "thr_first_accepted_writer" });
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it("does not downgrade an ambiguous network failure into a safe rejected spawn", async () => {
    const { db, run, host, call } = setup();
    const first = call(0);
    await expect(
      managedWorker(host.bb, db, run, first, "plan", async () => {
        throw new Error("Connection lost after request");
      }),
    ).rejects.toThrow(/Connection lost/);
    expect(
      db
        .prepare(
          "SELECT state FROM workflow_build_review_deliveries WHERE call_id = ?",
        )
        .get(first.id),
    ).toEqual({ state: "spawning" });
    expect(managedContextStarted(db, request.group)).toBe(true);
  });
});

describe("first-writer profile repair policy", () => {
  it("allows repaired profile selection before context exists but never swaps an established writer", async () => {
    const { db, run, host } = setup();
    db.prepare("UPDATE workflow_runs SET status = 'failed' WHERE id = ?").run(
      run.id,
    );
    const handlers = registerBuildReview(
      host.bb,
      db,
      createWorkflowService(host.bb, db),
    );
    const repaired = {
      ...request,
      key: "task:2",
      writer: {
        ...request.writer,
        model: "repaired-model",
        executionContextId: "repaired-context",
        modelConnectionId: "repaired-cpa",
      },
      feedback: "Fix the invalid initial profile",
    };
    const next = await handlers.startBuildReview(repaired);
    expect(next.contextStarted).toBe(false);
    db.prepare("UPDATE workflow_runs SET status = 'failed' WHERE id = ?").run(
      next.runId,
    );
    db.prepare(
      "INSERT INTO workflow_build_review_workers(group_key, role, thread_id) VALUES (?, 'writer', 'thr_established_writer')",
    ).run(request.group);
    await expect(
      handlers.startBuildReview({
        ...repaired,
        key: "task:3",
        writer: { ...repaired.writer, modelConnectionId: "replacement" },
      }),
    ).rejects.toThrow(/existing writer/);
    await expect(
      handlers.startBuildReview({
        ...repaired,
        key: "task:3",
        reviewer: { ...repaired.reviewer, executionContextId: "other-context" },
      }),
    ).rejects.toThrow(/existing writer/);
  });
});

describe("managed connection admission", () => {
  it("reaches retained native admission for a gateway model outside the default catalog and preserves the worker on revocation", async () => {
    const { db, run, host } = setup();
    db.prepare("UPDATE workflow_runs SET status = 'failed' WHERE id = ?").run(run.id);
    const launch: BuildReviewStart = {
      ...request,
      key: "gateway:1",
      group: "gateway",
      writer: {
        ...request.writer,
        provider: "acp-omp",
        model: "bb-cpa/personal/gpt-writer",
      },
      reviewer: {
        ...request.reviewer,
        provider: "acp-omp",
        model: "bb-cpa/work/gpt-reviewer",
      },
    };
    let status: "active" | "idle" = "active";
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({
        id: threadId,
        projectId: request.projectId,
        providerId: "acp-omp",
        environmentId: "env_fixture",
        status: threadId === request.originThreadId ? "idle" : status,
      }),
    );
    host.harness.sdk.stub("threads.defaultExecutionOptions", async () => ({
      model: launch.writer.model,
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      source: "client/thread/start",
    }));
    host.harness.sdk.stub("providers.list", async () => [{
      id: "acp-omp",
      available: true,
      readiness: { verification: "unsupported" },
      capabilities: { permissionModes: ["full", "auto"] },
    }]);
    host.harness.sdk.stub("providers.models", async () => ({
      providers: [],
      models: [{
        id: "native-only",
        model: "native-only",
        supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
      }],
      selectedOnlyModels: [],
      modelLoadError: null,
    }));
    host.harness.sdk.stub("threads.spawn", async () =>
      makeThreadResponse({ id: "thr_gateway_writer" }),
    );
    host.harness.sdk.stub("threads.queuedMessages.list", async () => []);
    host.harness.sdk.stub("threads.stop", async () => ({ ok: true }));
    host.harness.sdk.stub("threads.send", async () => {
      throw Object.assign(new Error("Selected connection is revoked"), {
        status: 409,
        code: "model_connection_revoked",
      });
    });
    const service = createWorkflowService(host.bb, db);
    const handlers = registerBuildReview(host.bb, db, service);
    const started = await handlers.startBuildReview(launch);
    const controller = new AbortController();
    const worker = service.runWorker(controller.signal);
    try {
      await vi.waitFor(() =>
        expect(getCall(db, started.runId, 0)).toMatchObject({
          status: "running",
          childThreadId: "thr_gateway_writer",
        }),
      );
      status = "idle";
      service.onThreadIdle("thr_gateway_writer", JSON.stringify("bounded plan"));
      await vi.waitFor(() =>
        expect(service.get(started.runId)).toMatchObject({
          status: "failed",
          error: "Selected connection is revoked",
        }),
      );
      expect(await handlers.inspectBuildReview({ key: launch.key })).toMatchObject({
        contextStarted: true,
        workers: [{ role: "writer", threadId: "thr_gateway_writer" }],
      });
      expect(getCall(db, started.runId, 1)?.resolvedModel).toBe(launch.writer.model);
      expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
    } finally {
      controller.abort();
      await worker;
    }
  });
});

describe("build/review commit identity", () => {
  it("rejects stale commits and reviewer working-tree writes using authoritative host status", async () => {
    const { db, run, call } = setup();
    const build = call(1);
    const evidence = {
      branch: "owned-fixture",
      commit: "a".repeat(40),
      diff: "owned file +1",
      commands: [{ command: "platform smoke", exitCode: 0, output: "passed" }],
      uiEvidence: [],
      limitations: [],
      nextDecision: "Accept or Return",
    };
    settleCall(db, {
      id: build.id,
      status: "succeeded",
      result: evidence,
      error: null,
    });
    let commit = evidence.commit;
    let dirty = false;
    const host = createFakePluginHost({
      pluginId: "workflows",
      sdk: {
        environments: {
          status: async () => ({
            outcome: "available",
            workspace: {
              checkout: {
                kind: "branch",
                branchName: "owned-fixture",
                headSha: commit,
              },
              workingTree: {
                hasUncommittedChanges: dirty,
                state: "clean",
                insertions: 0,
                deletions: 0,
                lineStatsComplete: true,
                fileCount: 0,
                files: [],
              },
              branch: { currentBranch: "owned-fixture", defaultBranch: "main" },
              mergeBase: null,
            },
          }),
        },
      },
    });
    hosts.push(host);
    await expect(
      verifyBuildReviewWorkspace(host.bb, db, run),
    ).resolves.toBeUndefined();
    commit = "b".repeat(40);
    await expect(verifyBuildReviewWorkspace(host.bb, db, run)).rejects.toThrow(
      /authoritative/,
    );
    commit = evidence.commit;
    dirty = true;
    await expect(verifyBuildReviewWorkspace(host.bb, db, run)).rejects.toThrow(
      /uncommitted/,
    );
  });
});

describe("human Return session identity", () => {
  it.each(["idle", "error"] as const)(
    "uses the retained %s writer in a later native run rather than creating another provider session",
    async (status) => {
      const { db, run, host, send, call } = setup(status);
      const first = call(0);
      const spawn = vi.fn(async () => ({ id: "thr_same_writer" }));
      await managedWorker(host.bb, db, run, first, "original plan", spawn);
      attachCallThread(db, first.id, "thr_same_writer");
      settleCall(db, {
        id: first.id,
        status: "succeeded",
        result: "original context",
        error: null,
      });
      db.prepare(
        "UPDATE workflow_runs SET status = 'succeeded' WHERE id = ?",
      ).run(run.id);
      const next = createRun(db, fixtureRunInput);
      db.prepare(
        "UPDATE workflow_runs SET status = 'running' WHERE id = ?",
      ).run(next.id);
      db.prepare(
        "INSERT INTO workflow_build_reviews(request_key, group_key, run_id, request_json) VALUES (?, ?, ?, ?)",
      ).run(
        "task:2",
        request.group,
        next.id,
        JSON.stringify({
          ...request,
          key: "task:2",
          feedback: "Repair the mobile layout",
        }),
      );
      const nextCall = startCall(db, {
        runId: next.id,
        callIndex: 0,
        cacheKey: "return",
        prompt: "Repair the mobile layout",
        options: {
          selection: null,
          outputSchema: null,
          title: null,
          phase: null,
        },
        selection: {
          providerId: "codex",
          model: "writer",
          reasoningLevel: "medium",
          permissionMode: "full",
        },
        replay: null,
      });
      expect(
        await managedWorker(
          host.bb,
          db,
          getRunRequired(db, next.id),
          nextCall,
          "Repair the mobile layout",
          spawn,
        ),
      ).toEqual({ id: "thr_same_writer" });
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "thr_same_writer",
          input: [
            expect.objectContaining({ text: "Repair the mobile layout" }),
          ],
        }),
      );
    },
  );
});
describe("retained native build/review workers", () => {
  it("reuses the same writer for plan and build, suppresses duplicate delivery, and retains it for human Return", async () => {
    const { db, run, host, send, call } = setup();
    const spawn = vi.fn(async () => ({ id: "thr_writer" }));
    const plan = call(0);
    await managedWorker(host.bb, db, run, plan, "plan", spawn);
    attachCallThread(db, plan.id, "thr_writer");
    settleCall(db, {
      id: plan.id,
      status: "succeeded",
      result: "plan",
      error: null,
    });
    expect(isWorkerRetired(db, "thr_writer")).toBe(false);
    const build = call(1);
    expect(
      await managedWorker(
        host.bb,
        db,
        run,
        build,
        "build and real smoke",
        spawn,
      ),
    ).toEqual({ id: "thr_writer" });
    expect(
      await managedWorker(host.bb, db, run, build, "duplicate", spawn),
    ).toEqual({ id: "thr_writer" });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(getCall(db, run.id, 1)?.childThreadId).toBe("thr_writer");
    expect(recoverInterruptedRuns(db)).toEqual([]);
    expect(getCall(db, run.id, 1)?.status).toBe("running");
    expect(
      await managedWorker(host.bb, db, run, build, "restart", spawn),
    ).toEqual({ id: "thr_writer" });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("refuses a retargeted native provider even when its model and execution options still match", async () => {
    const { db, run, host, send, call } = setup();
    const plan = call(0);
    const spawn = vi.fn(async () => ({ id: "thr_writer" }));
    await managedWorker(host.bb, db, run, plan, "plan", spawn);
    host.harness.sdk.stub("threads.get", async () =>
      makeThreadResponse({
        id: "thr_writer",
        providerId: "claude",
        environmentId: "env_fixture",
        status: "idle",
      }),
    );
    await expect(
      managedWorker(host.bb, db, run, call(1), "build", spawn),
    ).rejects.toThrow(/original profile/);
    expect(send).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(db.prepare(
      "SELECT thread_id FROM workflow_build_review_workers WHERE group_key = ? AND role = 'writer'",
    ).get(request.group)).toEqual({ thread_id: "thr_writer" });
  });
  it("fails closed on uncertain follow-up delivery instead of launching a replacement writer", async () => {
    const { db, run, host, send, call } = setup();
    const build = call(1);
    db.prepare(
      "INSERT INTO workflow_build_review_deliveries(call_id, thread_id, state) VALUES (?, 'thr_writer', 'sending')",
    ).run(build.id);
    const spawn = vi.fn(async () => ({ id: "thr_duplicate" }));
    await expect(
      managedWorker(host.bb, db, run, build, "return", spawn),
    ).rejects.toThrow(/uncertain/);
    expect(send).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });
  it("pins terminal runs and workers until acceptance releases their group", async () => {
    const { db, run, host, call } = setup();
    const plan = call(0);
    await managedWorker(host.bb, db, run, plan, "plan", async () => ({
      id: "thr_writer",
    }));
    attachCallThread(db, plan.id, "thr_writer");
    settleCall(db, {
      id: plan.id,
      status: "succeeded",
      result: "plan",
      error: null,
    });
    db.prepare(
      "UPDATE workflow_runs SET status = 'succeeded', notification_sent = 1, finished_at = 1 WHERE id = ?",
    ).run(run.id);
    expect(listExpiredTerminalRuns(db, Date.now(), 20).runIds).toEqual([]);
    expect(isWorkerRetired(db, "thr_writer")).toBe(false);
    db.prepare("UPDATE workflow_build_reviews SET released = 1").run();
    expect(listExpiredTerminalRuns(db, Date.now(), 20).runIds).toEqual([
      run.id,
    ]);
    expect(isWorkerRetired(db, "thr_writer")).toBe(true);
  });
  it("refuses missing actual smoke evidence before invoking a reviewer", async () => {
    const parsed = parseWorkflowSource(buildReviewSource(request));
    const agent = vi
      .fn()
      .mockResolvedValueOnce("plan")
      .mockResolvedValueOnce({
        commands: [{ command: "unit tests", exitCode: 0 }],
        uiEvidence: [],
      });
    await expect(
      executeWorkflowScript({
        body: parsed.body,
        args: {
          task: request.task,
          feedback: "",
          smokeCommands: request.smokeCommands,
          uiRequired: true,
        },
        capabilities: { agent, phase() {}, log() {} },
      }),
    ).rejects.toThrow(/Missing required real smoke/);
    expect(agent).toHaveBeenCalledTimes(2);
  });
});

describe("shipped bugfix workflow evidence gates", () => {
  const reproduction = { summary: "Consumer failure reproduced before editing", command: "reproduce-bug", exitCode: 1, output: "Expected consumer error" };
  const fixed = {
    branch: "owned-fix", commit: "a".repeat(40), diff: "Fix the reproduced consumer failure",
    commands: [
      { command: "reproduce-bug", exitCode: 0, output: "Consumer request now succeeds" },
      { command: "consumer-regression", exitCode: 0, output: "Regression succeeds" },
      { command: "platform smoke", exitCode: 0, output: "Real platform checks observed" },
    ],
    regressionCommand: "consumer-regression", uiEvidence: [], limitations: [], nextDecision: "Human review",
  };
  async function execute(reproduced = reproduction, build = fixed, previousReproduction: typeof reproduction | null = null) {
    const agent = vi.fn().mockResolvedValueOnce(reproduced).mockResolvedValueOnce(build).mockResolvedValueOnce({ verdict: "ready", findings: [], summary: "Independent inspection complete" });
    const result = executeWorkflowScript({
      body: parseWorkflowSource(buildReviewSource({ ...request, template: "bugfix", uiRequired: false })).body,
      args: { task: request.task, feedback: "", smokeCommands: request.smokeCommands, uiRequired: false, previousReproduction },
      capabilities: { agent, phase() {}, log() {} },
    });
    return { result, agent };
  }
  it("retains failing-before and passing-after evidence in the human-review result", async () => {
    const { result, agent } = await execute();
    const parsed = buildReviewResultSchema.parse(await result);
    expect(JSON.parse(parsed.plan)).toEqual(reproduction);
    expect(parsed.build.commands).toEqual(fixed.commands);
    expect(parsed.review.verdict).toBe("ready");
    expect(agent).toHaveBeenCalledTimes(3);
  });
  it("stops before a fix when the bug was not actually reproduced", async () => {
    const { result, agent } = await execute({ ...reproduction, exitCode: 0 });
    await expect(result).rejects.toThrow(/failing-before/);
    expect(agent).toHaveBeenCalledTimes(1);
  });
  it.each(["reproduce-bug", "consumer-regression", "platform smoke"])("refuses missing %s evidence before independent review", async missing => {
    const { result, agent } = await execute(reproduction, { ...fixed, commands: fixed.commands.filter(command => command.command !== missing) });
    await expect(result).rejects.toThrow(/Missing/);
    expect(agent).toHaveBeenCalledTimes(2);
  });
  it("never publishes a passing review when the original failure still fails", async () => {
    const { result, agent } = await execute(reproduction, { ...fixed, commands: fixed.commands.map(command => command.command === "reproduce-bug" ? { ...command, exitCode: 1 } : command) });
    await expect(result).rejects.toThrow(/failed/);
    expect(agent).toHaveBeenCalledTimes(2);
  });
  it("refuses a fabricated replacement of the original failing-before evidence on human Return", async () => {
    const changed = { ...reproduction, command: "different-bug", output: "Unrelated failure" };
    const build = { ...fixed, commands: [{ command: changed.command, exitCode: 0, output: "Unrelated check passes" }, ...fixed.commands.slice(1)] };
    const { result, agent } = await execute(changed, build, reproduction);
    await expect(result).rejects.toThrow(/original genuine reproduction/);
    expect(agent).toHaveBeenCalledTimes(1);
  });
});

describe("managed structured-result native handoff", () => {
  async function setupHandoff() {
    const native: {
      status: "active" | "stopping" | "idle" | "error";
      spawns: number;
      continuations: string[];
    } = { status: "active", spawns: 0, continuations: [] };
    let host = createFakePluginHost({
      pluginId: "workflows",
      agentSkillIds: ["workflows"],
      sdk: {
        threads: {
          get: async ({ threadId }) => makeThreadResponse({
            id: threadId,
            projectId: request.projectId,
            providerId: request.writer.provider,
            environmentId: "env_fixture",
            status: threadId === request.originThreadId ? "idle" : native.status,
          }),
          list: async () => [],
          defaultExecutionOptions: async () => ({
            model: request.writer.model,
            reasoningLevel: request.writer.reasoningLevel,
            permissionMode: request.writer.permissionMode,
            serviceTier: "default",
            source: "client/thread/start",
          }),
          spawn: async () => makeThreadResponse({ id: `thr_handoff_${++native.spawns}` }),
          queuedMessages: { list: async () => [] },
          output: async () => ({ output: null }),
          send: async ({ threadId }) => {
            if (native.status !== "idle") throw new Error("Native worker is still busy");
            native.continuations.push(threadId);
            native.status = "active";
            return { ok: true, delivery: "sent" };
          },
          stop: async () => {
            native.status = "stopping";
            return { ok: true };
          },
        },
      },
    });
    hosts.push(host);
    await plugin(host.bb);
    let db = host.bb.storage.database();
    const launch = buildReviewInspectionSchema.parse(
      await host.harness.callRpc("startBuildReview", request),
    );
    let worker = host.harness.runService("workflow-worker");
    const writerId = "thr_handoff_1";
    await vi.waitFor(() => expect(getCall(db, launch.runId, 0)).toMatchObject({
      status: "running",
      childThreadId: writerId,
    }), { timeout: 4000 });
    return {
      get db() { return db; },
      native,
      launch,
      writerId,
      submit: () => host.harness.callAgentTool(
        "bb_workflow_result",
        { value: "bounded plan" },
        { threadId: writerId, projectId: request.projectId },
      ),
      async idle() {
        native.status = "idle";
        const event = {
          thread: makeThreadResponse({ id: writerId, status: "idle" }),
          lastAssistantText: null,
        };
        await Promise.all([
          host.harness.emitThreadEvent("thread.idle", event),
          host.harness.emitThreadEvent("thread.idle", event),
        ]);
      },
      fail: () => host.harness.emitThreadEvent("thread.failed", {
        thread: makeThreadResponse({ id: writerId, status: "error" }),
        error: "Native writer failed before idle",
      }),
      cancel: () => host.harness.callRpc("workflowStopRun", {
        threadId: request.originThreadId,
        runId: launch.runId,
      }),
      async restart(status: "stopping" | "error") {
        worker.controller.abort();
        await worker.done;
        expect(getCall(db, launch.runId, 0)).toMatchObject({
          status: "running",
          resultJson: '"bounded plan"',
        });
        native.status = status;
        const replacement = await host.harness.reload(plugin);
        hosts[hosts.indexOf(host)] = replacement;
        host = replacement;
        db = host.bb.storage.database();
        worker = host.harness.runService("workflow-worker");
      },
      async dispose() {
        worker.controller.abort();
        await worker.done;
      },
    };
  }

  it("acknowledges a stored plan while native work continues, then delivers Build once after idle", async () => {
    const test = await setupHandoff();
    try {
      await expect(test.submit()).resolves.toBe(JSON.stringify({ accepted: true }, null, 2));
      await expect(test.submit()).resolves.toBe(JSON.stringify({ accepted: true }, null, 2));
      expect(getCall(test.db, test.launch.runId, 0)).toMatchObject({
        status: "running",
        resultJson: '"bounded plan"',
      });
      expect(getCall(test.db, test.launch.runId, 1)).toBeNull();
      expect(test.native.continuations).toEqual([]);
      await test.idle();
      await vi.waitFor(() => expect(getCall(test.db, test.launch.runId, 1)).toMatchObject({
        status: "running",
        childThreadId: test.writerId,
      }), { timeout: 4000 });
      expect(getCall(test.db, test.launch.runId, 0)?.status).toBe("succeeded");
      expect(test.native.continuations).toEqual([test.writerId]);
      expect(test.native.spawns).toBe(1);
    } finally {
      await test.dispose();
    }
  });

  it.each(["failure", "cancellation"] as const)(
    "%s after result acceptance cannot be converted into success by a late idle or duplicate result",
    async (boundary) => {
      const test = await setupHandoff();
      try {
        await test.submit();
        if (boundary === "failure") await test.fail();
        else await test.cancel();
        const status = boundary === "failure" ? "failed" : "cancelled";
        await vi.waitFor(() => expect(getRunRequired(test.db, test.launch.runId).status).toBe(status), { timeout: 4000 });
        await test.idle();
        await expect(test.submit()).resolves.toMatchObject({ isError: true });
        expect(getCall(test.db, test.launch.runId, 0)).toMatchObject({
          status,
          resultJson: '"bounded plan"',
        });
        expect(getCall(test.db, test.launch.runId, 1)).toBeNull();
        expect(test.native.continuations).toEqual([]);
        expect(test.native.spawns).toBe(1);
      } finally {
        await test.dispose();
      }
    },
  );

  it.each(["stopping", "error"] as const)(
    "reconciles a stored plan after restart with a native worker still %s without replaying an unconfirmed success",
    async (status) => {
      const test = await setupHandoff();
      try {
        await test.submit();
        await test.restart(status);
        if (status === "error") {
          await vi.waitFor(() => expect(getRunRequired(test.db, test.launch.runId)).toMatchObject({
            status: "failed",
            error: "Workflow worker is in an error state",
          }), { timeout: 4000 });
          await test.idle();
          expect(getCall(test.db, test.launch.runId, 0)).toMatchObject({
            status: "failed",
            resultJson: '"bounded plan"',
          });
          expect(getCall(test.db, test.launch.runId, 1)).toBeNull();
          expect(test.native.continuations).toEqual([]);
        } else {
          await vi.waitFor(() => expect(getRunRequired(test.db, test.launch.runId).status).toBe("running"), { timeout: 4000 });
          expect(getCall(test.db, test.launch.runId, 0)?.status).toBe("running");
          expect(getCall(test.db, test.launch.runId, 1)).toBeNull();
          await test.idle();
          await vi.waitFor(() => expect(getCall(test.db, test.launch.runId, 1)).toMatchObject({
            status: "running",
            childThreadId: test.writerId,
          }), { timeout: 4000 });
          expect(test.native.continuations).toEqual([test.writerId]);
        }
        expect(test.native.spawns).toBe(1);
      } finally {
        await test.dispose();
      }
    },
  );
});
