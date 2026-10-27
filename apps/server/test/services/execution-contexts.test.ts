import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  createConnection,
  createProject,
  createThread,
  deleteExecutionContext,
  executionContextProjects,
  executionContexts,
  getExecutionContext,
  getModelConnection,
  getProjectContextDefaults,
  getThreadExecutionBinding,
  modelConnections,
  noopNotifier,
  persistThreadExecutionBinding,
  saveExecutionContext,
  saveModelConnection,
  setProjectContextDefaults,
  threadExecutionBindings,
  threads,
  upsertHost,
  updateHost,
  type DbConnection,
} from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import { executionContextSchema, modelConnectionSchema } from "@bb/domain";
import {
  createExecutionContextRequestSchema,
  createModelConnectionRequestSchema,
  updateExecutionContextRequestSchema,
  updateModelConnectionRequestSchema,
} from "@bb/server-contract";
import {
  assertThreadExecutionBindingAvailable,
  createExecutionContextDefinition,
  createModelConnectionDefinition,
  deleteConnectionDefinition,
  deleteContextDefinition,
  resolveThreadExecutionBinding,
  resolveProjectExecutionContext,
  updateExecutionContextDefinition,
  updateModelConnectionDefinition,
  updateProjectContextDefaults,
} from "../../src/services/execution-contexts.js";

let db: DbConnection;
let projectId: string;
let otherProjectId: string;
const hostId = "context-host";

beforeEach(() => {
  db = createMigratedConnection();
  upsertHost(db, noopNotifier, { id: hostId, name: "Local native host" });
  upsertHost(db, noopNotifier, { id: "other-host", name: "Other host" });
  projectId = createProject(db, noopNotifier, {
    name: "Repository",
    source: { type: "local_path", hostId, path: "/fixtures/repository" },
  }).project.id;
  otherProjectId = createProject(db, noopNotifier, {
    name: "Other repository",
    source: { type: "local_path", hostId, path: "/fixtures/other" },
  }).project.id;
});
afterEach(() => db.$client.close());

