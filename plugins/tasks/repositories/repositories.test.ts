import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createStore } from "../api";
import { executionTargetSchema } from "../shared/execution";
import {
  repositoryBindingsSchema,
  type RepositoryBinding,
} from "../shared/repositories";
import { repositoryHandlers } from ".";
import { RepositoryStore } from "./store";
import { HELD_WORKFLOW_STATES, seedWorkflowOwnership } from "../workflow/ownership.test-fixtures.js";

type TransferArgs = Parameters<
  BbPluginApi["sdk"]["projects"]["transferWorkspace"]
>[0];
type Transfer = Awaited<
  ReturnType<BbPluginApi["sdk"]["projects"]["transferWorkspace"]>
>;
type SpawnArgs = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  const bindings: RepositoryBinding[] = [];
  const transfers = new Map<string, Transfer>();
  const publications = new Set<() => void>();
  const transferStarted = deferred();
  const state = {
    failRoot: "",
    providerAvailable: true,
    untracked: false,
    gate: null as Promise<void> | null,
    spawned: null as SpawnArgs | null,
    transferCalls: [] as TransferArgs[],
    spawnCalls: 0,
    ambiguous: false,
  };
  const { bb, harness } = createFakePluginHost({
    pluginId: "tasks",
    sdk: {
      hosts: {
        list: async () => [{ id: "host_source" }, { id: "host_target" }],
      },
      providers: {
        list: async () => [{ id: "codex", available: state.providerAvailable }],
      },
      system: {
        providerStates: async ({
          environmentId,
        }: { environmentId?: string } = {}) => ({
          providers: [
            {
              providerId: "codex",
              readiness: {
                verification: "required",
                scope: environmentId ? "environment" : "host",
                status: "ready",
                freshness: "fresh",
                checkedAt: Date.now(),
                retryAfterMs: null,
                detail: "Verified fixture provider",
              },
            },
          ],
        }),
      },
      environments: {
        get: async ({ environmentId }: { environmentId: string }) => {
          const binding = bindings.find(
            (entry) => entry.sourceEnvironmentId === environmentId,
          );
          const transfer = [...transfers.values()].find(
            (entry) => entry.environmentId === environmentId,
          );
          if (!binding && !transfer)
            throw new Error("Missing fixture environment");
          return {
            id: environmentId,
            projectId: binding?.bbProjectId ?? transfer!.projectId,
            hostId: binding?.sourceHostId ?? "host_target",
            path: binding?.sourcePath ?? transfer!.rootPath,
            status: "ready",
            lifecycle: { phase: "active" },
            hostLifecycle: "active",
            name: null,
          };
        },
      },
      projects: {
        previewWorkspaceTransfer: async ({
          sourceEnvironmentId,
        }: {
          sourceEnvironmentId: string;
        }) => {
          const binding = bindings.find(
            (entry) => entry.sourceEnvironmentId === sourceEnvironmentId,
          );
          const transfer = [...transfers.values()].find(
            (entry) => entry.environmentId === sourceEnvironmentId,
          );
          return {
            sourceEnvironmentId,
            sourceHostId: binding?.sourceHostId ?? "host_target",
            head: binding?.sourceHead ?? transfer!.head,
            branch: binding?.sourceBranch ?? transfer!.branch,
            activeThreadIds: [],
            files: [
              {
                path: "AGENTS.md",
                kind: "tracked",
                tracked: true,
                selectedByDefault: true,
              },
              {
                path: ".mcp.json",
                kind: "tracked",
                tracked: true,
                selectedByDefault: true,
              },
              ...(state.untracked
                ? [
                    {
                      path: "new.bin",
                      kind: "untracked",
                      tracked: false,
                      selectedByDefault: false,
                      excludedReason: "Not copied unless explicitly selected.",
                    },
                  ]
                : []),
            ],
          };
        },
        transferWorkspace: async (input: TransferArgs) => {
          state.transferCalls.push(input);
          transferStarted.resolve();
          if (state.gate) {
            const gate = state.gate;
            await new Promise<void>((resolve, reject) => {
              const abort = () =>
                reject(new Error("Native response interrupted"));
              input.signal?.addEventListener("abort", abort, { once: true });
              void gate.then(() => {
                input.signal?.removeEventListener("abort", abort);
                resolve();
              }, reject);
            });
          }
          if (input.projectId === state.failRoot)
            throw Object.assign(
              new Error("Target unavailable; source retained"),
              {
                body: {
                  code: "workspace_transfer_failed",
                  details: {
                    operationId:
                      input.operationId ?? `wtx_${state.transferCalls.length}`,
                  },
                },
              },
            );
          const binding = bindings.find(
            (entry) => entry.sourceEnvironmentId === input.sourceEnvironmentId,
          )!;
          const result: Transfer = {
            operationId:
              input.operationId ?? `wtx_${state.transferCalls.length}`,
            projectId: input.projectId,
            sourceEnvironmentId: input.sourceEnvironmentId,
            sourceHostId: binding.sourceHostId,
            targetHostId: input.targetHostId,
            targetPath: input.targetPath,
            createdAt: 1,
            updatedAt: 1,
            status: "ready",
            environmentId: `env_target_${state.transferCalls.length}`,
            hostId: input.targetHostId,
            rootPath: input.targetPath,
            head: binding.sourceHead,
            branch: input.branch ?? null,
            handoff:
              "Staged index, binary worktree and extra files verified; source retained.",
          };
          transfers.set(result.operationId, result);
          return result;
        },
        getWorkspaceTransfer: async ({
          operationId,
        }: {
          operationId: string;
        }) => {
          const result = transfers.get(operationId);
          if (!result)
            throw new Error("Native operation outcome is not yet known");
          return result;
        },
      },
      threads: {
        list: async ({ environmentId }: { environmentId?: string } = {}) =>
          state.spawned?.environment.type === "reuse" &&
          (!environmentId ||
            state.spawned.environment.environmentId === environmentId)
            ? [
                makeThreadResponse({
                  id: "thr_coherent",
                  projectId: state.spawned.projectId,
                  environmentId: state.spawned.environment.environmentId,
                  status: "idle",
                }),
              ]
            : [],
        get: async () =>
          makeThreadResponse({ id: "thr_coherent", status: "idle" }),
        getPluginMetadata: async () => state.spawned?.pluginMetadata ?? {},
        spawn: async (input: SpawnArgs) => {
          state.spawnCalls++;
          state.spawned = input;
          if (state.ambiguous)
            throw new Error("Response lost after native thread creation");
          return { id: "thr_coherent" };
        },
      },
    },
  });
  const store = createStore(bb);
  const project = store.tasks.createProject({
    name: "Workspace tests",
    prefix: "ROOT",
    color: "blue",
  });
  const task = store.tasks.createTask({
    projectId: project.id,
    title: "Cross repository change",
    description: "Work across both roots",
    status: "todo",
  });
  const preset = store.tasks.createPreset({
    name: "Writer",
    providerId: "codex",
    modelId: "gpt-5",
    reasoningLevel: "high",
    serviceTier: null,
    permissionMode: "accept-edits",
    environmentKind: "project-default",
    baseBranch: null,
    machineId: null,
    instructions: "Preserve sources",
    builtin: false,
  });
  for (const id of ["android", "actions"])
    bindings.push({
      id,
      bbProjectId: `proj_${id}`,
      role: id,
      owner: "Confirmed source owner",
      required: true,
      sourceEnvironmentId: `env_source_${id}`,
      sourceHostId: "host_source",
      sourcePath: `/source/${id}`,
      sourceBranch: "main",
      sourceHead: "a".repeat(40),
      targetHostId: "host_target",
      targetPath: `/target/${id}`,
      branch: `bb/task-${id}`,
      presetId: preset.id,
      instructions: `Edit only the agreed ${id} scope`,
      instructionPaths: ["AGENTS.md", ".mcp.json"],
      includePaths: [],
    });
  const handlers = repositoryHandlers(bb, store, {
    prompt: (entry, _preset, instructions) => `${entry.title}\n${instructions}`,
    title: (entry) => entry.title,
    publish: () => {
      for (const listener of publications) listener();
    },
  });
  const service = harness.runService("repository-preparation");
  cleanup.push(async () => {
    service.controller.abort();
    await service.done;
    await harness.dispose();
  });
  const waitPrepared = async (id: string) => {
    await new Promise<void>((resolve) => {
      const check = () => {
        if (new RepositoryStore(store).get(id).state !== "preparing") {
          publications.delete(check);
          resolve();
        }
      };
      publications.add(check);
      check();
    });
    return new RepositoryStore(store).get(id);
  };
  const prepare = async (
    input: Parameters<typeof handlers.prepareTaskRepositories>[0],
  ) => {
    const checkpoint = await handlers.prepareTaskRepositories(input);
    return waitPrepared(checkpoint.id);
  };
  return {
    handlers,
    prepare,
    waitPrepared,
    service,
    harness,
    transferStarted,
    bindings,
    state,
    store,
    task,
    preset,
    project,
    transfers,
  };
}

