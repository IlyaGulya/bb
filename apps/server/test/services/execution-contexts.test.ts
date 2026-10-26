import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createConnection, createProject, createThread, deleteExecutionContext,
  executionContextProjects, executionContexts, getExecutionContext, getModelConnection,
  getProjectContextDefaults, getThreadExecutionBinding, modelConnections, noopNotifier,
  persistThreadExecutionBinding, saveExecutionContext, saveModelConnection,
  setProjectContextDefaults, threadExecutionBindings, threads, upsertHost,
  type DbConnection,
} from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import { executionContextSchema, modelConnectionSchema } from "@bb/domain";
import { createExecutionContextRequestSchema, updateExecutionContextRequestSchema, updateModelConnectionRequestSchema } from "@bb/server-contract";
import {
  assertThreadExecutionBindingAvailable, createExecutionContextDefinition,
  deleteConnectionDefinition, deleteContextDefinition, resolveThreadExecutionBinding,
  resolveProjectExecutionContext,
  updateExecutionContextDefinition, updateModelConnectionDefinition, updateProjectContextDefaults,
} from "../../src/services/execution-contexts.js";

let db: DbConnection;
let projectId: string;
let otherProjectId: string;
const hostId = "context-host";

beforeEach(() => {
  db = createMigratedConnection();
  upsertHost(db, noopNotifier, { id: hostId, name: "Local native host" });
  upsertHost(db, noopNotifier, { id: "other-host", name: "Other host" });
  projectId = createProject(db, noopNotifier, { name: "Repository", source: { type: "local_path", hostId, path: "/fixtures/repository" } }).project.id;
  otherProjectId = createProject(db, noopNotifier, { name: "Other repository", source: { type: "local_path", hostId, path: "/fixtures/other" } }).project.id;
});
afterEach(() => db.$client.close());

function connection(id: string, provider = "claude-native", selectedHostId = hostId) {
  return saveModelConnection(db, modelConnectionSchema.parse({ id, name: id, provider, hostId: selectedHostId, nativeAuth: { configDir: `/fixtures/auth/${id}` }, createdAt: 1, updatedAt: 1 }));
}
function context(id: string, defaultModelConnectionId: string | null = null) {
  return saveExecutionContext(db, executionContextSchema.parse({ id, name: id, projectIds: [projectId], instructions: `Only ${id}`, defaultModelConnectionId, createdAt: 1, updatedAt: 1 }));
}
function resolve(executionContextId?: string, modelConnectionId?: string) {
  return resolveThreadExecutionBinding(db, { projectId, hostId, executionContextId, modelConnectionId });
}