function connection(
  id: string,
  provider = "claude-native",
  selectedHostId = hostId,
) {
  return saveModelConnection(
    db,
    modelConnectionSchema.parse({
      id,
      name: id,
      provider,
      hostId: selectedHostId,
      nativeAuth: { configDir: `/fixtures/auth/${id}` },
      createdAt: 1,
      updatedAt: 1,
    }),
  );
}
function gatewayConnection(
  id: string,
  allowedHostIds = [hostId],
  provider = "acp-omp",
) {
  return createModelConnectionDefinition(
    db,
    createModelConnectionRequestSchema.parse({
      name: id,
      provider,
      hostId: null,
      gateway: {
        baseUrl: "https://gateway.example/v1",
        protocol:
          provider === "claude-code"
            ? "anthropic-messages"
            : "openai-responses",
        accountPrefix: "personal",
        modelProvider: "openai-codex",
        credential: { kind: "env", name: "CPA_MODEL_KEY" },
        allowedHostIds,
      },
    }),
  );
}
function context(id: string, defaultModelConnectionId: string | null = null) {
  return saveExecutionContext(
    db,
    executionContextSchema.parse({
      id,
      name: id,
      projectIds: [projectId],
      instructions: `Only ${id}`,
      defaultModelConnectionId,
      createdAt: 1,
      updatedAt: 1,
    }),
  );
}
function resolve(executionContextId?: string, modelConnectionId?: string) {
  return resolveThreadExecutionBinding(db, {
    projectId,
    hostId,
    executionContextId,
    modelConnectionId,
  });
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
        const thread = createThread(db, noopNotifier, {
          projectId,
          providerId: binding.modelConnection!.provider,
          executionBinding: binding,
        });
        expected.push(thread.id);
      }
    }
    const directory = mkdtempSync(join(tmpdir(), "bb-context-reopen-"));
    try {
      const path = join(directory, "bb.sqlite");
      writeFileSync(path, db.$client.serialize());
      const reopened = createConnection(path);
      try {
        expect(
          expected.map((id) => {
            const binding = getThreadExecutionBinding(reopened, id)!;
            return [binding.executionContext!.id, binding.modelConnection!.id];
          }),
        ).toEqual([
          ["work", "work-account"],
          ["work", "personal-account"],
          ["personal", "work-account"],
          ["personal", "personal-account"],
        ]);
        expect(getExecutionContext(reopened, "work")?.projectIds).toEqual([
          projectId,
        ]);
        expect(getModelConnection(reopened, "personal-account")?.provider).toBe(
          "omp-native",
        );
      } finally {
        reopened.$client.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("applies explicit > preset > project > selected-context defaults without borrowing a sibling account", () => {
    for (const id of [
      "context-default",
      "project-default",
      "preset",
      "explicit",
    ])
      connection(id);
    context("work", "context-default");
    context("personal");
    expect(resolve("work")?.modelConnection?.id).toBe("context-default");
    expect(resolve("personal")?.modelConnection).toBeNull();
    updateProjectContextDefaults(db, {
      projectId,
      executionContextId: "work",
      modelConnectionId: "project-default",
    });
    expect(resolve()?.modelConnection?.id).toBe("project-default");
    const presetArgs = {
      projectId,
      hostId,
      presetExecutionContextId: "personal",
      presetModelConnectionId: "preset",
    };
    expect(
      resolveThreadExecutionBinding(db, presetArgs)?.executionContext?.id,
    ).toBe("personal");
    expect(
      resolveThreadExecutionBinding(db, presetArgs)?.modelConnection?.id,
    ).toBe("preset");
    expect(
      resolveThreadExecutionBinding(db, {
        ...presetArgs,
        executionContextId: "work",
        modelConnectionId: "explicit",
      })?.modelConnection?.id,
    ).toBe("explicit");
    expect(
      resolveThreadExecutionBinding(db, {
        ...presetArgs,
        executionContextId: "work",
        modelConnectionId: "explicit",
      })?.executionContext?.id,
    ).toBe("work");
  });

  it("refuses unavailable, disabled, revoked, incompatible provider/host and non-member choices without fallback", () => {
    connection("available");
    context("work", "available");
    expect(() => resolve("work", "missing")).toThrow(/does not exist/);
    expect(() =>
      resolveThreadExecutionBinding(db, {
        projectId,
        hostId,
        executionContextId: "missing",
      }),
    ).toThrow(/does not exist/);
    expect(() =>
      resolveThreadExecutionBinding(db, {
        projectId: otherProjectId,
        hostId,
        executionContextId: "work",
      }),
    ).toThrow(/not a member/);
    expect(() =>
      resolveThreadExecutionBinding(db, {
        projectId,
        hostId: "other-host",
        modelConnectionId: "available",
      }),
    ).toThrow(/not execution host/);
    expect(() =>
      resolveThreadExecutionBinding(db, {
        projectId,
        hostId,
        provider: "omp-native",
        modelConnectionId: "available",
      }),
    ).toThrow();
    expect(() =>
      resolveThreadExecutionBinding(db, {
        projectId,
        hostId: null,
        executionContextId: "work",
      }),
    ).toThrow(/concrete execution host/);
    updateModelConnectionDefinition(db, { id: "available", enabled: false });
    expect(() => resolve("work")).toThrow(/disabled/);
    updateModelConnectionDefinition(db, {
      id: "available",
      enabled: true,
      revoked: true,
    });
    expect(() => resolve("work")).toThrow(/revoked/);
    updateModelConnectionDefinition(db, { id: "available", revoked: false });
    updateExecutionContextDefinition(db, { id: "work", enabled: false });
    expect(() => resolve("work")).toThrow(/disabled/);
  });

  it("keeps immutable thread snapshots when definitions/defaults change while live revocation still refuses continuation", () => {
    connection("native");
    context("work", "native");
    const binding = resolve("work")!;
    const thread = createThread(db, noopNotifier, {
      projectId,
      providerId: "claude-native",
      executionBinding: binding,
    });
    updateExecutionContextDefinition(db, {
      id: "work",
      instructions: "New instruction",
      name: "Renamed context",
    });
    updateModelConnectionDefinition(db, {
      id: "native",
      name: "Renamed account",
      nativeAuth: {
        configDir: "/fixtures/auth/changed",
        profile: null,
        hostEnv: null,
      },
    });
    setProjectContextDefaults(db, {
      projectId,
      executionContextId: null,
      modelConnectionId: "native",
    });
    expect(getThreadExecutionBinding(db, thread.id)).toEqual({
      ...binding,
      threadId: thread.id,
    });
    expect(() =>
      persistThreadExecutionBinding(db, thread.id, resolve("work")),
    ).toThrow();
    assertThreadExecutionBindingAvailable(
      db,
      getThreadExecutionBinding(db, thread.id),
    );
    updateModelConnectionDefinition(db, { id: "native", revoked: true });
    expect(() =>
      assertThreadExecutionBindingAvailable(
        db,
        getThreadExecutionBinding(db, thread.id),
      ),
    ).toThrow(/revoked/);
    expect(
      getThreadExecutionBinding(db, thread.id)?.modelConnection?.revoked,
    ).toBe(false);
  });

  it("persists context-only or connection-only bindings and leaves legacy threads unassigned", () => {
    context("work");
    connection("native");
    const contextOnly = resolve("work")!;
    const connectionOnly = resolve(undefined, "native")!;
    expect(contextOnly.modelConnection).toBeNull();
    expect(connectionOnly.executionContext).toBeNull();
    const legacy = createThread(db, noopNotifier, {
      projectId,
      providerId: "unchanged-provider",
    });
    expect(
      resolveThreadExecutionBinding(db, { projectId, hostId: null }),
    ).toBeNull();
    expect(getThreadExecutionBinding(db, legacy.id)).toBeNull();
    expect(db.select().from(threadExecutionBindings).all()).toEqual([]);
    expect(getProjectContextDefaults(db, projectId)).toEqual({
      projectId,
      executionContextId: null,
      modelConnectionId: null,
    });
    const scoped = createThread(db, noopNotifier, {
      projectId,
      providerId: "native",
      executionBinding: contextOnly,
    });
    const connected = createThread(db, noopNotifier, {
      projectId,
      providerId: "native",
      executionBinding: connectionOnly,
    });
    expect(getThreadExecutionBinding(db, scoped.id)).toMatchObject({
      executionContext: { id: "work" },
      modelConnection: null,
    });
    expect(getThreadExecutionBinding(db, connected.id)).toMatchObject({
      executionContext: null,
      modelConnection: { id: "native" },
    });
    db.delete(threads).run();
    expect(db.select().from(threadExecutionBindings).all()).toEqual([]);
  });

  it("rolls back the thread and snapshot together when binding validation fails", () => {
    context("work");
    const binding = resolve("work")!;
    expect(() =>
      createThread(db, noopNotifier, {
        projectId,
        providerId: "native",
        executionBinding: { ...binding, createdAt: -1 },
      }),
    ).toThrow();
    expect(db.select().from(threads).all()).toEqual([]);
    expect(db.select().from(threadExecutionBindings).all()).toEqual([]);
    expect(() =>
      persistThreadExecutionBinding(db, "missing-thread", binding),
    ).toThrow();
  });

  it("prevents dangling defaults and permits definition removal without deleting historical snapshots", () => {
    connection("native");
    context("work", "native");
    updateProjectContextDefaults(db, {
      projectId,
      executionContextId: "work",
      modelConnectionId: "native",
    });
    expect(() => deleteConnectionDefinition(db, "native")).toThrow(
      /Clear or replace/,
    );
    expect(() => deleteContextDefinition(db, "work")).toThrow(
      /Clear or replace/,
    );
    expect(() =>
      updateExecutionContextDefinition(db, { id: "work", projectIds: [] }),
    ).toThrow(/removing membership/);
    const binding = resolve()!;
    const thread = createThread(db, noopNotifier, {
      projectId,
      providerId: "native",
      executionBinding: binding,
    });
    updateProjectContextDefaults(db, {
      projectId,
      executionContextId: null,
      modelConnectionId: null,
    });
    deleteExecutionContext(db, "work");
    deleteConnectionDefinition(db, "native");
    expect(db.select().from(executionContexts).all()).toEqual([]);
    expect(db.select().from(executionContextProjects).all()).toEqual([]);
    expect(db.select().from(modelConnections).all()).toEqual([]);
    expect(getThreadExecutionBinding(db, thread.id)).toEqual({
      ...binding,
      threadId: thread.id,
    });
  });

  it("validates create input once and keeps omitted patch fields unchanged", () => {
    const created = createExecutionContextDefinition(
      db,
      createExecutionContextRequestSchema.parse({
        name: "Scoped",
        projectIds: [projectId],
        instructions: "Keep this",
        skillRoots: ["/fixtures/skills"],
        autoMemory: true,
      }),
    );
    updateExecutionContextDefinition(
      db,
      updateExecutionContextRequestSchema.parse({
        id: created.id,
        name: "Renamed",
      }),
    );
    expect(getExecutionContext(db, created.id)).toMatchObject({
      name: "Renamed",
      instructions: "Keep this",
      skillRoots: ["/fixtures/skills"],
      autoMemory: true,
      projectIds: [projectId],
    });
    connection("native");
    updateModelConnectionDefinition(db, {
      id: "native",
      enabled: false,
      revoked: true,
    });
    updateModelConnectionDefinition(
      db,
      updateModelConnectionRequestSchema.parse({
        id: "native",
        name: "Renamed",
      }),
    );
    expect(getModelConnection(db, "native")).toMatchObject({
      enabled: false,
      revoked: true,
      nativeAuth: { configDir: "/fixtures/auth/native" },
    });
    expect(() =>
      createExecutionContextRequestSchema.parse({
        name: "Bad",
        token: "not-allowed",
      }),
    ).toThrow();
  });
  it("resolves project context discovery without requiring a native account or host", () => {
    expect(resolveProjectExecutionContext(db, { projectId })).toBeNull();
    connection("native");
    context("work", "native");
    context("personal");
    updateProjectContextDefaults(db, {
      projectId,
      executionContextId: "work",
      modelConnectionId: "native",
    });
    updateModelConnectionDefinition(db, { id: "native", revoked: true });
    expect(resolveProjectExecutionContext(db, { projectId })?.id).toBe("work");
    expect(
      resolveProjectExecutionContext(db, {
        projectId,
        executionContextId: "personal",
      })?.id,
    ).toBe("personal");
    expect(() =>
      resolveProjectExecutionContext(db, {
        projectId: otherProjectId,
        executionContextId: "personal",
      }),
    ).toThrow(/not a member/);
    updateExecutionContextDefinition(db, { id: "personal", enabled: false });
    expect(() =>
      resolveProjectExecutionContext(db, {
        projectId,
        executionContextId: "personal",
      }),
    ).toThrow(/disabled/);
  });
});

