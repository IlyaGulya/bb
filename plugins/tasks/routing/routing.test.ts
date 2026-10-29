import { createDeferredPromise } from "@bb/test-helpers";
import { createFakePluginHost, makeThreadResponse, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createStore } from "../api/index.js";
import { registerInbox } from "../inbox/index.js";
import { InboxStore } from "../inbox/store.js";
import { ExecutionStore } from "../delegate/execution-store.js";
import { registerTasksCli } from "../cli/index.js";
import { registerJiraSync } from "../jira/index.js";
import { seedWorkflowOwnership } from "../workflow/ownership.test-fixtures.js";
import { WorkflowPreparationStore } from "../workflow/preparation-store.js";
import { routeOutcomeSchema } from "../shared/routing.js";
import { registerRouting } from "./index.js";
import { RoutingStore, fingerprint } from "./store.js";
import { createTaskRoutingClient } from "./client.js";

const hosts: FakePluginHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.dispose(); });
function setup() {
  const state = { now: 100000, spawned: 0, sent: 0, callbacks: 0, gate: Promise.resolve() };
  const host = createFakePluginHost({ pluginId: "tasks", sdk: {
    threads: {
      get: async ({ threadId }) => { await state.gate; return makeThreadResponse({ id: threadId, title: "Existing native owner", status: "idle", projectId: "proj_code" }); },
      spawn: async () => { state.spawned++; throw new Error("Routing must not spawn"); },
      send: async () => { state.sent++; throw new Error("Routing must not send"); },
    },
    system: { experimental_classifyTaskRoute: async () => { state.callbacks++; throw new Error("No classifier call expected"); } },
  } });
  hosts.push(host);
  const store = createStore(host.bb);
  const project = store.tasks.createProject({ name: "Routing", prefix: "RTE", color: "blue" });
  const inbox = registerInbox(host.bb, store, { background: false });
  const routing = registerRouting(host.bb, store, { now: () => state.now });
  const persistence = new RoutingStore(store, () => state.now);
  registerTasksCli(host.bb, store, { name: "Tasks", version: "0.4.0" }, registerJiraSync(host.bb, store), inbox, undefined, undefined, routing);
  const incoming = (title: string) => inbox.createInbox({ title, body: "Untrusted incoming context", context: "work" });
  return { ...host, store, project, inbox, routing, persistence, incoming, state };
}
async function preview(f: ReturnType<typeof setup>, id: string, patch: Partial<Parameters<typeof f.routing.previewInboxRoute>[0]> = {}) {
  const source = new InboxStore(f.store.database).get(id);
  const current = await f.routing.getInboxRoute({ id });
  return f.routing.previewInboxRoute({ id, operationId: `preview-${current.proposal?.revision ?? 0}`, grantId: null, sourceRevision: source.revision, expectedRevision: current.proposal?.revision ?? 0, projectId: f.project.id, taskRef: "", newTask: false, semantic: false, ...patch });
}
async function enable(f: ReturnType<typeof setup>, id: string, taskIds: string[], actions: Array<"preview" | "link" | "create" | "target" | "workflow-draft">, maxAttempts = 2) {
  return f.routing.enableLocalAway({ operationId: "grant-one", projectId: f.project.id, inboxIds: [id], taskIds, actions, maxAttempts, durationSeconds: 60, acknowledgedBoundary: true });
}

function ordinaryOwners() {
  const f = setup();
  const task = f.store.tasks.createTask({ projectId: f.project.id, title: "Ordinary executor choice" });
  const first = "thr_ordinaryfirst";
  const second = "thr_ordinarysecond";
  for (const threadId of [first, second]) f.store.tasks.upsertTaskThread({ taskId: task.id, threadId, title: threadId, presetName: "Worker", liveStatus: "idle" });
  return { ...f, task, first, second };
}

