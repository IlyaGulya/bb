import { EventEmitter, once } from "node:events";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createStore } from "../api";
import { JiraStore } from "../jira/store";
import { handlers, registerDelegation } from ".";
import { delegationRpcContract } from "./contract";
import { ExecutionStore } from "./execution-store";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});

function setup() {
  const state = {
    sourceStatus: "idle" as "idle" | "active",
    providerAvailable: true,
    environmentProject: "proj_code",
    transferError: null as Error | null,
    spawnError: null as string | null,
    spawned: false,
    spawnAmbiguous: false,
    sensitiveTracked: false,
    transferGate: null as Promise<void> | null,
    checkpoint: "",
  };
  const ready = {
    operationId: "transfer_fixture",
    status: "ready" as const,
    projectId: "proj_code",
    sourceEnvironmentId: "env_source",
    sourceHostId: "host_source",
    targetHostId: "host_target",
    targetPath: "/work/continued",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    environmentId: "env_target",
    hostId: "host_target",
    rootPath: "/work/continued",
    head: "1234567",
    branch: "task/continue",
    handoff:
      "Verified HEAD 1234567, staged binary and local-only commit restored.",
  };
  const environment = (environmentId: string) => ({
    id: environmentId,
    projectId: state.environmentProject,
    hostId: environmentId === "env_source" ? "host_source" : "host_target",
    status: "ready",
    lifecycle: { phase: "active" },
    hostLifecycle: "active",
    path: "/work/code",
    name: null,
  });
  const { bb, harness } = createFakePluginHost({
    pluginId: "tasks",
    sdk: {
      hosts: {
        list: async () => [
          { id: "host_source", name: "Source" },
          { id: "host_target", name: "Target" },
        ],
      },
      providers: {
        list: async () => [{ id: "codex", available: state.providerAvailable }],
      },
      projects: {
        get: async () => ({
          sources: [
            {
              type: "local_path",
              hostId: "host_target",
              path: "/work/code",
              isDefault: true,
            },
          ],
        }),
        previewWorkspaceTransfer: async () => ({
          sourceEnvironmentId: "env_source",
          sourceHostId: "host_source",
          head: "1234567",
          branch: "task/source",
          files: [
            {
              path: "tracked.bin",
              kind: "tracked",
              tracked: true,
              selectedByDefault: true,
            },
            {
              path: "extra.bin",
              kind: "untracked",
              tracked: false,
              selectedByDefault: false,
              excludedReason: "Not copied unless explicitly selected.",
            },
            {
              path: ".env",
              kind: "ignored",
              tracked: false,
              selectedByDefault: false,
              excludedReason:
                "Sensitive configuration; select this exact file explicitly to consent.",
            },
            ...(state.sensitiveTracked
              ? [
                  {
                    path: "tracked-secret",
                    kind: "sensitive-tracked",
                    tracked: true,
                    selectedByDefault: false,
                    excludedReason: "Sensitive tracked file requires consent.",
                  },
                ]
              : []),
          ],
          activeThreadIds: [],
          maxPayloadBytes: 1024,
        }),
        transferWorkspace: async () => {
          if (state.transferGate) await state.transferGate;
          if (state.transferError) throw state.transferError;
          return ready;
        },
        getWorkspaceTransfer: async () => ready,
      },
      environments: {
        get: async ({ environmentId }: { environmentId: string }) =>
          environment(environmentId),
        list: async () => [environment("env_target")],
      },
      threads: {
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({
            id: threadId,
            projectId: "proj_code",
            environmentId:
              threadId === "thr_source" ? "env_source" : "env_target",
            status: threadId === "thr_source" ? state.sourceStatus : "idle",
          }),
        list: async () =>
          state.spawned
            ? [
                makeThreadResponse({
                  id: "thr_continued",
                  projectId: "proj_code",
                  environmentId: "env_target",
                  status: "idle",
                }),
              ]
            : [],
        getPluginMetadata: async () => ({
          continuationOperationId: ready.operationId,
          taskId: task.id,
        }),
        spawn: async (args) => {
          state.checkpoint =
            args.prompt ??
            (args.input ?? [])
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join("\n");
          if (state.spawnError) {
            if (state.spawnAmbiguous) state.spawned = true;
            throw new Error(state.spawnError);
          }
          state.spawned = true;
          return { id: "thr_continued" };
        },
      },
    },
  });
  cleanup.push(() => harness.dispose());
  const store = createStore(bb);
  const project = store.tasks.createProject({
    name: "Work Inbox",
    prefix: "WORK",
    color: "blue",
  });
  const task = store.tasks.createTask({
    projectId: project.id,
    title: "Review prepared PR",
    description: "Read-only review; do not publish externally",
    status: "in_progress",
  });
  const preset = store.tasks.createPreset({
    name: "Native review",
    providerId: "codex",
    modelId: "gpt-5",
    reasoningLevel: "high",
    serviceTier: null,
    permissionMode: "accept-edits",
    environmentKind: "project-default",
    baseBranch: null,
    machineId: null,
    instructions: "Review only",
    builtin: false,
  });
  const target = {
    bbProjectId: "proj_code",
    hostId: "host_target",
    workspace: { kind: "managed-worktree" as const, baseBranch: "main" },
    presetId: preset.id,
  };
  const input = {
    taskId: task.id,
    sourceThreadId: "thr_source",
    targetHostId: "host_target",
    targetPath: "/work/continued",
    presetId: preset.id,
    includePaths: ["extra.bin"],
    extraInstructions: "Continue the prepared review without publishing",
  };
  registerDelegation(bb, store);
  const attachSource = () =>
    store.tasks.upsertTaskThread({
      taskId: task.id,
      threadId: "thr_source",
      presetName: preset.name,
      title: "Source review",
      liveStatus: "idle",
    });
  return {
    bb,
    harness,
    store,
    task,
    preset,
    project,
    target,
    input,
    state,
    ready,
    attachSource,
  };
}

