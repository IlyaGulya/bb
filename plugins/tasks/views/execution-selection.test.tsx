// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { ExecutionContext, ModelConnection } from "@get-bb/plugin-sdk/app";
import { TasksRefreshProvider } from "../shell/refresh.js";
import { ExecutionSelectionFields, useExecutionSelections } from "./execution-selection.js";

afterEach(cleanup);

function SelectionDraft() {
  const selections = useExecutionSelections(true);
  const [contextId, setContextId] = useState("context-owned");
  const [connectionId, setConnectionId] = useState("account-owned");
  return <><ExecutionSelectionFields selections={selections} open executionContextId={contextId} modelConnectionId={connectionId} onContextChange={setContextId} onConnectionChange={setConnectionId} /><output aria-label="Saved draft">{contextId} / {connectionId}</output></>;
}
function Harness() {
  return <TasksRefreshProvider><SelectionDraft /></TasksRefreshProvider>;
}

it("refreshes renamed and unavailable definitions on Core changes and reconnect without rewriting an open draft", async () => {
  let contexts: ExecutionContext[] = [{ id: "context-owned", name: "Personal instructions", enabled: true, projectIds: [], instructions: "", skillRoots: [], commandRoots: [], pluginRoots: [], settingsPaths: [], mcpServers: [], hooksPath: null, autoMemory: false, gitIdentity: null, defaultModelConnectionId: null, createdAt: 1, updatedAt: 1 }];
  let connections: ModelConnection[] = [{ id: "account-owned", name: "Personal account", provider: "acp-omp", hostId: "host_owned", enabled: true, revoked: false, nativeAuth: { configDir: null, profile: null, hostEnv: null }, gateway: null, createdAt: 1, updatedAt: 1 }];
  let contextError = false;
  const slot = renderSlot({ component: Harness }, {}, { sdk: {
    experimental_executionContexts: { list: async () => { if (contextError) throw new Error("Context service disconnected"); return contexts; } },
    experimental_modelConnections: { list: async () => connections },
  } });
  await slot.findByText("Personal instructions");
  await slot.findByText(/Personal account/);
  contexts = contexts.map(context => ({ ...context, name: "Renamed instructions" }));
  connections = connections.map(connection => ({ ...connection, name: "Renamed account", revoked: true }));
  await slot.behavior.emitRealtime("system:changed", { type: "changed", entity: "system", changes: ["execution-contexts-changed"] });
  await slot.findByText("Renamed instructions");
  expect(slot.queryByText(/Renamed account/)).toBeNull();
  await slot.behavior.emitRealtime("system:changed", { type: "changed", entity: "system", id: "account-owned", changes: ["model-connections-changed"] });
  await slot.findByText(/Renamed account.*revoked/);
  contextError = true;
  await slot.behavior.emitRealtime("system:changed", { type: "changed", entity: "system", changes: ["execution-contexts-changed"] });
  await slot.findByRole("alert");
  expect(slot.getByText("Renamed instructions")).toBeDefined();
  await slot.behavior.setRealtimeConnectionState("reconnecting");
  contextError = false;
  contexts = [];
  connections = [];
  await slot.behavior.setRealtimeConnectionState("connected");
  await waitFor(() => expect(slot.getAllByText(/Saved selection unavailable/)).toHaveLength(2));
  expect(slot.getByRole("status", { name: "Saved draft" }).textContent).toBe("context-owned / account-owned");
});