describe("native execution context persistence and selection", () => {
  it("represents all four independent context/account combinations in durable threads", () => {
    context("work");
    context("personal");
    connection("work-account");
    connection("personal-account", "omp-native");
    const expected: string[] = [];
    for (const executionContextId of ["work", "personal"]) {
      for (const modelConnectionId of ["work-account", "personal-account"]) {
        const binding = resolve(executionContextId, modelConnectionId)!;
        const thread = createThread(db, noopNotifier, { projectId, providerId: binding.modelConnection!.provider, executionBinding: binding });
        expected.push(thread.id);
      }
    }
    const directory = mkdtempSync(join(tmpdir(), "bb-context-reopen-"));
    try {
      const path = join(directory, "bb.sqlite");
      writeFileSync(path, db.$client.serialize());
      const reopened = createConnection(path);
      try {
        expect(expected.map((id) => {
          const binding = getThreadExecutionBinding(reopened, id)!;
          return [binding.executionContext!.id, binding.modelConnection!.id];
        })).toEqual([["work", "work-account"], ["work", "personal-account"], ["personal", "work-account"], ["personal", "personal-account"]]);
        expect(getExecutionContext(reopened, "work")?.projectIds).toEqual([projectId]);
        expect(getModelConnection(reopened, "personal-account")?.provider).toBe("omp-native");
      } finally { reopened.$client.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("applies explicit > preset > project > selected-context defaults without borrowing a sibling account", () => {
    for (const id of ["context-default", "project-default", "preset", "explicit"]) connection(id);
    context("work", "context-default");
    context("personal");
    expect(resolve("work")?.modelConnection?.id).toBe("context-default");
    expect(resolve("personal")?.modelConnection).toBeNull();
    updateProjectContextDefaults(db, { projectId, executionContextId: "work", modelConnectionId: "project-default" });
    expect(resolve()?.modelConnection?.id).toBe("project-default");
    const presetArgs = { projectId, hostId, presetExecutionContextId: "personal", presetModelConnectionId: "preset" };
    expect(resolveThreadExecutionBinding(db, presetArgs)?.executionContext?.id).toBe("personal");
    expect(resolveThreadExecutionBinding(db, presetArgs)?.modelConnection?.id).toBe("preset");
    expect(resolveThreadExecutionBinding(db, { ...presetArgs, executionContextId: "work", modelConnectionId: "explicit" })?.modelConnection?.id).toBe("explicit");
    expect(resolveThreadExecutionBinding(db, { ...presetArgs, executionContextId: "work", modelConnectionId: "explicit" })?.executionContext?.id).toBe("work");
  });

  it("refuses unavailable, disabled, revoked, incompatible provider/host and non-member choices without fallback", () => {
    connection("available");
    context("work", "available");
    expect(() => resolve("work", "missing")).toThrow(/does not exist/);
    expect(() => resolveThreadExecutionBinding(db, { projectId, hostId, executionContextId: "missing" })).toThrow(/does not exist/);
    expect(() => resolveThreadExecutionBinding(db, { projectId: otherProjectId, hostId, executionContextId: "work" })).toThrow(/not a member/);
    expect(() => resolveThreadExecutionBinding(db, { projectId, hostId: "other-host", modelConnectionId: "available" })).toThrow(/not execution host/);
    expect(() => resolveThreadExecutionBinding(db, { projectId, hostId, provider: "omp-native", modelConnectionId: "available" })).toThrow(/not omp-native/);
    expect(() => resolveThreadExecutionBinding(db, { projectId, hostId: null, executionContextId: "work" })).toThrow(/concrete execution host/);
    updateModelConnectionDefinition(db, { id: "available", enabled: false });
    expect(() => resolve("work")).toThrow(/disabled/);
    updateModelConnectionDefinition(db, { id: "available", enabled: true, revoked: true });
    expect(() => resolve("work")).toThrow(/revoked/);
    updateModelConnectionDefinition(db, { id: "available", revoked: false });
    updateExecutionContextDefinition(db, { id: "work", enabled: false });
    expect(() => resolve("work")).toThrow(/disabled/);
  });

  it("keeps immutable thread snapshots when definitions/defaults change while live revocation still refuses continuation", () => {
    connection("native");
    context("work", "native");
    const binding = resolve("work")!;
    const thread = createThread(db, noopNotifier, { projectId, providerId: "claude-native", executionBinding: binding });
    updateExecutionContextDefinition(db, { id: "work", instructions: "New instruction", name: "Renamed context" });
    updateModelConnectionDefinition(db, { id: "native", name: "Renamed account", nativeAuth: { configDir: "/fixtures/auth/changed", profile: null, hostEnv: null } });
    setProjectContextDefaults(db, { projectId, executionContextId: null, modelConnectionId: "native" });
    expect(getThreadExecutionBinding(db, thread.id)).toEqual({ ...binding, threadId: thread.id });
    expect(() => persistThreadExecutionBinding(db, thread.id, resolve("work"))).toThrow();
    assertThreadExecutionBindingAvailable(db, getThreadExecutionBinding(db, thread.id));
    updateModelConnectionDefinition(db, { id: "native", revoked: true });
    expect(() => assertThreadExecutionBindingAvailable(db, getThreadExecutionBinding(db, thread.id))).toThrow(/revoked/);
    expect(getThreadExecutionBinding(db, thread.id)?.modelConnection?.revoked).toBe(false);
  });

  it("persists context-only or connection-only bindings and leaves legacy threads unassigned", () => {
    context("work");
    connection("native");
    const contextOnly = resolve("work")!;
    const connectionOnly = resolve(undefined, "native")!;
    expect(contextOnly.modelConnection).toBeNull();
    expect(connectionOnly.executionContext).toBeNull();
    const legacy = createThread(db, noopNotifier, { projectId, providerId: "unchanged-provider" });
    expect(resolveThreadExecutionBinding(db, { projectId, hostId: null })).toBeNull();
    expect(getThreadExecutionBinding(db, legacy.id)).toBeNull();
    expect(db.select().from(threadExecutionBindings).all()).toEqual([]);
    expect(getProjectContextDefaults(db, projectId)).toEqual({ projectId, executionContextId: null, modelConnectionId: null });
    const scoped = createThread(db, noopNotifier, { projectId, providerId: "native", executionBinding: contextOnly });
    const connected = createThread(db, noopNotifier, { projectId, providerId: "native", executionBinding: connectionOnly });
    expect(getThreadExecutionBinding(db, scoped.id)).toMatchObject({ executionContext: { id: "work" }, modelConnection: null });
    expect(getThreadExecutionBinding(db, connected.id)).toMatchObject({ executionContext: null, modelConnection: { id: "native" } });
    db.delete(threads).run();
    expect(db.select().from(threadExecutionBindings).all()).toEqual([]);
  });

  it("rolls back the thread and snapshot together when binding validation fails", () => {
    context("work");
    const binding = resolve("work")!;
    expect(() => createThread(db, noopNotifier, { projectId, providerId: "native", executionBinding: { ...binding, createdAt: -1 } })).toThrow();
    expect(db.select().from(threads).all()).toEqual([]);
    expect(db.select().from(threadExecutionBindings).all()).toEqual([]);
    expect(() => persistThreadExecutionBinding(db, "missing-thread", binding)).toThrow();
  });

  it("prevents dangling defaults and permits definition removal without deleting historical snapshots", () => {
    connection("native");
    context("work", "native");
    updateProjectContextDefaults(db, { projectId, executionContextId: "work", modelConnectionId: "native" });
    expect(() => deleteConnectionDefinition(db, "native")).toThrow(/Clear or replace/);
    expect(() => deleteContextDefinition(db, "work")).toThrow(/Clear or replace/);
    expect(() => updateExecutionContextDefinition(db, { id: "work", projectIds: [] })).toThrow(/removing membership/);
    const binding = resolve()!;
    const thread = createThread(db, noopNotifier, { projectId, providerId: "native", executionBinding: binding });
    updateProjectContextDefaults(db, { projectId, executionContextId: null, modelConnectionId: null });
    deleteExecutionContext(db, "work");
    deleteConnectionDefinition(db, "native");
    expect(db.select().from(executionContexts).all()).toEqual([]);
    expect(db.select().from(executionContextProjects).all()).toEqual([]);
    expect(db.select().from(modelConnections).all()).toEqual([]);
    expect(getThreadExecutionBinding(db, thread.id)).toEqual({ ...binding, threadId: thread.id });
  });

  it("validates create input once and keeps omitted patch fields unchanged", () => {
    const created = createExecutionContextDefinition(db, createExecutionContextRequestSchema.parse({ name: "Scoped", projectIds: [projectId], instructions: "Keep this", skillRoots: ["/fixtures/skills"], autoMemory: true }));
    updateExecutionContextDefinition(db, updateExecutionContextRequestSchema.parse({ id: created.id, name: "Renamed" }));
    expect(getExecutionContext(db, created.id)).toMatchObject({ name: "Renamed", instructions: "Keep this", skillRoots: ["/fixtures/skills"], autoMemory: true, projectIds: [projectId] });
    connection("native");
    updateModelConnectionDefinition(db, { id: "native", enabled: false, revoked: true });
    updateModelConnectionDefinition(db, updateModelConnectionRequestSchema.parse({ id: "native", name: "Renamed" }));
    expect(getModelConnection(db, "native")).toMatchObject({ enabled: false, revoked: true, nativeAuth: { configDir: "/fixtures/auth/native" } });
    expect(() => createExecutionContextRequestSchema.parse({ name: "Bad", token: "not-allowed" })).toThrow();
  });
  it("resolves project context discovery without requiring a native account or host", () => {
    expect(resolveProjectExecutionContext(db, { projectId })).toBeNull();
    connection("native");
    context("work", "native");
    context("personal");
    updateProjectContextDefaults(db, { projectId, executionContextId: "work", modelConnectionId: "native" });
    updateModelConnectionDefinition(db, { id: "native", revoked: true });
    expect(resolveProjectExecutionContext(db, { projectId })?.id).toBe("work");
    expect(resolveProjectExecutionContext(db, { projectId, executionContextId: "personal" })?.id).toBe("personal");
    expect(() => resolveProjectExecutionContext(db, { projectId: otherProjectId, executionContextId: "personal" })).toThrow(/not a member/);
    updateExecutionContextDefinition(db, { id: "personal", enabled: false });
    expect(() => resolveProjectExecutionContext(db, { projectId, executionContextId: "personal" })).toThrow(/disabled/);
  });
});
