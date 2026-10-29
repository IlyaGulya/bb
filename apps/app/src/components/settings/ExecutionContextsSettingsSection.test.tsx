// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ExecutionContext } from "@bb/domain";
import { executionContextSchema } from "@bb/domain";
import { updateExecutionContextRequestSchema } from "@bb/server-contract";
import { afterEach, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { sidebarNavigationQueryKey } from "@/hooks/queries/query-keys";
import { ExecutionContextsSettingsSection } from "./ExecutionContextsSettingsSection";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("requires a named confirmation, safely cancels, and retains the definition when deletion is refused", async () => {
  const context: ExecutionContext = { id: "context-owned", name: "Personal instructions", enabled: true, projectIds: [], instructions: "", skillRoots: [], commandRoots: [], pluginRoots: [], settingsPaths: [], mcpServers: [], hooksPath: null, autoMemory: false, gitIdentity: null, defaultModelConnectionId: null, createdAt: 1, updatedAt: 1 };
  let contexts = [context];
  let refused = true;
  vi.spyOn(sdk.experimental_executionContexts, "list").mockImplementation(async () => contexts);
  vi.spyOn(sdk.experimental_modelConnections, "list").mockResolvedValue([]);
  vi.spyOn(sdk.hosts, "list").mockResolvedValue([]);
  vi.spyOn(sdk.providers, "catalog").mockResolvedValue([]);
  const remove = vi.spyOn(sdk.experimental_executionContexts, "delete").mockImplementation(async () => {
    if (refused) throw new Error("Clear project defaults before deleting this context");
    contexts = [];
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sidebarNavigationQueryKey(), { projects: [], personalProject: { id: "proj_personal", name: "Personal" } });
  render(<QueryClientProvider client={client}><ExecutionContextsSettingsSection /></QueryClientProvider>);
  const trigger = await screen.findByRole("button", { name: "Delete context Personal instructions" });
  trigger.focus();
  fireEvent.click(trigger);
  let dialog = await screen.findByRole("dialog", { name: "Delete Personal instructions" });
  expect(within(dialog).getByRole("heading").textContent).toContain(context.name);
  fireEvent.click(await within(dialog).findByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(remove).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  dialog = await screen.findByRole("dialog", { name: "Delete Personal instructions" });
  fireEvent.click(await within(dialog).findByRole("button", { name: "Delete definition" }));
  await within(dialog).findByRole("alert");
  expect(screen.getByRole("button", { name: "Delete context Personal instructions" })).toBeDefined();
  refused = false;
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete definition" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Delete context Personal instructions" })).toBeNull());
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  client.clear();
});

it.each([1000, 1001])("round-trips a valid %i ms startup policy when editing only the context name", async (deadlineMs) => {
  let saved = executionContextSchema.parse({
    id: "context-millisecond-policy", name: "Millisecond policy", createdAt: 1, updatedAt: 1,
    mcpServers: [{ name: "optional-fixture", configPath: "/fixture/mcp.json" }],
    startupPolicy: { deadlineMs, optionalMcpServers: ["optional-fixture"] },
  });
  vi.spyOn(sdk.experimental_executionContexts, "list").mockImplementation(async () => [saved]);
  vi.spyOn(sdk.experimental_executionContexts, "update").mockImplementation(async (request) => {
    const fields = updateExecutionContextRequestSchema.parse(request);
    saved = executionContextSchema.parse({ ...saved, ...fields, updatedAt: saved.updatedAt + 1 });
    return saved;
  });
  vi.spyOn(sdk.experimental_modelConnections, "list").mockResolvedValue([]);
  vi.spyOn(sdk.hosts, "list").mockResolvedValue([]);
  vi.spyOn(sdk.providers, "catalog").mockResolvedValue([]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(sidebarNavigationQueryKey(), { projects: [], personalProject: { id: "proj_personal", name: "Personal" } });
  try {
    render(<QueryClientProvider client={client}><ExecutionContextsSettingsSection /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Edit context Millisecond policy" }));
    const dialog = await screen.findByRole("dialog", { name: "Execution context" });
    const name = await within(dialog).findByRole("textbox", { name: "Name" });
    const initialDeadline = await within(dialog).findByLabelText(/^Startup deadline\b/i);
    expect(initialDeadline.getAttribute("value")).toBe(String(deadlineMs / 1000));
    fireEvent.change(name, { target: { value: "Renamed millisecond policy" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await screen.findByRole("button", { name: "Edit context Renamed millisecond policy" });
    expect(saved.startupPolicy).toEqual({ deadlineMs, optionalMcpServers: ["optional-fixture"] });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Edit context Renamed millisecond policy" }));
    const reopened = await screen.findByRole("dialog", { name: "Execution context" });
    const deadline = await within(reopened).findByLabelText(/^Startup deadline\b/i);
    expect(deadline.getAttribute("value")).toBe(String(deadlineMs / 1000));
  } finally {
    cleanup();
    client.clear();
  }
});
