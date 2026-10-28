// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { TasksRefreshProvider } from "../../shell/refresh.js";
import { JiraImportDialog } from "./import-dialog.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function ImportHarness() {
  return <TasksRefreshProvider><JiraImportDialog open onOpenChange={() => {}} projectId={null} /></TasksRefreshProvider>;
}

it("requires an explicit permitted tracker project and never substitutes another when access changes", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const first = { id: "01HZZZZZZZZZZZZZZZZZZZZZP1", name: "First tracker", prefix: "FIRST", nextTaskNumber: 1, color: "blue", folderId: null, linkedBbProjectId: null, createdAt: "2026-10-28T00:00:00.000Z" };
  const second = { ...first, id: "01HZZZZZZZZZZZZZZZZZZZZZP2", name: "Second tracker", prefix: "SECOND" };
  let permitted = [first.id, second.id];
  const slot = renderSlot({ component: ImportHarness }, {}, { rpc: {
    listProjects: () => ({ projects: [first, second] }),
    jiraConnections: () => ({ connections: [{ id: "owned-tracker", label: "Owned tracker", siteUrl: "https://owned.example", projectIds: permitted, ready: true, error: null }] }),
  } });
  fireEvent.click(await slot.findByRole("combobox", { name: "Jira connection" }));
  fireEvent.click(await slot.findByRole("option", { name: "Owned tracker" }));
  fireEvent.change(slot.getByRole("textbox", { name: "Jira issue key, ID or URL" }), { target: { value: "FIRST-1" } });
  expect(slot.getByRole("button", { name: "Import task" })).toHaveProperty("disabled", true);
  fireEvent.click(slot.getByRole("combobox", { name: "Tracker project" }));
  fireEvent.click(await slot.findByRole("option", { name: "First tracker" }));
  expect(slot.getByRole("button", { name: "Import task" })).toHaveProperty("disabled", false);
  permitted = [second.id];
  fireEvent.click(slot.getByRole("button", { name: "Refresh connections" }));
  await waitFor(() => expect(slot.getByRole("button", { name: "Import task" })).toHaveProperty("disabled", true));
  expect(slot.getByRole("combobox", { name: "Tracker project" }).textContent).not.toContain("Second tracker");
  expect((slot.getByRole("textbox", { name: "Jira issue key, ID or URL" }) as HTMLInputElement).value).toBe("FIRST-1");
});
