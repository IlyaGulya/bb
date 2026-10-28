import { createNodeBbSdk, type SystemRealtimeEvent } from "@bb/sdk/node";
import { describe, expect, it, vi } from "vitest";
import { seedHost, seedProjectWithSource } from "../helpers/seed.js";
import { startTestServer } from "../helpers/test-app.js";

describe("execution definition freshness across SDK clients", () => {
  it("publishes committed CRUD and defaults without broadcasting definition contents", async () => {
    const server = await startTestServer();
    const writer = createNodeBbSdk({ baseUrl: server.baseUrl });
    const reader = createNodeBbSdk({ baseUrl: server.baseUrl });
    const events: SystemRealtimeEvent[] = [];
    let subscribed = false;
    const stop = reader.subscribe({
      event: "system:changed",
      callback: (event) => {
        if (event.id === "subscription-ready") subscribed = true;
        else if (event.changes.some((kind) =>
          kind === "execution-contexts-changed" ||
          kind === "model-connections-changed" ||
          kind === "project-context-defaults-changed",
        )) events.push(event);
      },
    });
    try {
      const host = seedHost(server);
      const { project } = seedProjectWithSource(server, { hostId: host.id });
      await vi.waitFor(() => {
        server.hub.notifySystem(["execution-contexts-changed"], "subscription-ready");
        expect(subscribed).toBe(true);
      });
      let consumed = 0;
      const expectChange = async (
        kind: "execution-contexts-changed" | "model-connections-changed" | "project-context-defaults-changed",
        id: string,
      ) => {
        await vi.waitFor(() => expect(events[consumed]).toEqual({
          type: "changed",
          entity: "system",
          id,
          changes: [kind],
        }));
        consumed += 1;
      };
      const context = await writer.experimental_executionContexts.create({
        name: "Work",
        projectIds: [project.id],
        instructions: "Private project instructions",
      });
      await expectChange("execution-contexts-changed", context.id);
      expect(await reader.experimental_executionContexts.list()).toContainEqual(context);
      await writer.experimental_executionContexts.update({ id: context.id, name: "Renamed" });
      await expectChange("execution-contexts-changed", context.id);
      expect(await reader.experimental_executionContexts.get({ id: context.id })).toMatchObject({ name: "Renamed" });

      const connection = await writer.experimental_modelConnections.create({
        name: "Reference-only CPA",
        provider: "acp-omp",
        hostId: null,
        enabled: false,
        gateway: {
          baseUrl: "https://gateway.invalid/v1",
          protocol: "openai-responses",
          accountPrefix: "reference-only",
          modelProvider: "openai-codex",
          credential: { kind: "env", name: "UNPROVISIONED_TEST_KEY" },
          allowedHostIds: [host.id],
        },
      });
      await expectChange("model-connections-changed", connection.id);
      expect(await reader.experimental_modelConnections.list()).toContainEqual(connection);
      await writer.experimental_modelConnections.update({ id: connection.id, name: "Renamed CPA" });
      await expectChange("model-connections-changed", connection.id);
      expect(await reader.experimental_modelConnections.get({ id: connection.id })).toMatchObject({ name: "Renamed CPA", enabled: false });
      await writer.experimental_modelConnections.update({ id: connection.id, revoked: true });
      await expectChange("model-connections-changed", connection.id);
      expect(await reader.experimental_modelConnections.get({ id: connection.id })).toMatchObject({ revoked: true });

      await writer.experimental_executionContexts.setProjectDefaults({
        projectId: project.id,
        executionContextId: context.id,
        modelConnectionId: null,
      });
      await expectChange("project-context-defaults-changed", project.id);
      expect(await reader.experimental_executionContexts.getProjectDefaults({ projectId: project.id })).toEqual({
        projectId: project.id,
        executionContextId: context.id,
        modelConnectionId: null,
      });
      await writer.experimental_executionContexts.update({ id: context.id, enabled: false });
      await expectChange("execution-contexts-changed", context.id);
      expect(await reader.experimental_executionContexts.get({ id: context.id })).toMatchObject({ enabled: false });

      await expect(writer.experimental_executionContexts.delete({ id: context.id })).rejects.toMatchObject({ status: 409, code: "execution_context_in_use" });
      await expect(writer.experimental_modelConnections.update({ id: "missing", revoked: true })).rejects.toMatchObject({ status: 404, code: "model_connection_not_found" });
      await writer.experimental_executionContexts.setProjectDefaults({
        projectId: project.id,
        executionContextId: null,
        modelConnectionId: null,
      });
      await expectChange("project-context-defaults-changed", project.id);
      expect(await reader.experimental_executionContexts.getProjectDefaults({ projectId: project.id })).toEqual({
        projectId: project.id,
        executionContextId: null,
        modelConnectionId: null,
      });
      await writer.experimental_executionContexts.delete({ id: context.id });
      await expectChange("execution-contexts-changed", context.id);
      expect(await reader.experimental_executionContexts.list()).toEqual([]);
      await writer.experimental_modelConnections.delete({ id: connection.id });
      await expectChange("model-connections-changed", connection.id);
      expect(await reader.experimental_modelConnections.list()).toEqual([]);
      expect(events).toHaveLength(consumed);
    } finally {
      stop();
      await server.close();
    }
  });
});
