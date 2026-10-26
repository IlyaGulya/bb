import {
  getThreadExecutionBinding,
  getThread,
  persistThreadExecutionBinding,
  setThreadStartupContext,
  createThread,
  saveExecutionContext,
  setProjectContextDefaults,
  threadExecutionBindings,
  threads,
} from "@bb/db";
import {
  executionContextSchema,
  type McpConfigurationFileInspection,
} from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  assertSelectedExecutionContextMcp,
  resolveThreadExecutionBinding,
} from "../../src/services/execution-contexts.js";
import { createThreadFromRequest } from "../../src/services/threads/thread-create.js";
import { attemptDispatch } from "../../src/services/threads/dispatch-attempt.js";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import { textInput } from "../helpers/prompt-input.js";
import { seedEnvironment, seedHostSession, seedProjectWithSource, seedThread } from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const configPath = "/fixtures/mcp.json";
const server = {
  name: "calendar",
  transport: "stdio" as const,
  supported: true,
  issue: null,
  authStatus: "not_checked" as const,
};
const file: McpConfigurationFileInspection = {
  configPath,
  status: "ok",
  issue: null,
  servers: [server],
};

function seedSelection(
  harness: TestAppHarness,
  refs = [{ name: "calendar", configPath }],
) {
  const { host, session } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/fixtures/repository",
  });
  const context = saveExecutionContext(
    harness.db,
    executionContextSchema.parse({
      id: "selected-context",
      name: "Selected context",
      projectIds: [project.id],
      mcpServers: refs,
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  setProjectContextDefaults(harness.db, {
    projectId: project.id,
    executionContextId: context.id,
    modelConnectionId: null,
  });
  return { host, session, project, context };
}

function respond(
  harness: TestAppHarness,
  hostId: string,
  sessionId: string,
  files: McpConfigurationFileInspection[],
) {
  return registerHostRpcResponder(harness, {
    hostId,
    sessionId,
    handle: (request) => {
      if (request.command.type === "host.inspect_mcp_sources")
        return { ok: true, result: { files } };
      if (request.command.type === "provider.list_models")
        return { ok: true, result: { models: [], selectedOnlyModels: [] } };
      throw new Error(`Unexpected RPC ${request.command.type}`);
    },
  });
}

describe("selected MCP launch admission", () => {
  it.each([
    { label: "missing name", refs: [{ name: "missing", configPath }], files: [file] },
    { label: "missing file", refs: [{ name: "calendar", configPath }], files: [] },
    { label: "invalid file", refs: [{ name: "calendar", configPath }], files: [{ ...file, status: "invalid" as const, issue: "Invalid JSON configuration" as const, servers: [] }] },
    { label: "unsupported transport", refs: [{ name: "calendar", configPath }], files: [{ ...file, servers: [{ ...server, supported: false, transport: "unsupported" as const, issue: "Unsupported server descriptor" as const }] }] },
    { label: "duplicate name", refs: [{ name: "calendar", configPath }, { name: "calendar", configPath }], files: [file] },
    { label: "reserved bridge", refs: [{ name: "bb-bridge", configPath }], files: [{ ...file, servers: [{ ...server, name: "bb-bridge" }] }] },
  ])("refuses $label before persisting a thread or executor", async ({ refs, files }) => {
    await withTestHarness(async (harness) => {
      const { host, session, project } = seedSelection(harness, refs);
      const rpc = respond(harness, host.id, session.id, files);
      const before = harness.db.select().from(threads).all();
      await expect(createThreadFromRequest(harness.deps, {
        projectId: project.id,
        environment: { type: "host", hostId: host.id, workspace: { type: "unmanaged", path: "/fixtures/repository" } },
        providerId: "claude-code",
        model: "claude-sonnet-4-5",
        origin: "app",
        startedOnBehalfOf: null,
        input: textInput("Run with selected MCP"),
      })).rejects.toMatchObject({ body: { code: "execution_context_mcp_invalid" } });
      expect(harness.db.select().from(threads).all()).toEqual(before);
      expect(harness.db.select().from(threadExecutionBindings).all()).toEqual([]);
      expect(rpc.requests.some((request) => request.command.type === "thread.start")).toBe(false);
      expect(rpc.requests.find((request) => request.command.type === "host.inspect_mcp_sources")?.command).toEqual({
        type: "host.inspect_mcp_sources", providerId: "claude-code", configPaths: [configPath],
      });
    });
  });

  it("validates the persisted snapshot rather than a later edited context", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, project, context } = seedSelection(harness);
      const binding = resolveThreadExecutionBinding(harness.db, { projectId: project.id, hostId: host.id });
      const thread = createThread(harness.db, harness.hub, { projectId: project.id, providerId: "claude-code", executionBinding: binding });
      saveExecutionContext(harness.db, { ...context, mcpServers: [{ name: "missing", configPath }], updatedAt: 2 });
      const rpc = respond(harness, host.id, session.id, [file]);
      await expect(assertSelectedExecutionContextMcp(harness.deps, {
        binding: getThreadExecutionBinding(harness.db, thread.id), hostId: host.id, providerId: "claude-code",
      })).resolves.toBeUndefined();
      expect(rpc.requests).toHaveLength(1);
      expect(getThreadExecutionBinding(harness.db, thread.id)?.executionContext?.mcpServers).toEqual([{ name: "calendar", configPath }]);
    });
  });

  it("leaves legacy and empty selections independent of inspection support", async () => {
    await withTestHarness(async (harness) => {
      const { host, project } = seedSelection(harness, []);
      for (const binding of [null, resolveThreadExecutionBinding(harness.db, { projectId: project.id, hostId: host.id })]) {
        await expect(assertSelectedExecutionContextMcp(harness.deps, { binding, hostId: null, providerId: "unsupported" })).resolves.toBeUndefined();
      }
    });
  });
  it("deduplicates source files without losing distinct selected servers", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, project } = seedSelection(harness, [
        { name: "calendar", configPath },
        { name: "mail", configPath },
      ]);
      const rpc = respond(harness, host.id, session.id, [{ ...file, servers: [server, { ...server, name: "mail" }] }]);
      await expect(assertSelectedExecutionContextMcp(harness.deps, {
        binding: resolveThreadExecutionBinding(harness.db, { projectId: project.id, hostId: host.id }),
        hostId: host.id,
        providerId: "claude-code",
      })).resolves.toBeUndefined();
      expect(rpc.requests[0]?.command).toEqual({
        type: "host.inspect_mcp_sources",
        providerId: "claude-code",
        configPaths: [configPath],
      });
    });
  });

  it("refuses excessive sources before any RPC or thread persistence", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, project } = seedSelection(harness, Array.from({ length: 17 }, (_, index) => ({
        name: `server-${index}`,
        configPath: `/fixtures/${index}.json`,
      })));
      const rpc = respond(harness, host.id, session.id, []);
      await expect(createThreadFromRequest(harness.deps, {
        projectId: project.id,
        environment: { type: "host", hostId: host.id, workspace: { type: "unmanaged", path: "/fixtures/repository" } },
        providerId: "claude-code",
        model: "claude-sonnet-4-5",
        origin: "app",
        startedOnBehalfOf: null,
        input: textInput("Too many selected sources"),
      })).rejects.toMatchObject({ body: { code: "mcp_inspection_invalid_request" } });
      expect(rpc.requests).toEqual([]);
      expect(harness.db.select().from(threads).all()).toEqual([]);
      expect(harness.db.select().from(threadExecutionBindings).all()).toEqual([]);
    });
  });
  it("rechecks automatic delayed admission before consuming the pending executor", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, project } = seedSelection(harness);
      const environment = seedEnvironment(harness.deps, { hostId: host.id, projectId: project.id, path: "/fixtures/repository" });
      const binding = resolveThreadExecutionBinding(harness.db, { projectId: project.id, hostId: host.id });
      const thread = seedThread(harness.deps, { projectId: project.id, providerId: "claude-code", environmentId: environment.id, status: "pending" });
      persistThreadExecutionBinding(harness.db, thread.id, binding!);
      setThreadStartupContext(harness.db, {
        threadId: thread.id,
        startupContext: JSON.stringify({
          kind: "pending",
          environmentIntent: { type: "reuse", environmentId: environment.id },
          fork: null,
          startedOnBehalfOf: null,
          titleProvided: false,
        }),
      });
      const rpc = respond(harness, host.id, session.id, [{ ...file, servers: [] }]);
      await expect(attemptDispatch(harness.deps, {
        thread,
        payload: { input: textInput("Automatically start"), mode: "start" },
        source: { kind: "inline" },
        queuePayload: { kind: "inline" },
        pluginSubmission: null,
        origin: "app",
        originPluginId: null,
        startedOnBehalfOf: null,
        trigger: "auto-dispatch",
      })).rejects.toMatchObject({ body: { code: "execution_context_mcp_invalid" } });
      expect(getThread(harness.db, thread.id)?.status).toBe("pending");
      expect(harness.db.select().from(threads).all()).toHaveLength(1);
      expect(rpc.requests.map((request) => request.command.type)).toEqual(["host.inspect_mcp_sources"]);
    });
  });
});