describe("review regressions: explicit attached-thread answers", () => {
  it("accepts an exact idle attached-thread answer through RPC and retains it when linking", async () => {
    const f = ordinaryOwners();
    const { item } = await f.incoming(`Continue ${f.task.key}`);
    const question = await preview(f, item.id);
    expect(question).toMatchObject({ state: "parked", proposal: { decision: { kind: "clarify" }, threadId: null } });
    const answer = routeOutcomeSchema.parse(await f.harness.callRpc("previewInboxRoute", { id: item.id, operationId: "answer-attached-thread", grantId: null, sourceRevision: item.revision, expectedRevision: 1, projectId: f.project.id, taskRef: f.second, newTask: false, semantic: false }));
    expect(answer).toMatchObject({ state: "applied", proposal: { decision: { kind: "existing", taskId: f.task.id }, owner: "ordinary", threadId: f.second, workerThreadIds: expect.arrayContaining([f.first, f.second]) } });
    const applied = routeOutcomeSchema.parse(await f.harness.callRpc("applyInboxRoute", { id: item.id, operationId: "link-selected-thread", grantId: null, expectedRevision: 2, action: { kind: "link" } }));
    expect(applied).toMatchObject({ state: "applied", item: { taskId: f.task.id, state: "resolved" }, proposal: { threadId: f.second } });
    expect((await f.routing.getInboxRoute({ id: item.id })).proposal?.threadId).toBe(f.second);
    expect(f.store.tasks.listTasks().map(task => task.id)).toEqual([f.task.id]);
    expect(f.state).toMatchObject({ spawned: 0, sent: 0, callbacks: 0 });
  });

  it("does not turn an exact managed reviewer reference into writer ownership", async () => {
    const f = setup();
    const task = f.store.tasks.createTask({ projectId: f.project.id, title: "Managed writer remains retained" });
    seedWorkflowOwnership(f.store, task.id, "proj_code", "in_review");
    const { item } = await f.incoming(task.key);
    const advice = await preview(f, item.id, { taskRef: "thr_ownedretainedreviewer" });
    expect(advice.proposal).toMatchObject({ owner: "managed", threadId: "thr_ownedretainedwriter", workerThreadIds: expect.arrayContaining(["thr_ownedretainedwriter", "thr_ownedretainedreviewer"]) });
    const applied = routeOutcomeSchema.parse(await f.harness.callRpc("applyInboxRoute", { id: item.id, operationId: "link-managed-reference", grantId: null, expectedRevision: 1, action: { kind: "link" } }));
    expect(applied).toMatchObject({ state: "applied", item: { taskId: task.id }, proposal: { threadId: "thr_ownedretainedwriter" } });
    expect(f.store.tasks.getTask(task.id)?.status).toBe("in_review");
    expect(f.state).toMatchObject({ spawned: 0, sent: 0, callbacks: 0 });
  });

  it("keeps a started continuation source as history even when it is named explicitly", async () => {
    const f = ordinaryOwners();
    const preset = f.store.tasks.createPreset({ name: "Continuation profile", providerId: "acp-omp", modelId: "selected-model", reasoningLevel: "high", permissionMode: "full", serviceTier: null, environmentKind: "project-default", baseBranch: null, machineId: null, instructions: "Native continuation" });
    const executions = new ExecutionStore(f.store.database);
    executions.create({ receipt: { operationId: "started-continuation", taskId: f.task.id, sourceThreadId: f.first, bbProjectId: "proj_code", sourceEnvironmentId: "env_source", targetHostId: "host_one", targetPath: "/code", presetId: preset.id, environmentId: "env_target", state: "started", threadId: f.second, lastError: null, createdAt: "2026-10-29T00:00:00.000Z" }, request: { includePaths: [] }, handoff: "Retain the established target" });
    f.store.tasks.createComment({ taskId: f.task.id, kind: "agent", authorName: "Historical source", threadId: f.first, body: "Earlier source response" });
    const { item } = await f.incoming(f.task.key);
    const advice = await preview(f, item.id, { taskRef: f.first });
    expect(advice.proposal).toMatchObject({ owner: "ordinary", threadId: f.second });
    const applied = routeOutcomeSchema.parse(await f.harness.callRpc("applyInboxRoute", { id: item.id, operationId: "link-current-continuation", grantId: null, expectedRevision: 1, action: { kind: "link" } }));
    expect(applied).toMatchObject({ state: "applied", item: { taskId: f.task.id }, proposal: { threadId: f.second } });
    expect(executions.get("started-continuation")?.receipt).toMatchObject({ state: "started", sourceThreadId: f.first, threadId: f.second });
    expect(f.state).toMatchObject({ spawned: 0, sent: 0, callbacks: 0 });
  });
});