describe("coherent task repository workspaces", () => {
  it("returns queued preparation immediately and preserves an inspectable unknown native outcome on lifecycle interruption without replay", async () => {
    const f = setup();
    const gate = deferred();
    f.state.gate = gate.promise;
    const queued = await f.handlers.prepareTaskRepositories({
      taskId: f.task.id,
      bindings: f.bindings,
    });
    expect(queued.state).toBe("preparing");
    await f.transferStarted.promise;
    const inFlight = (
      await f.handlers.getTaskRepositories({ taskId: f.task.id })
    ).checkpoints[0]!;
    expect(inFlight.roots[0]?.transferOperationId).toBe(
      f.state.transferCalls[0]?.operationId,
    );
    await expect(
      f.handlers.continueTaskRepositories({
        taskId: f.task.id,
        checkpointId: queued.id,
      }),
    ).rejects.toThrow("still in progress");
    f.service.controller.abort();
    await f.service.done;
    const interrupted = (
      await f.handlers.getTaskRepositories({ taskId: f.task.id })
    ).checkpoints[0]!;
    expect(interrupted.state).toBe("partial");
    expect(interrupted.roots[0]?.state).toBe("interrupted");
    expect(interrupted.roots[0]?.transferOperationId).toBe(
      f.state.transferCalls[0]?.operationId,
    );
    const restarted = f.harness.runService("repository-preparation");
    expect(f.state.transferCalls).toHaveLength(1);
    expect(f.state.spawnCalls).toBe(0);
    restarted.controller.abort();
    await restarted.done;
    gate.resolve();
  });
  it("prepares every root without dispatch and starts ONE writer with every verified transfer and instruction", async () => {
    const f = setup();
    const checkpoint = await f.prepare({
      taskId: f.task.id,
      bindings: f.bindings,
    });
    expect(checkpoint.state).toBe("ready");
    expect(f.state.spawnCalls).toBe(0);
    expect(checkpoint.roots.map((root) => root.binding.sourcePath)).toEqual([
      "/source/android",
      "/source/actions",
    ]);
    const continued = await f.handlers.continueTaskRepositories({
      taskId: f.task.id,
      checkpointId: checkpoint.id,
    });
    expect(f.state.spawnCalls).toBe(1);
    expect(f.state.spawned?.repositoryTransferOperationIds).toEqual(
      f.state.transferCalls.map((call) => call.operationId),
    );
    expect(f.state.spawned?.prompt).toContain("/target/actions/AGENTS.md");
    expect(continued.roots.map((root) => root.threadId)).toEqual([
      "thr_coherent",
      "thr_coherent",
    ]);
    expect(f.store.tasks.listTaskThreads(f.task.id)).toHaveLength(1);
    await f.handlers.continueTaskRepositories({
      taskId: f.task.id,
      checkpointId: checkpoint.id,
    });
    expect(f.state.spawnCalls).toBe(1);
  });
  it("persists partial failure, blocks every writer and retries only failed roots at fresh paths", async () => {
    const f = setup();
    f.state.failRoot = "proj_actions";
    const checkpoint = await f.prepare({
      taskId: f.task.id,
      bindings: f.bindings,
    });
    expect(checkpoint.state).toBe("partial");
    expect(checkpoint.roots.map((root) => root.state)).toEqual([
      "ready",
      "failed",
    ]);
    expect(
      (await f.handlers.getTaskRepositories({ taskId: f.task.id }))
        .checkpoints[0]?.roots[1]?.error,
    ).toContain("source retained");
    expect(checkpoint.roots[1]?.transferOperationId).toBe(
      f.state.transferCalls[1]?.operationId,
    );
    await expect(
      f.handlers.continueTaskRepositories({
        taskId: f.task.id,
        checkpointId: checkpoint.id,
      }),
    ).rejects.toThrow("Every required repository");
    expect(f.state.spawnCalls).toBe(0);
    f.state.failRoot = "";
    const retry = f.bindings.map((binding) =>
      binding.id === "actions"
        ? { ...binding, targetPath: "/target/actions-retry" }
        : binding,
    );
    const result = await f.prepare({
      taskId: f.task.id,
      bindings: retry,
      checkpointId: checkpoint.id,
    });
    expect(result.state).toBe("ready");
    expect(f.state.transferCalls).toHaveLength(3);
    expect(result.roots[0]?.transferOperationId).toBe(
      f.state.transferCalls[0]?.operationId,
    );
    expect(result.roots[1]?.attempts[0]?.targetPath).toBe("/target/actions");
  });
  it("persists and passes the explicitly approved published base without silently changing transport", async () => {
    const f = setup();
    const remoteBase = {
      url: "git@github.com:approved/android.git",
      ref: "refs/heads/main",
      head: "a".repeat(40),
    };
    f.bindings[0]!.remoteBase = remoteBase;
    const checkpoint = await f.prepare({
      taskId: f.task.id,
      bindings: f.bindings,
    });
    expect(checkpoint.roots[0]?.binding.remoteBase).toEqual(remoteBase);
    expect(f.state.transferCalls[0]?.remoteBase).toEqual(remoteBase);
    expect(f.state.transferCalls[1]?.remoteBase).toBeUndefined();
    expect(f.state.spawnCalls).toBe(0);
  });
  it("rejects credentials in a published-base URL before persisting any checkpoint", async () => {
    const f = setup();
    f.bindings[0]!.remoteBase = {
      url: "https://token@github.com/approved/android.git",
      ref: "refs/heads/main",
      head: "a".repeat(40),
    };
    await expect(
      f.prepare({ taskId: f.task.id, bindings: f.bindings }),
    ).rejects.toThrow("credential-free");
    expect(
      (await f.handlers.getTaskRepositories({ taskId: f.task.id })).checkpoints,
    ).toEqual([]);
    expect(f.state.transferCalls).toHaveLength(0);
  });
  it("refuses missing portable dirty files before capture", async () => {
    const f = setup();
    f.state.untracked = true;
    const checkpoint = await f.prepare({
      taskId: f.task.id,
      bindings: f.bindings,
    });
    expect(
      checkpoint.roots.every((root) => root.error?.includes("new.bin")),
    ).toBe(true);
    expect(f.state.transferCalls).toHaveLength(0);
    expect(f.state.spawnCalls).toBe(0);
  });
  it("leaves every source untouched when the target execution profile is unavailable", async () => {
    const f = setup();
    f.state.providerAvailable = false;
    const checkpoint = await f.prepare({
      taskId: f.task.id,
      bindings: f.bindings,
    });
    expect(checkpoint.state).toBe("partial");
    expect(
      checkpoint.roots.every((root) => root.error?.includes("unavailable")),
    ).toBe(true);
    expect(f.state.transferCalls).toHaveLength(0);
    expect(f.state.spawnCalls).toBe(0);
  });
  it("reserves each source and target across concurrent tasks and preserves single-root consumers", async () => {
    const f = setup();
    const { promise, resolve: release } = deferred();
    f.state.gate = promise;
    const preparing = f.prepare({ taskId: f.task.id, bindings: f.bindings });
    await expect(
      f.prepare({ taskId: f.task.id, bindings: f.bindings }),
    ).rejects.toThrow("already in progress");
    release();
    await preparing;
    const other = f.store.tasks.createTask({
      projectId: f.project.id,
      title: "Other task",
      status: "todo",
    });
    await expect(
      f.prepare({ taskId: other.id, bindings: f.bindings }),
    ).rejects.toThrow("owned by checkpoint");
    const store = new RepositoryStore(f.store);
    expect(() => store.assertSingleRootAllowed(other.id)).not.toThrow();
    expect(() => store.assertSingleRootAllowed(f.task.id)).toThrow(
      "multi-repository",
    );
    expect(
      executionTargetSchema.parse({
        bbProjectId: "proj_single",
        hostId: "host_target",
        presetId: f.preset.id,
        workspace: { kind: "managed-worktree", baseBranch: "main" },
      }).workspace.kind,
    ).toBe("managed-worktree");
  });
  it("recovers an ambiguous native spawn as the same coherent writer without another session", async () => {
    const f = setup();
    const checkpoint = await f.prepare({
      taskId: f.task.id,
      bindings: f.bindings,
    });
    f.state.ambiguous = true;
    expect(
      (
        await f.handlers.continueTaskRepositories({
          taskId: f.task.id,
          checkpointId: checkpoint.id,
        })
      ).state,
    ).toBe("partial");
    const recovered = await f.handlers.continueTaskRepositories({
      taskId: f.task.id,
      checkpointId: checkpoint.id,
    });
    expect(recovered.state).toBe("started");
    expect(f.state.spawnCalls).toBe(1);
    expect(
      recovered.roots.every((root) => root.threadId === "thr_coherent"),
    ).toBe(true);
  });
  it.each(["/target/../escape", "/target/android/child", "/target/android"])(
    "rejects traversal or overlapping root %s at the public boundary",
    (targetPath) => {
      const f = setup();
      expect(
        repositoryBindingsSchema.safeParse([
          f.bindings[0],
          { ...f.bindings[1], targetPath },
        ]).success,
      ).toBe(false);
    },
  );
  it("rejects disconnected hosts, duplicate ids and a nonrequired primary", () => {
    const f = setup();
    expect(
      repositoryBindingsSchema.safeParse([
        f.bindings[0],
        { ...f.bindings[1], targetHostId: "other" },
      ]).success,
    ).toBe(false);
    expect(
      repositoryBindingsSchema.safeParse([
        f.bindings[0],
        { ...f.bindings[1], id: "android" },
      ]).success,
    ).toBe(false);
    expect(
      repositoryBindingsSchema.safeParse([
        { ...f.bindings[0], required: false },
        f.bindings[1],
      ]).success,
    ).toBe(false);
  });
});