describe("task execution routing", () => {
  it("persists code project independently of Work Inbox and dispatches an isolated target worktree", async () => {
    const fixture = setup();
    const { harness, task, target, store, bb } = fixture;
    const saved = await harness.callRpc("setTaskExecution", {
      taskId: task.id,
      target,
    });
    expect(saved).toMatchObject({
      inherited: false,
      override: target,
      resolved: target,
    });
    expect(new ExecutionStore(bb.storage.database()).target(task.id)).toEqual(
      target,
    );
    expect(
      store.tasks.getProject(task.projectId)?.linkedBbProjectId,
    ).toBeNull();
    await harness.callRpc("delegate", { taskId: task.id });
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([
      [
        expect.objectContaining({
          projectId: "proj_code",
          providerId: "codex",
          environment: {
            type: "host",
            hostId: "host_target",
            workspace: {
              type: "managed-worktree",
              baseBranch: { kind: "named", name: "main" },
            },
          },
        }),
      ],
    ]);
    await harness.callRpc("setTaskExecution", {
      taskId: task.id,
      target: null,
    });
    expect(
      await harness.callRpc("getTaskExecution", { taskId: task.id }),
    ).toMatchObject({ inherited: true, override: null, resolved: null });
  });

  it("clears to tracker inheritance without changing the tracker or profile", async () => {
    const { harness, store, project, task, target, preset } = setup();
    store.tasks.updateProject(project.id, {
      linkedBbProjectId: "proj_tracker",
    });
    await harness.callRpc("setTaskExecution", { taskId: task.id, target });
    const cleared = await harness.callRpc("setTaskExecution", {
      taskId: task.id,
      target: null,
    });
    expect(cleared).toMatchObject({
      inherited: true,
      resolved: {
        bbProjectId: "proj_tracker",
        hostId: "host_target",
        presetId: preset.id,
        workspace: { kind: "project-checkout" },
      },
    });
    expect(store.tasks.getPreset(preset.id)).toMatchObject({
      providerId: "codex",
      environmentKind: "project-default",
    });
  });

  it("resolves and dispatches an invocation profile without replacing the saved target profile", async () => {
    const { harness, store, task, target, preset, bb } = setup();
    const alternate = store.tasks.createPreset({
      name: "Alternate review",
      providerId: preset.providerId,
      modelId: "alternate-model",
      reasoningLevel: preset.reasoningLevel,
      serviceTier: null,
      permissionMode: preset.permissionMode,
      environmentKind: "project-default",
      baseBranch: null,
      machineId: null,
      instructions: "",
      builtin: false,
    });
    await harness.callRpc("setTaskExecution", { taskId: task.id, target });
    expect(
      await harness.callRpc("getTaskExecution", {
        taskId: task.id,
        presetId: alternate.id,
      }),
    ).toMatchObject({
      override: target,
      resolved: { ...target, presetId: alternate.id },
    });
    await harness.callRpc("delegate", {
      taskId: task.id,
      presetId: alternate.id,
    });
    expect(harness.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
      model: "alternate-model",
      projectId: target.bbProjectId,
    });
    expect(new ExecutionStore(bb.storage.database()).target(task.id)).toEqual(
      target,
    );
  });

  it("rejects mismatched existing workspace and unavailable target provider before spawning", async () => {
    const { harness, task, target, state } = setup();
    state.environmentProject = "proj_other";
    await expect(
      harness.callRpc("setTaskExecution", {
        taskId: task.id,
        target: {
          ...target,
          workspace: {
            kind: "existing-environment",
            environmentId: "env_target",
          },
        },
      }),
    ).rejects.toThrow("does not belong");
    state.providerAvailable = false;
    await expect(
      harness.callRpc("delegate", { taskId: task.id, executionTarget: target }),
    ).rejects.toThrow("unavailable");
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([]);
  });
});