describe("advisory routes without a second executor", () => {
  it("resolves exact references to a retained managed writer even when the latest responder is its reviewer", async () => {
    const f = setup();
    const task = f.store.tasks.createTask({ projectId: f.project.id, title: "Retained implementation" });
    seedWorkflowOwnership(f.store, task.id, "proj_code", "in_review");
    f.store.tasks.createComment({ taskId: task.id, kind: "agent", authorName: "Reviewer", threadId: "thr_ownedretainedreviewer", body: "Review finished" });
    const { item } = await f.incoming(`Continue ${task.key}`);
    const advice = await preview(f, item.id);
    expect(advice.proposal).toMatchObject({ decision: { kind: "existing", taskId: task.id }, owner: "managed", threadId: "thr_ownedretainedwriter", workerThreadIds: ["thr_ownedretainedwriter", "thr_ownedretainedreviewer"] });
    const applied = await f.routing.applyInboxRoute({ id: item.id, operationId: "link-managed", grantId: null, expectedRevision: 1, action: { kind: "link" } });
    expect(applied.item?.taskId).toBe(task.id);
    expect(f.state).toMatchObject({ spawned: 0, sent: 0, callbacks: 0 });
    expect(f.store.tasks.getTask(task.id)?.status).toBe("in_review");
  });
  it.each(["reserved", "ready"] as const)("retains a %s workflow preparation without exposing a replacement target", async state => {
    const f = setup();
    const task = f.store.tasks.createTask({ projectId: f.project.id, title: "Prepared native owner" });
    const preparations = new WorkflowPreparationStore(f.store);
    const reserved = preparations.reserve(task.id, "proj_code", preparations.draft(task.id).selection);
    const retained = state === "ready" ? preparations.savePreparation({ ...reserved, state, threadId: "thr_preparedwriter", reviewerThreadId: "thr_preparedreviewer", environmentId: "env_prepared", workspacePath: "/code", branch: "prepared", head: "a".repeat(40) }) : reserved;
    const { item } = await f.incoming(`Continue ${task.key}`);
    const advice = await preview(f, item.id);
    expect(advice.proposal).toMatchObject({ owner: "prepared", threadId: retained.threadId, workerThreadIds: state === "ready" ? ["thr_preparedwriter", "thr_preparedreviewer"] : [] });
    const result = await f.routing.applyInboxRoute({ id: item.id, operationId: "replace-prepared-target", grantId: null, expectedRevision: 1, action: { kind: "target", target: null } });
    expect(result.state).toBe("parked");
    expect(preparations.preparation(task.id)).toEqual(retained);
    expect(new InboxStore(f.store.database).get(item.id).taskId).toBeNull();
    expect(f.state).toMatchObject({ spawned: 0, sent: 0, callbacks: 0 });
  });
  it("invalidates advice when a native workflow preparation acquires ownership", async () => {
    const f = setup();
    const task = f.store.tasks.createTask({ projectId: f.project.id, title: "Newly prepared owner" });
    const { item } = await f.incoming(task.key);
    await preview(f, item.id);
    const preparations = new WorkflowPreparationStore(f.store);
    preparations.reserve(task.id, "proj_code", preparations.draft(task.id).selection);
    expect((await f.routing.getInboxRoute({ id: item.id })).stale).toBe(true);
    const result = await f.routing.applyInboxRoute({ id: item.id, operationId: "stale-owner-link", grantId: null, expectedRevision: 1, action: { kind: "link" } });
    expect(result.state).toBe("parked");
    expect(new InboxStore(f.store.database).get(item.id).taskId).toBeNull();
  });
  it("asks one scope question for conflicting references and accepts an explicit answer without a classifier", async () => {
    const f = setup();
    const first = f.store.tasks.createTask({ projectId: f.project.id, title: "Checkout" });
    const second = f.store.tasks.createTask({ projectId: f.project.id, title: "Deployment" });
    const { item } = await f.incoming(`Related to ${first.key} and ${second.key}`);
    const ambiguous = await preview(f, item.id);
    expect(ambiguous).toMatchObject({ state: "parked", proposal: { decision: { kind: "clarify" } } });
    const answered = await preview(f, item.id, { taskRef: first.key });
    expect(answered.proposal?.decision).toMatchObject({ kind: "existing", taskId: first.id });
    expect((await f.routing.getInboxRoute({ id: item.id })).journal.map(entry => entry.state)).toEqual(["applied", "parked"]);
    expect(f.state.callbacks).toBe(0);
  });
  it("routes an exact unattached native thread without creating a task or sending to it", async () => {
    const f = setup();
    f.store.tasks.updateProject(f.project.id, { linkedBbProjectId: "proj_code" });
    const { item } = await f.incoming("Continue thr_existingnative");
    const advice = await preview(f, item.id);
    expect(advice.proposal).toMatchObject({ decision: { kind: "existing-thread", threadId: "thr_existingnative" }, taskId: null, threadId: "thr_existingnative" });
    const applied = await f.routing.applyInboxRoute({ id: item.id, operationId: "link-thread", grantId: null, expectedRevision: 1, action: { kind: "link" } });
    expect(applied.item).toMatchObject({ threadId: "thr_existingnative", taskId: null, state: "resolved" });
    expect(f.store.tasks.listTasks()).toEqual([]);
    expect(f.state).toMatchObject({ spawned: 0, sent: 0, callbacks: 0 });
  });
  it.each(["direct", "rpc", "sdk", "cli"] as const)("keeps create-once, budget and stale-replay behavior through the %s surface", async surface => {
    const f = setup();
    const { item } = await f.incoming("New local intake");
    await preview(f, item.id, { newTask: true });
    const grant = await enable(f, item.id, [], ["create"], 1);
    const input = { id: item.id, operationId: "create-once", grantId: grant.id, expectedRevision: 1, action: { kind: "create" as const } };
    const apply = async () => {
      if (surface === "direct") return f.routing.applyInboxRoute(input);
      if (surface === "rpc") return routeOutcomeSchema.parse(await f.harness.callRpc("applyInboxRoute", input));
      if (surface === "sdk") {
        f.harness.sdk.stub("plugins.callRpc", async (raw: unknown) => {
          const request = z.object({ pluginId: z.literal("tasks"), method: z.string(), input: z.unknown() }).parse(raw);
          return f.harness.callRpc(request.method, request.input, { experimental_caller: { kind: "plugin", pluginId: "routing-consumer" } });
        });
        return createTaskRoutingClient(f.bb.sdk.plugins).apply(input);
      }
      const result = await f.harness.runCli(["route", "apply", item.id, "--operation", input.operationId, "--revision", "1", "--grant", grant.id, "--action", JSON.stringify(input.action), "--json"]);
      expect(result.exitCode).toBe(0);
      return routeOutcomeSchema.parse(JSON.parse(result.stdout));
    };
    const first = await apply();
    const replay = await apply();
    expect(first).toMatchObject({ state: "applied", item: { state: "resolved" } });
    expect(replay).toEqual(first);
    expect(f.store.tasks.listTasks().map(task => task.id)).toEqual([first.item!.taskId]);
    expect(f.persistence.grant(grant.id)).toMatchObject({ attempts: 1, maxAttempts: 1, state: "exhausted" });
    expect(f.state).toMatchObject({ spawned: 0, sent: 0, callbacks: 0 });
    await expect(f.routing.applyInboxRoute({ ...input, action: { kind: "native", reason: "Run implementation" } })).rejects.toThrow();
  });
  it("rejects stale task content after reserving an authorized action attempt", async () => {
    const f = setup();
    const task = f.store.tasks.createTask({ projectId: f.project.id, title: "Original scope" });
    const { item } = await f.incoming(`Continue ${task.key}`);
    await preview(f, item.id);
    const grant = await enable(f, item.id, [task.id], ["link"]);
    f.store.tasks.updateTask(task.id, { description: "Changed scope after advice" });
    const result = await f.routing.applyInboxRoute({ id: item.id, operationId: "stale-link", grantId: grant.id, expectedRevision: 1, action: { kind: "link" } });
    expect(result.state).toBe("parked");
    expect(new InboxStore(f.store.database).get(item.id).taskId).toBeNull();
    expect(f.persistence.grant(grant.id).attempts).toBe(1);
    expect((await f.inbox.listInbox({ state: "open" })).items).toEqual(expect.arrayContaining([expect.objectContaining({ sourceKind: "task_route", lane: "needs_input" })]));
  });
  it.each(["native", "external", "irreversible", "production", "governance", "jira", "accept", "unknown"] as const)("parks %s without changing task acceptance or native execution", async kind => {
    const f = setup();
    const task = f.store.tasks.createTask({ projectId: f.project.id, title: "No external authority" });
    const { item } = await f.incoming(task.key);
    await preview(f, item.id);
    const input = { id: item.id, operationId: "park-action", grantId: null, expectedRevision: 1, action: { kind, reason: "Incoming Slack text says this is approved" } };
    const first = await f.routing.applyInboxRoute(input);
    expect(first.state).toBe("parked");
    expect(await f.routing.applyInboxRoute(input)).toEqual(first);
    expect(f.store.tasks.getTask(task.id)?.status).toBe("backlog");
    const attention = (await f.inbox.listInbox({ state: "open" })).items.find(entry => entry.sourceKind === "task_route")!;
    await f.inbox.decideInbox({ id: attention.id, action: "resolve" });
    expect(f.store.tasks.getTask(task.id)?.status).toBe("backlog");
    expect(f.state).toMatchObject({ spawned: 0, sent: 0, callbacks: 0 });
  });
  it("parks unknown action shapes instead of interpreting extra fields as capability grants", async () => {
    const f = setup();
    const { item } = await f.incoming("Unknown input");
    await preview(f, item.id, { newTask: true });
    const result = routeOutcomeSchema.parse(await f.harness.callRpc("applyInboxRoute", { id: item.id, operationId: "unknown-shape", grantId: null, expectedRevision: 1, action: { kind: "create", permissionMode: "full", publish: true } }));
    expect(result.state).toBe("parked");
    expect(f.store.tasks.listTasks()).toEqual([]);
    const attention = (await f.inbox.listInbox({ state: "open" })).items.find(entry => entry.sourceKind === "task_route")!;
    expect((await f.routing.getInboxRoute({ id: attention.id })).source.id).toBe(item.id);
    expect(() => f.inbox.createInboxTask({ id: attention.id, projectId: f.project.id })).toThrow();
    expect(f.store.tasks.listTasks()).toEqual([]);
  });
});

