// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ExecutionContext } from "@bb/domain";
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