describe("task native workspace continuation", () => {
  it("requires an attached idle source and exact preview file choices", async () => {
    const { harness, input, attachSource, state } = setup();
    await expect(harness.callRpc("continueTask", input)).rejects.toThrow(
      "not attached",
    );
    attachSource();
    state.sourceStatus = "active";
    await expect(harness.callRpc("continueTask", input)).rejects.toThrow(
      "must be idle",
    );
    state.sourceStatus = "idle";
    await expect(
      harness.callRpc("continueTask", {
        ...input,
        includePaths: ["../outside"],
      }),
    ).rejects.toThrow("unsafe");
    expect(harness.sdk.callsTo("projects.transferWorkspace")).toEqual([]);
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([]);
  });

  it("requires explicit consent for sensitive tracked files and forwards only exact selected paths", async () => {
    const { harness, input, attachSource, state } = setup();
    attachSource();
    state.sensitiveTracked = true;
    const preview = delegationRpcContract.previewTaskContinuation.output.parse(
      await harness.callRpc("previewTaskContinuation", {
        taskId: input.taskId,
        sourceThreadId: input.sourceThreadId,
        targetHostId: input.targetHostId,
      }),
    );
    expect(preview).not.toHaveProperty("maxPayloadBytes");
    await expect(harness.callRpc("continueTask", input)).rejects.toThrow(
      "requires explicit consent",
    );
    expect(harness.sdk.callsTo("projects.transferWorkspace")).toEqual([]);
    await harness.callRpc("continueTask", {
      ...input,
      includePaths: ["extra.bin", "tracked-secret", ".env"],
    });
    expect(
      harness.sdk.callsTo("projects.transferWorkspace")[0]?.[0],
    ).toMatchObject({
      includePaths: ["extra.bin", "tracked-secret", ".env"],
    });
  });

  it("never starts target agent when verified transfer fails", async () => {
    const { harness, input, attachSource, state, store, task } = setup();
    attachSource();
    state.transferError = Object.assign(
      new Error("binary verification failed"),
      { body: { details: { operationId: "transfer_failed_fixture" } } },
    );
    await expect(harness.callRpc("continueTask", input)).rejects.toThrow(
      "binary verification failed",
    );
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([]);
    expect(
      store.tasks.listTaskThreads(task.id).map((row) => row.threadId),
    ).toEqual(["thr_source"]);
    expect(
      store.tasks
        .listComments(task.id)
        .some((row) => row.body.includes("transfer_failed_fixture")),
    ).toBe(true);
    expect(store.tasks.getTask(task.id)?.status).toBe("in_progress");
  });

  it("seeds task and stored Jira context plus verified handoff into a new attached native session", async () => {
    const { harness, input, attachSource, state, store, task, bb, ready } =
      setup();
    attachSource();
    new JiraStore(bb.storage.database(), store).insert(task.id, "synthetic", {
      id: "10001",
      key: "TEST-1",
      url: "https://example.invalid/browse/TEST-1",
      summary: "Stored Jira checkpoint",
      description: "No external writes",
      descriptionDocument: null,
      statusId: "open",
      statusName: "Open",
      priority: null,
      assignee: null,
      updatedAt: "2026-01-01",
      fetchedAt: "2026-01-01",
      commentCount: 0,
      comments: [],
      commentsTruncated: false,
      transitionFields: {},
    });
    const beforeJira = bb.storage
      .database()
      .prepare("SELECT remote_json FROM jira_sources WHERE task_id = ?")
      .get(task.id);
    const result = delegationRpcContract.continueTask.output.parse(
      await harness.callRpc("continueTask", input),
    );
    expect(result).toEqual({
      threadId: "thr_continued",
      operationId: ready.operationId,
      environmentId: "env_target",
    });
    expect(state.checkpoint).toContain("Review prepared PR");
    expect(state.checkpoint).toContain("Stored Jira checkpoint");
    expect(state.checkpoint).toContain(ready.handoff);
    expect(state.checkpoint).toContain(input.extraInstructions);
    expect(state.checkpoint).toContain("NEW native session");
    expect(harness.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
      environment: { type: "reuse", environmentId: "env_target" },
      projectId: "proj_code",
      transferOperationId: ready.operationId,
    });
    expect(
      store.tasks
        .listTaskThreads(task.id)
        .map((row) => row.threadId)
        .sort(),
    ).toEqual(["thr_continued", "thr_source"]);
    expect(
      store.tasks
        .listComments(task.id)
        .some((row) => row.body.includes(ready.operationId)),
    ).toBe(true);
    expect(
      bb.storage
        .database()
        .prepare("SELECT remote_json FROM jira_sources WHERE task_id = ?")
        .get(task.id),
    ).toEqual(beforeJira);
    expect(store.tasks.getTask(task.id)?.status).toBe("in_progress");
    await expect(
      harness.callRpc("previewTaskContinuation", {
        taskId: task.id,
        sourceThreadId: input.sourceThreadId,
        targetHostId: "host_target",
      }),
    ).rejects.toThrow("already been continued");
  });

  it("persists ready transfer through spawn failure and retries without transferring or overwriting again", async () => {
    const { harness, input, attachSource, state, bb, store, ready } = setup();
    attachSource();
    state.spawnError = "provider temporarily unavailable";
    await expect(harness.callRpc("continueTask", input)).rejects.toThrow(
      ready.operationId,
    );
    expect(
      new ExecutionStore(bb.storage.database()).get(ready.operationId)?.receipt,
    ).toMatchObject({
      state: "ready",
      threadId: null,
      lastError: state.spawnError,
    });
    state.spawnError = null;
    const reloaded = handlers(bb, store);
    expect(
      await reloaded.continueTask({
        ...input,
        includePaths: [],
        operationId: ready.operationId,
      }),
    ).toMatchObject({
      threadId: "thr_continued",
      operationId: ready.operationId,
    });
    expect(harness.sdk.callsTo("projects.transferWorkspace")).toHaveLength(1);
    expect(harness.sdk.callsTo("projects.getWorkspaceTransfer")).toHaveLength(
      1,
    );
    expect(
      new ExecutionStore(bb.storage.database()).get(ready.operationId)?.receipt
        .state,
    ).toBe("started");
    expect(
      await reloaded.continueTask({
        ...input,
        includePaths: [],
        operationId: ready.operationId,
      }),
    ).toMatchObject({ threadId: "thr_continued" });
    expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(2);
  });

  it("recovers an ambiguous successful spawn by operation metadata rather than starting twice", async () => {
    const { harness, input, attachSource, state, ready } = setup();
    attachSource();
    state.spawnError = "response disconnected";
    state.spawnAmbiguous = true;
    expect(await harness.callRpc("continueTask", input)).toMatchObject({
      threadId: "thr_continued",
      operationId: ready.operationId,
    });
    expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });

  it("serializes continuation and dispatch on the same task", async () => {
    const { harness, input, attachSource, state, task, target } = setup();
    attachSource();
    const gate = new EventEmitter();
    state.transferGate = once(gate, "release").then(() => undefined);
    const continuation = harness.callRpc("continueTask", input);
    await expect(
      harness.callRpc("delegate", { taskId: task.id, executionTarget: target }),
    ).rejects.toThrow("already in progress");
    gate.emit("release");
    await continuation;
    expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });
});