describe("server-reserved local-away lifecycle", () => {
  it.each(["revoked", "expired"] as const)("blocks an already reserved effect when its grant becomes %s", async transition => {
    const f = setup();
    const task = f.store.tasks.createTask({ projectId: f.project.id, title: "Existing owner" });
    f.store.tasks.upsertTaskThread({ taskId: task.id, threadId: "thr_owner", title: "Owner", presetName: "Worker", liveStatus: "idle" });
    const { item } = await f.incoming(task.key);
    await preview(f, item.id);
    const grant = await enable(f, item.id, [task.id], ["link"]);
    const gate = createDeferredPromise<void>();
    f.state.gate = gate.promise;
    const pending = f.routing.applyInboxRoute({ id: item.id, operationId: "reserved-link", grantId: grant.id, expectedRevision: 1, action: { kind: "link" } });
    if (transition === "revoked") await f.routing.revokeLocalAway({ id: grant.id });
    else f.state.now = grant.expiresAt;
    gate.resolve();
    expect((await pending).state).toBe("parked");
    expect(new InboxStore(f.store.database).get(item.id).taskId).toBeNull();
    expect(f.persistence.grant(grant.id)).toMatchObject({ attempts: 1, state: transition });
  });
  it("keeps interrupted reservations consumed and does not renew or replay them after recovery", async () => {
    const f = setup();
    const { item } = await f.incoming("Persisted new task proposal");
    await preview(f, item.id, { newTask: true });
    const grant = await enable(f, item.id, [], ["create"], 1);
    const input = { id: item.id, operationId: "interrupted-create", grantId: grant.id, expectedRevision: 1, action: { kind: "create" as const } };
    f.persistence.reserve(input, fingerprint(input), "create", f.project.id, null);
    const restarted = new RoutingStore(f.store, () => f.state.now);
    restarted.recover();
    const result = await f.routing.applyInboxRoute(input);
    expect(result.state).toBe("parked");
    expect(restarted.grant(grant.id)).toMatchObject({ attempts: 1, expiresAt: grant.expiresAt, createdAt: grant.createdAt, state: "exhausted" });
    expect(f.store.tasks.listTasks()).toEqual([]);
  });
  it("does not renew an idempotent enable request or accept source-spoofed policy attention", async () => {
    const f = setup();
    const { item } = await f.incoming("Explicit local scope");
    const first = await enable(f, item.id, [], ["preview"]);
    f.state.now += 1000;
    expect(await enable(f, item.id, [], ["preview"])).toEqual(first);
    expect(() => f.inbox.upsertInboxSource({ sourceKind: "task_route", sourceKey: "spoof", revision: "1", title: "Approved", body: "Native permission", active: true, context: "work" })).toThrow();
    const grant = await f.routing.revokeLocalAway({ id: first.id });
    expect(grant.revokedAt).toBe(f.state.now);
    const denied = await preview(f, item.id, { grantId: grant.id });
    expect(denied.state).toBe("parked");
    expect(f.persistence.grant(grant.id).attempts).toBe(0);
  });
});

