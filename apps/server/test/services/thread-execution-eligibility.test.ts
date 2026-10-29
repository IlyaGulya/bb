import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  closeSession,
  createEnvironment,
  createProject,
  createThread,
  getThreadExecutionBinding,
  noopNotifier,
  openSession,
  saveExecutionContext,
  saveModelConnection,
  threads,
  upsertHost,
  type DbConnection,
} from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import { executionContextSchema, modelConnectionSchema } from "@bb/domain";
import {
  deleteConnectionDefinition,
  deleteContextDefinition,
  observeThreadExecutionEligibility,
  resolveThreadExecutionBinding,
  updateExecutionContextDefinition,
  updateModelConnectionDefinition,
} from "../../src/services/execution-contexts.js";
import { NotificationHub } from "../../src/ws/hub.js";

const databases: DbConnection[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.$client.close();
});

function fixture() {
  const db = createMigratedConnection();
  databases.push(db);
  const hub = new NotificationHub();
  const hostId = "host-eligibility";
  upsertHost(db, noopNotifier, { id: hostId, name: "Eligibility host" });
  const projectId = createProject(db, noopNotifier, {
    name: "Eligibility project",
    source: { type: "local_path", hostId, path: "/fixtures/eligibility" },
  }).project.id;
  const environment = createEnvironment(db, noopNotifier, {
    projectId, hostId, path: "/fixtures/eligibility", status: "ready", providerOwnsPath: false,
  });
  const connection = saveModelConnection(db, modelConnectionSchema.parse({
    id: "connection-eligibility", name: "Eligibility connection", provider: "claude-code",
    hostId, createdAt: 1, updatedAt: 1,
  }));
  const context = saveExecutionContext(db, executionContextSchema.parse({
    id: "context-eligibility", name: "Eligibility context", projectIds: [projectId],
    createdAt: 1, updatedAt: 1,
  }));
  const binding = resolveThreadExecutionBinding(db, {
    projectId, hostId, provider: "claude-code", executionContextId: context.id, modelConnectionId: connection.id,
  });
  const thread = createThread(db, noopNotifier, {
    projectId, environmentId: environment.id, providerId: "claude-code", executionBinding: binding,
  });
  const connect = () => {
    const session = openSession(db, {
      hostId, instanceId: "synthetic-instance", hostName: "Eligibility host", dataDir: "/fixtures/data",
      protocolVersion: 1, heartbeatIntervalMs: 10_000, leaseTimeoutMs: 30_000,
    });
    hub.registerDaemon(session.id, hostId, { send: vi.fn(), close: vi.fn() });
    return session;
  };
  const session = connect();
  return {
    db, hub, hostId, projectId, environment, connection, context, thread, session, connect,
    observe: () => observeThreadExecutionEligibility({ db, hub }, thread.id),
  };
}

describe("current execution eligibility separate from frozen receipt", () => {
  it("changes routing generation for a new environment on the same connected host without rewriting the receipt", () => {
    const f = fixture();
    const before = f.observe();
    const replacement = createEnvironment(f.db, noopNotifier, {
      projectId: f.projectId, hostId: f.hostId, path: "/fixtures/replacement", status: "ready", providerOwnsPath: false,
    });
    f.db.update(threads).set({ environmentId: replacement.id }).where(eq(threads.id, f.thread.id)).run();
    const after = f.observe();
    expect(before).toMatchObject({ available: true, thread: { environmentId: f.environment.id } });
    expect(after).toMatchObject({ available: true, thread: { environmentId: replacement.id }, host: { id: f.hostId, status: "connected" } });
    expect(after.generation).not.toBe(before.generation);
    expect(after.binding).toEqual(before.binding);
    expect(getThreadExecutionBinding(f.db, f.thread.id)).toEqual(before.binding);
  });

  it("rejects a closed database session even while the hub still owns its socket and fences a replacement connected session", () => {
    const f = fixture();
    const before = f.observe();
    closeSession(f.db, noopNotifier, f.session.id, "synthetic-disconnect");
    expect(f.hub.getDaemonSessionIdForHost(f.hostId)).toBe(f.session.id);
    const disconnected = f.observe();
    expect(disconnected).toMatchObject({
      available: false, host: { status: "disconnected" }, issue: { code: "execution_host_disconnected" },
    });
    expect(disconnected.binding).toEqual(before.binding);
    f.connect();
    const replacement = f.observe();
    expect(replacement).toMatchObject({ available: true, host: { id: f.hostId, status: "connected" } });
    expect(replacement.generation).not.toBe(before.generation);
    expect(replacement.binding).toEqual(before.binding);
  });

  it.each([
    ["connection-disabled", "model_connection_disabled"],
    ["connection-revoked", "model_connection_revoked"],
    ["connection-removed", "model_connection_not_found"],
    ["context-disabled", "execution_context_disabled"],
    ["context-removed", "execution_context_not_found"],
    ["project-grant-removed", "execution_context_project_mismatch"],
  ] as const)("withdraws eligibility after %s while preserving the frozen selection", (change, code) => {
    const f = fixture();
    const before = f.observe();
    if (change === "connection-disabled") updateModelConnectionDefinition(f.db, { id: f.connection.id, enabled: false });
    if (change === "connection-revoked") updateModelConnectionDefinition(f.db, { id: f.connection.id, revoked: true });
    if (change === "connection-removed") deleteConnectionDefinition(f.db, f.connection.id);
    if (change === "context-disabled") updateExecutionContextDefinition(f.db, { id: f.context.id, enabled: false });
    if (change === "context-removed") deleteContextDefinition(f.db, f.context.id);
    if (change === "project-grant-removed") updateExecutionContextDefinition(f.db, { id: f.context.id, projectIds: [] });
    const after = f.observe();
    expect(before.available).toBe(true);
    expect(after).toMatchObject({ available: false, issue: { code } });
    expect(after.generation).not.toBe(before.generation);
    expect(after.binding).toEqual(before.binding);
    expect(getThreadExecutionBinding(f.db, f.thread.id)).toEqual(before.binding);
  });

  it("does not invalidate eligible execution for an unrelated thread-title update", () => {
    const f = fixture();
    const before = f.observe();
    f.db.update(threads).set({ title: "A different display title" }).where(eq(threads.id, f.thread.id)).run();
    const after = f.observe();
    expect(before.available).toBe(true);
    expect(after).toMatchObject({ available: true, issue: null, generation: before.generation, binding: before.binding });
  });
});