describe("gateway execution host admission", () => {
  it("rejects contradictory gateway host, provider and native authentication at the create boundary", () => {
    const gateway = {
      baseUrl: "https://gateway.example/v1",
      protocol: "openai-responses",
      accountPrefix: "personal",
      modelProvider: "openai-codex",
      credential: { kind: "env", name: "CPA_MODEL_KEY" },
      allowedHostIds: [hostId],
    };
    const request = {
      name: "Personal gateway",
      provider: "acp-omp",
      hostId: null,
      gateway,
    };
    for (const patch of [
      { hostId },
      { provider: "claude-code" },
      { nativeAuth: { configDir: "/fixtures/native-auth" } },
      { nativeAuth: { profile: "work" } },
      {
        nativeAuth: {
          hostEnv: {
            brokerUrlEnv: "NATIVE_BROKER_URL",
            brokerTokenEnv: "NATIVE_BROKER_TOKEN",
          },
        },
      },
    ])
      expect(() =>
        createModelConnectionDefinition(
          db,
          createModelConnectionRequestSchema.parse({ ...request, ...patch }),
        ),
      ).toThrow();
    expect(db.select().from(modelConnections).all()).toEqual([]);
    expect(createModelConnectionRequestSchema.parse(request)).toMatchObject({
      hostId: null,
      nativeAuth: { configDir: null, profile: null, hostEnv: null },
      gateway,
    });
  });

  it("accepts credential references only and rejects malformed references, raw keys and invalid host lists", () => {
    const gateway = {
      baseUrl: "https://gateway.example/v1",
      protocol: "openai-responses",
      accountPrefix: "personal",
      modelProvider: "openai-codex",
      credential: { kind: "env", name: "CPA_MODEL_KEY" },
      allowedHostIds: [hostId],
    };
    const request = {
      name: "Personal gateway",
      provider: "acp-omp",
      hostId: null,
      gateway,
    };
    for (const credential of [
      { kind: "env", name: "" },
      { kind: "env", name: "1CPA_KEY" },
      { kind: "env", name: "CPA-KEY" },
      { kind: "env", name: "CPA_KEY\n" },
      { kind: "env", name: "CPA_KEY", value: "fake-raw-key" },
      { kind: "file", path: "" },
      { kind: "file", path: "relative/key" },
      { kind: "file", path: "/run/key\0" },
      { kind: "file", path: "/run/key", value: "fake-raw-key" },
      { kind: "literal", value: "fake-raw-key" },
      { kind: "env", name: "CPA_KEY", apiKey: "fake-raw-key" },
    ])
      expect(
        createModelConnectionRequestSchema.safeParse({
          ...request,
          gateway: { ...gateway, credential },
        }).success,
      ).toBe(false);
    for (const allowedHostIds of [[], [hostId, hostId], [""]])
      expect(
        createModelConnectionRequestSchema.safeParse({
          ...request,
          gateway: { ...gateway, allowedHostIds },
        }).success,
      ).toBe(false);
    for (const invalidRequest of [
      { ...request, apiKey: "fake-raw-key" },
      { ...request, gateway: { ...gateway, token: "fake-raw-key" } },
    ])
      expect(
        createModelConnectionRequestSchema.safeParse(invalidRequest).success,
      ).toBe(false);
    expect(
      createModelConnectionRequestSchema.parse({
        ...request,
        gateway: {
          ...gateway,
          credential: { kind: "file", path: "/run/secrets/cpa-key" },
        },
      }).gateway?.credential,
    ).toEqual({ kind: "file", path: "/run/secrets/cpa-key" });
  });

  it("defaults omitted gateway to null for legacy native create input and definitions", () => {
    const input = createModelConnectionRequestSchema.parse({
      name: "Legacy native",
      provider: "acp-omp",
      hostId,
      nativeAuth: { configDir: "/fixtures/native-auth" },
    });
    expect(input.gateway).toBeNull();
    const native = createModelConnectionDefinition(db, input);
    expect(native.gateway).toBeNull();
    expect(getModelConnection(db, native.id)?.gateway).toBeNull();
    expect(
      createModelConnectionRequestSchema.safeParse({
        name: "Missing native host",
        provider: "acp-omp",
        hostId: null,
      }).success,
    ).toBe(false);
  });

  it("selects a gateway without a context but still requires an authorized execution host", () => {
    const connection = gatewayConnection("personal", [hostId, "other-host"]);
    for (const selectedHostId of [hostId, "other-host"]) {
      expect(
        resolveThreadExecutionBinding(db, {
          projectId,
          hostId: selectedHostId,
          provider: "acp-omp",
          modelConnectionId: connection.id,
        }),
      ).toMatchObject({
        executionContext: null,
        modelConnection: { id: connection.id, hostId: null },
      });
    }
    expect(() =>
      resolveThreadExecutionBinding(db, {
        projectId,
        hostId: null,
        modelConnectionId: connection.id,
      }),
    ).toThrow(/concrete execution host/);
    const restricted = gatewayConnection("restricted");
    expect(() =>
      resolveThreadExecutionBinding(db, {
        projectId,
        hostId: "other-host",
        modelConnectionId: restricted.id,
      }),
    ).toThrow(/does not authorize/);
  });

  it.each(["claude-code", "codex"])(
    "admits %s only with its explicit compatible gateway and host",
    (provider) => {
      const selected = gatewayConnection(provider, [hostId], provider);
      expect(
        resolveThreadExecutionBinding(db, {
          projectId,
          hostId,
          provider,
          modelConnectionId: selected.id,
        })?.modelConnection?.provider,
      ).toBe(provider);
      for (const wrongProvider of [
        "acp-omp",
        provider === "codex" ? "claude-code" : "codex",
      ]) {
        let error: unknown;
        try {
          resolveThreadExecutionBinding(db, {
            projectId,
            hostId,
            provider: wrongProvider,
            modelConnectionId: selected.id,
          });
        } catch (cause) {
          error = cause;
        }
        expect(error).toMatchObject({
          body: { code: "model_connection_provider_mismatch" },
        });
      }
      expect(
        createModelConnectionRequestSchema.safeParse({
          name: "incompatible",
          provider,
          hostId: null,
          gateway: {
            ...selected.gateway!,
            protocol:
              provider === "codex" ? "anthropic-messages" : "openai-responses",
          },
        }).success,
      ).toBe(false);
    },
  );

  it("rejects unknown, removing, destroyed and deleted allowed hosts on create and update", () => {
    const connection = gatewayConnection("personal");
    for (const unavailableId of ["missing-host", "other-host"]) {
      if (unavailableId === "other-host")
        updateHost(db, noopNotifier, unavailableId, { phase: "removing" });
      expect(() => gatewayConnection("invalid", [unavailableId])).toThrow(
        unavailableId === "missing-host" ? /does not exist/ : /unavailable/,
      );
      expect(() =>
        updateModelConnectionDefinition(db, {
          id: connection.id,
          gateway: {
            ...connection.gateway!,
            allowedHostIds: [hostId, unavailableId],
          },
        }),
      ).toThrow(
        unavailableId === "missing-host" ? /does not exist/ : /unavailable/,
      );
    }
    for (const hostUpdate of [
      { phase: "destroyed" as const },
      { phase: "active" as const, destroyedAt: 1 },
    ]) {
      updateHost(db, noopNotifier, "other-host", hostUpdate);
      expect(() => gatewayConnection("destroyed", ["other-host"])).toThrow(
        /unavailable/,
      );
      expect(() =>
        updateModelConnectionDefinition(db, {
          id: connection.id,
          gateway: {
            ...connection.gateway!,
            allowedHostIds: ["other-host"],
          },
        }),
      ).toThrow(/unavailable/);
    }
    expect(
      getModelConnection(db, connection.id)?.gateway?.allowedHostIds,
    ).toEqual([hostId]);
  });

  it("can disable and revoke a gateway after an allowed host is retired", () => {
    const disabled = gatewayConnection("disable", [hostId, "other-host"]);
    const revoked = gatewayConnection("revoke", [hostId, "other-host"]);
    updateHost(db, noopNotifier, "other-host", { phase: "destroyed" });
    expect(
      updateModelConnectionDefinition(db, { id: disabled.id, enabled: false }),
    ).toMatchObject({ id: disabled.id, enabled: false });
    expect(
      updateModelConnectionDefinition(db, { id: revoked.id, revoked: true }),
    ).toMatchObject({ id: revoked.id, revoked: true });
  });

  it("keeps the old gateway config and checks both immutable and current host grants on continuation", () => {
    const connection = gatewayConnection("personal");
    const binding = resolve(undefined, connection.id)!;
    const thread = createThread(db, noopNotifier, {
      projectId,
      providerId: "acp-omp",
      executionBinding: binding,
    });
    updateModelConnectionDefinition(db, {
      id: connection.id,
      gateway: {
        ...connection.gateway!,
        baseUrl: "https://replacement.example/v1",
        protocol: "anthropic-messages",
        accountPrefix: "replacement",
        modelProvider: "anthropic",
        credential: { kind: "file", path: "/run/secrets/replacement-key" },
        allowedHostIds: [hostId, "other-host"],
      },
    });
    const snapshot = getThreadExecutionBinding(db, thread.id)!;
    expect(snapshot.modelConnection).toEqual(connection);
    expect(() =>
      assertThreadExecutionBindingAvailable(db, snapshot, hostId, "acp-omp"),
    ).not.toThrow();
    expect(() =>
      assertThreadExecutionBindingAvailable(
        db,
        snapshot,
        "other-host",
        "acp-omp",
      ),
    ).toThrow(/does not authorize/);
    updateModelConnectionDefinition(db, {
      id: connection.id,
      gateway: { ...connection.gateway!, allowedHostIds: ["other-host"] },
    });
    expect(() =>
      assertThreadExecutionBindingAvailable(db, snapshot, hostId, "acp-omp"),
    ).toThrow(/does not authorize/);
    expect(getThreadExecutionBinding(db, thread.id)).toEqual(snapshot);
  });

  it("refuses disabled, revoked, missing and unavailable gateway continuation without substituting defaults", () => {
    const connection = gatewayConnection("personal");
    const binding = resolve(undefined, connection.id)!;
    updateModelConnectionDefinition(db, { id: connection.id, enabled: false });
    expect(() =>
      assertThreadExecutionBindingAvailable(db, binding, hostId, "acp-omp"),
    ).toThrow(/disabled/);
    updateModelConnectionDefinition(db, {
      id: connection.id,
      enabled: true,
      revoked: true,
    });
    expect(() => assertThreadExecutionBindingAvailable(db, binding)).toThrow(
      /revoked/,
    );
    updateModelConnectionDefinition(db, { id: connection.id, revoked: false });
    updateHost(db, noopNotifier, hostId, { phase: "removing" });
    expect(() =>
      assertThreadExecutionBindingAvailable(db, binding, hostId, "acp-omp"),
    ).toThrow(/unavailable/);
    deleteConnectionDefinition(db, connection.id);
    expect(() =>
      assertThreadExecutionBindingAvailable(db, binding, hostId, "acp-omp"),
    ).toThrow(/does not exist/);
  });

  it("reads legacy native snapshots without gateway and preserves native host authorization", () => {
    const native = connection("legacy-native");
    const binding = resolve(undefined, native.id)!;
    const thread = createThread(db, noopNotifier, {
      projectId,
      providerId: native.provider,
      executionBinding: binding,
    });
    db.update(threadExecutionBindings)
      .set({
        snapshot: sql`json_remove(${threadExecutionBindings.snapshot}, '$.modelConnection.gateway')`,
      })
      .where(eq(threadExecutionBindings.threadId, thread.id))
      .run();
    db.update(modelConnections)
      .set({
        definition: sql`json_remove(${modelConnections.definition}, '$.gateway')`,
      })
      .where(eq(modelConnections.id, native.id))
      .run();
    const snapshot = getThreadExecutionBinding(db, thread.id)!;
    expect(snapshot.modelConnection?.gateway).toBeNull();
    expect(() =>
      assertThreadExecutionBindingAvailable(
        db,
        snapshot,
        hostId,
        native.provider,
      ),
    ).not.toThrow();
    expect(() =>
      assertThreadExecutionBindingAvailable(
        db,
        snapshot,
        "other-host",
        native.provider,
      ),
    ).toThrow(/not execution host/);
    updateModelConnectionDefinition(db, {
      id: native.id,
      hostId: "other-host",
    });
    expect(() =>
      assertThreadExecutionBindingAvailable(
        db,
        snapshot,
        hostId,
        native.provider,
      ),
    ).toThrow(/not execution host/);
    expect(snapshot.modelConnection?.nativeAuth).toEqual(native.nativeAuth);
  });
});