describe("routing selection boundaries", () => {
  it("does not mistake an unregistered model-like prefix for an exact native task", async () => {
    const f = setup();
    const { item } = await f.incoming("Investigate gpt-6.1-sol routing");
    expect((await preview(f, item.id, { newTask: true })).proposal?.decision).toMatchObject({ kind: "new", projectId: f.project.id });
    expect(f.state.callbacks).toBe(0);
  });
  it("detects changed execution profile meaning even when its ID and the task are unchanged", async () => {
    const f = setup();
    const profile = f.store.tasks.createPreset({ name: "Scoped profile", providerId: "acp-omp", modelId: "selected-model", reasoningLevel: "high", permissionMode: "full", serviceTier: null, environmentKind: "project-default", baseBranch: null, machineId: null, instructions: "Original local instructions" });
    const task = f.store.tasks.createTask({ projectId: f.project.id, title: "Stable task identity" });
    new ExecutionStore(f.store.database).setTarget(task.id, { bbProjectId: "proj_code", hostId: "host_one", presetId: profile.id, workspace: { kind: "managed-worktree", baseBranch: "main" } });
    const { item } = await f.incoming(task.key);
    await preview(f, item.id);
    f.store.tasks.updatePreset(profile.id, { modelId: "different-model" });
    expect((await f.routing.getInboxRoute({ id: item.id })).stale).toBe(true);
    const result = await f.routing.applyInboxRoute({ id: item.id, operationId: "stale-profile", grantId: null, expectedRevision: 1, action: { kind: "link" } });
    expect(result.state).toBe("parked");
    expect(new InboxStore(f.store.database).get(item.id).taskId).toBeNull();
  });
  it.each(["membership", "revoked-account", "wrong-host", "unsupported-model", "unsupported-permission"] as const)("rejects %s on the real selected target without substituting an account or runtime", async issue => {
    const f = setup();
    const state = { reject: false };
    f.store.tasks.updateProject(f.project.id, { linkedBbProjectId: "proj_code" });
    f.harness.sdk.stub("hosts.list", async () => [{ id: "host_one", name: "One", status: "connected" }]);
    f.harness.sdk.stub("projects.get", async () => ({ id: "proj_code", name: "Code", sources: [{ hostId: "host_one", type: "local_path", path: "/code", isDefault: true }] }));
    f.harness.sdk.stub("experimental_executionContexts.list", async () => [{ id: "context_one", name: "Context", enabled: true, projectIds: state.reject && issue === "membership" ? [] : ["proj_code"] }]);
    f.harness.sdk.stub("experimental_modelConnections.list", async () => [{ id: "account_one", name: "Account", enabled: true, revoked: state.reject && issue === "revoked-account", provider: "acp-omp", hostId: state.reject && issue === "wrong-host" ? "host_other" : "host_one", gateway: null }]);
    f.harness.sdk.stub("providers.list", async () => [{ id: "acp-omp", available: true, capabilities: { permissionModes: state.reject && issue === "unsupported-permission" ? ["accept-edits"] : ["full"] } }]);
    f.harness.sdk.stub("providers.models", async () => ({ modelLoadError: null, models: state.reject && issue === "unsupported-model" ? [] : [{ id: "selected-model", model: "selected-model", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }], selectedOnlyModels: [] }));
    const preset = f.store.tasks.createPreset({ name: "Explicit target", providerId: "acp-omp", modelId: "selected-model", reasoningLevel: "high", permissionMode: "full", serviceTier: null, environmentKind: "project-default", baseBranch: null, machineId: null, executionContextId: "context_one", modelConnectionId: "account_one", instructions: "Local source" });
    const task = f.store.tasks.createTask({ projectId: f.project.id, title: "Selected binding" });
    const target = { bbProjectId: "proj_code", hostId: "host_one", presetId: preset.id, executionContextId: "context_one", modelConnectionId: "account_one", workspace: { kind: "managed-worktree" as const, baseBranch: "main" } };
    const executions = new ExecutionStore(f.store.database);
    executions.setTarget(task.id, target);
    const { item } = await f.incoming(task.key);
    await preview(f, item.id);
    state.reject = true;
    const result = await f.routing.applyInboxRoute({ id: item.id, operationId: "invalid-binding", grantId: null, expectedRevision: 1, action: { kind: "target", target: { ...target, workspace: { kind: "managed-worktree", baseBranch: "changed" } } } });
    expect(result.state).toBe("parked");
    expect(executions.target(task.id)).toEqual(target);
    expect(f.state).toMatchObject({ spawned: 0, sent: 0, callbacks: 0 });
  });
});