describe("durable workflow ownership across aggregate repository execution", () => {
  it.each(HELD_WORKFLOW_STATES)("permits isolated repository preparation but fences its aggregate writer while ownership is %s", async state => {
    const fixture = setup();
    const owner = seedWorkflowOwnership(fixture.store, fixture.task.id, "proj_android", state);
    const checkpoint = await fixture.prepare({ taskId: fixture.task.id, bindings: fixture.bindings });
    expect(checkpoint.state).toBe("ready");
    expect(checkpoint.roots.every(root => root.state === "ready" && root.environmentId !== null)).toBe(true);
    expect(fixture.state.spawned).toBeNull();
    const attached = fixture.store.tasks.listTaskThreads(fixture.task.id).map(thread => thread.threadId).sort();
    const outcome = await Promise.resolve(fixture.handlers.continueTaskRepositories({ taskId: fixture.task.id, checkpointId: checkpoint.id })).then(value => ({ value, error: null }), (error: unknown) => ({ value: null, error }));
    expect(fixture.state.spawned).toBeNull();
    expect(new RepositoryStore(fixture.store).get(checkpoint.id)).toEqual(checkpoint);
    expect(fixture.store.tasks.listTaskThreads(fixture.task.id).map(thread => thread.threadId).sort()).toEqual(attached);
    expect(owner.workflows.get(owner.request.group)).toEqual(owner.view);
    expect(outcome).toMatchObject({ value: null, error: expect.any(Error) });
  });

  it("admits the aggregate repository writer after human acceptance and workflow ownership release", async () => {
    const fixture = setup();
    const owner = seedWorkflowOwnership(fixture.store, fixture.task.id, "proj_android", "released");
    const checkpoint = await fixture.prepare({ taskId: fixture.task.id, bindings: fixture.bindings });
    const continued = await fixture.handlers.continueTaskRepositories({ taskId: fixture.task.id, checkpointId: checkpoint.id });
    expect(continued.roots.every(root => root.state === "started" && root.threadId === "thr_coherent")).toBe(true);
    expect(fixture.store.tasks.getTaskThreadByThreadId(fixture.task.id, "thr_coherent")).toMatchObject({ threadId: "thr_coherent" });
    expect(owner.workflows.get(owner.request.group)).toMatchObject({ state: "accepted", revision: 1 });
    expect(fixture.state.spawned).toMatchObject({ projectId: "proj_android", environment: { type: "reuse", environmentId: checkpoint.roots[0]!.environmentId } });
  });
});