describe("review regressions: latest-responder ownership fences", () => {
  it("marks retained advice stale when another idle attachment becomes the latest agent responder", async () => {
    const f = ordinaryOwners();
    f.store.tasks.createComment({ taskId: f.task.id, kind: "agent", authorName: "First executor", threadId: f.first, body: "Current implementation" });
    const { item } = await f.incoming(f.task.key);
    expect((await preview(f, item.id)).proposal?.threadId).toBe(f.first);
    f.store.tasks.createComment({ taskId: f.task.id, kind: "agent", authorName: "Second executor", threadId: f.second, body: "I now own this implementation" });
    expect((await f.routing.getInboxRoute({ id: item.id })).stale).toBe(true);
    const refreshed = await preview(f, item.id);
    expect(refreshed.proposal).toMatchObject({ owner: "ordinary", threadId: f.second });
    expect((await f.routing.getInboxRoute({ id: item.id })).stale).toBe(false);
    expect(f.state).toMatchObject({ spawned: 0, sent: 0, callbacks: 0 });
  });

  it("fences a responder change while a link is awaiting native ownership reads", async () => {
    const f = ordinaryOwners();
    f.store.tasks.createComment({ taskId: f.task.id, kind: "agent", authorName: "First executor", threadId: f.first, body: "Current implementation" });
    const { item } = await f.incoming(f.task.key);
    expect((await preview(f, item.id)).proposal?.threadId).toBe(f.first);
    const entered = createDeferredPromise<void>();
    const release = createDeferredPromise<void>();
    f.harness.sdk.stub("threads.get", async (raw: unknown) => {
      const { threadId } = z.object({ threadId: z.string() }).parse(raw);
      entered.resolve();
      await release.promise;
      return makeThreadResponse({ id: threadId, projectId: "proj_code", status: "idle" });
    });
    const pending = f.harness.callRpc("applyInboxRoute", { id: item.id, operationId: "link-during-responder-change", grantId: null, expectedRevision: 1, action: { kind: "link" } });
    await entered.promise;
    try {
      f.store.tasks.createComment({ taskId: f.task.id, kind: "agent", authorName: "Second executor", threadId: f.second, body: "New current owner" });
    } finally {
      release.resolve();
    }
    const result = routeOutcomeSchema.parse(await pending);
    expect(result.state).toBe("parked");
    expect(new InboxStore(f.store.database).get(item.id).taskId).toBeNull();
    expect(f.persistence.journal(item.id).find(entry => entry.operationId === "link-during-responder-change")?.state).toBe("parked");
    expect(f.state).toMatchObject({ spawned: 0, sent: 0, callbacks: 0 });
  });

  it("still links the retained responder when a user comment does not change executor ownership", async () => {
    const f = ordinaryOwners();
    f.store.tasks.createComment({ taskId: f.task.id, kind: "agent", authorName: "First executor", threadId: f.first, body: "Current implementation" });
    const { item } = await f.incoming(f.task.key);
    expect((await preview(f, item.id)).proposal?.threadId).toBe(f.first);
    f.store.tasks.createComment({ taskId: f.task.id, kind: "user", authorName: "Operator", body: "Keep the same executor; no notification requested" });
    expect((await f.routing.getInboxRoute({ id: item.id })).stale).toBe(false);
    const result = routeOutcomeSchema.parse(await f.harness.callRpc("applyInboxRoute", { id: item.id, operationId: "link-unchanged-responder", grantId: null, expectedRevision: 1, action: { kind: "link" } }));
    expect(result).toMatchObject({ state: "applied", item: { taskId: f.task.id, state: "resolved" }, proposal: { threadId: f.first } });
    expect(f.state).toMatchObject({ spawned: 0, sent: 0, callbacks: 0 });
  });
});

describe("review regressions: newly selected profile commit fences", () => {
  it.each(["unchanged", "unrelated-profile", "model", "payer"] as const)("retains only a validated model and payer after %s changes during target validation", async change => {
    const f = setup();
    f.store.tasks.updateProject(f.project.id, { linkedBbProjectId: "proj_code" });
    f.harness.sdk.stub("hosts.list", async () => [{ id: "host_one", name: "One", status: "connected" }]);
    f.harness.sdk.stub("projects.get", async () => ({ id: "proj_code", name: "Code", sources: [{ hostId: "host_one", type: "local_path", path: "/code", isDefault: true }] }));
    f.harness.sdk.stub("experimental_executionContexts.list", async () => [{ id: "context_one", name: "Context", enabled: true, projectIds: ["proj_code"] }]);
    f.harness.sdk.stub("experimental_modelConnections.list", async () => ["account_a", "account_b", "account_changed"].map(id => ({ id, name: id, enabled: true, revoked: false, provider: "acp-omp", hostId: "host_one", gateway: null })));
    f.harness.sdk.stub("providers.list", async () => [{ id: "acp-omp", available: true, capabilities: { permissionModes: ["full"] } }]);
    const profileInput = { providerId: "acp-omp", modelId: "model_a", reasoningLevel: "high", permissionMode: "full" as const, serviceTier: null, environmentKind: "project-default" as const, baseBranch: null, machineId: null, executionContextId: "context_one", modelConnectionId: "account_a", instructions: "Explicit registry selection" };
    const currentProfile = f.store.tasks.createPreset({ ...profileInput, name: "Currently persisted A" });
    const selectedProfile = f.store.tasks.createPreset({ ...profileInput, name: "Newly selected B", modelId: "model_b", modelConnectionId: "account_b" });
    const unrelatedProfile = f.store.tasks.createPreset({ ...profileInput, name: "Unrelated C" });
    const task = f.store.tasks.createTask({ projectId: f.project.id, title: "Select a different execution profile" });
    const executions = new ExecutionStore(f.store.database);
    const originalTarget = { bbProjectId: "proj_code", hostId: "host_one", presetId: currentProfile.id, workspace: { kind: "managed-worktree" as const, baseBranch: "main" } };
    executions.setTarget(task.id, originalTarget);
    const { item } = await f.incoming(task.key);
    expect((await preview(f, item.id)).proposal).toMatchObject({ target: { presetId: currentProfile.id, executionContextId: "context_one", modelConnectionId: "account_a" }, targetIssue: null });
    const entered = createDeferredPromise<void>();
    const release = createDeferredPromise<void>();
    f.harness.sdk.stub("providers.models", async () => {
      entered.resolve();
      await release.promise;
      return { modelLoadError: null, models: [{ id: "model_b", model: "model_b", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }], selectedOnlyModels: [] };
    });
    const selectedTarget = { ...originalTarget, presetId: selectedProfile.id };
    const pending = f.harness.callRpc("applyInboxRoute", { id: item.id, operationId: "select-profile-b", grantId: null, expectedRevision: 1, action: { kind: "target", target: selectedTarget } });
    await entered.promise;
    try {
      if (change === "model") f.store.tasks.updatePreset(selectedProfile.id, { modelId: "model_changed" });
      if (change === "payer") f.store.tasks.updatePreset(selectedProfile.id, { modelConnectionId: "account_changed" });
      if (change === "unrelated-profile") f.store.tasks.updatePreset(unrelatedProfile.id, { modelConnectionId: "account_changed", modelId: "model_changed" });
    } finally {
      release.resolve();
    }
    const result = routeOutcomeSchema.parse(await pending);
    if ((change === "model" || change === "payer") && result.state === "parked") {
      expect(executions.target(task.id)).toEqual(originalTarget);
    } else {
      expect(result.state).toBe("applied");
      const refreshed = await preview(f, item.id);
      expect(refreshed.proposal?.target).toMatchObject({ executionContextId: "context_one", modelConnectionId: "account_b" });
      expect(f.store.tasks.getPreset(refreshed.proposal!.target!.presetId)?.modelId).toBe("model_b");
      expect(refreshed.proposal?.targetIssue).toBeNull();
    }
    expect(f.persistence.journal(item.id).find(entry => entry.operationId === "select-profile-b")?.state).toBe(result.state);
    expect(f.state).toMatchObject({ spawned: 0, sent: 0, callbacks: 0 });
  });
});

describe("review regressions: explicit separate-new-work answers", () => {
  it("creates separate work once through CLI when conflicting task references are context", async () => {
    const f = setup();
    const first = f.store.tasks.createTask({ projectId: f.project.id, title: "Existing checkout work" });
    const second = f.store.tasks.createTask({ projectId: f.project.id, title: "Existing deployment work" });
    const { item } = await f.incoming(`New integration work related to ${first.key} and ${second.key}`);
    expect(await preview(f, item.id)).toMatchObject({ state: "parked", proposal: { decision: { kind: "clarify" } } });
    const response = await f.harness.runCli(["route", "preview", item.id, "--operation", "answer-separate-work", "--revision", "1", "--source-revision", item.revision, "--project", f.project.prefix, "--new-task", "--json"]);
    expect(response.exitCode).toBe(0);
    const answer = routeOutcomeSchema.parse(JSON.parse(response.stdout));
    expect(answer).toMatchObject({ state: "applied", proposal: { decision: { kind: "new", projectId: f.project.id }, taskId: null, threadId: null } });
    const apply = async () => {
      const result = await f.harness.runCli(["route", "apply", item.id, "--operation", "create-separate-work", "--revision", "2", "--action", JSON.stringify({ kind: "create" }), "--json"]);
      expect(result.exitCode).toBe(0);
      return routeOutcomeSchema.parse(JSON.parse(result.stdout));
    };
    const created = await apply();
    expect(created).toMatchObject({ state: "applied", item: { state: "resolved" } });
    const createdId = z.string().min(1).parse(created.item?.taskId);
    expect(createdId).not.toBe(first.id);
    expect(createdId).not.toBe(second.id);
    expect(f.store.tasks.getTask(createdId)).toMatchObject({ projectId: f.project.id, title: item.title });
    expect(await apply()).toEqual(created);
    expect(f.store.tasks.listTasks().map(task => task.id).sort()).toEqual([first.id, second.id, createdId].sort());
    expect(f.store.tasks.getTask(first.id)).toEqual(first);
    expect(f.store.tasks.getTask(second.id)).toEqual(second);
    expect(f.state).toMatchObject({ spawned: 0, sent: 0, callbacks: 0 });
  });

  it("does not treat separate-new-work intent as permission to infer a tracker project", async () => {
    const f = setup();
    const first = f.store.tasks.createTask({ projectId: f.project.id, title: "Checkout" });
    const second = f.store.tasks.createTask({ projectId: f.project.id, title: "Deployment" });
    const { item } = await f.incoming(`Separate work related to ${first.key} and ${second.key}`);
    const answer = await preview(f, item.id, { projectId: null, newTask: true });
    expect(answer.state).toBe("parked");
    const applied = routeOutcomeSchema.parse(await f.harness.callRpc("applyInboxRoute", { id: item.id, operationId: "create-without-project", grantId: null, expectedRevision: 1, action: { kind: "create" } }));
    expect(applied.state).toBe("parked");
    expect(new InboxStore(f.store.database).get(item.id).taskId).toBeNull();
    expect(f.store.tasks.listTasks().map(task => task.id).sort()).toEqual([first.id, second.id].sort());
    expect(f.state).toMatchObject({ spawned: 0, sent: 0, callbacks: 0 });
  });

  it("preserves an already linked intake owner instead of creating separate work again", async () => {
    const f = setup();
    const first = f.store.tasks.createTask({ projectId: f.project.id, title: "Linked native owner" });
    const second = f.store.tasks.createTask({ projectId: f.project.id, title: "Context only" });
    const { item } = await f.incoming(`Related to ${first.key} and ${second.key}`);
    await f.harness.callRpc("linkInboxTask", { id: item.id, taskId: first.id });
    const answer = await preview(f, item.id, { newTask: true });
    expect(answer.proposal?.decision).toMatchObject({ kind: "existing", taskId: first.id });
    const applied = routeOutcomeSchema.parse(await f.harness.callRpc("applyInboxRoute", { id: item.id, operationId: "do-not-recreate-linked-intake", grantId: null, expectedRevision: 1, action: { kind: "create" } }));
    expect(applied.state).toBe("parked");
    expect(new InboxStore(f.store.database).get(item.id).taskId).toBe(first.id);
    expect(f.store.tasks.listTasks().map(task => task.id).sort()).toEqual([first.id, second.id].sort());
    expect(f.state).toMatchObject({ spawned: 0, sent: 0, callbacks: 0 });
  });
});
