// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { memoryRpcContract } from "./server.js";

const app = await loadPluginApp(() => import("./app"));
const memory = {
  id: "mem_1", scope: "global", projectId: null, task: null, lineage: null,
  name: "answer-style", summary: "Use concise answers.", details: "Retain concrete evidence.",
  kind: "preference", tags: [], importance: 60, pinned: false, sourceThreadId: null,
  writeReason: "Explicit user preference", version: 1, createdAt: 1700000000000, updatedAt: 1700000000000,
};
const listed = (memories: Array<typeof memory>) => ({ memories, total: memories.length, previousOffset: null, nextOffset: null });
const scopes = {
  listMemoryProjects: () => ({ projects: [{ id: "proj_personal", name: "Personal" }, { id: "proj_work", name: "Work" }] }),
  listMemoryTasks: () => ({ tasks: [] }),
};
afterEach(cleanup);

describe("scoped memory settings", () => {
  it("hides the old scope immediately and ignores a late response after another project is selected", async () => {
    let resolvePersonal!: (value: ReturnType<typeof listed>) => void;
    const personal = new Promise<ReturnType<typeof listed>>((resolve) => { resolvePersonal = resolve; });
    const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: {
      ...scopes,
      listMemories: (raw) => {
        const selection = memoryRpcContract.listMemories.input.parse(raw);
        if (selection.projectId === "proj_personal") return personal;
        return listed([{ ...memory, name: selection.projectId === "proj_work" ? "work-note" : "global-note" }]);
      },
    } });
    await slot.findByText("global-note");
    await slot.findByRole("option", { name: "Personal" });
    fireEvent.change(slot.getByLabelText("Memory project"), { target: { value: "proj_personal" } });
    expect(slot.queryByText("global-note")).toBeNull();
    await waitFor(() => expect(slot.getByRole("button", { name: "Open memories" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(slot.getByRole("button", { name: "Open memories" }));
    await slot.findByText("Loading memories…");
    fireEvent.change(slot.getByLabelText("Memory project"), { target: { value: "proj_work" } });
    await waitFor(() => expect(slot.getByRole("button", { name: "Open memories" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(slot.getByRole("button", { name: "Open memories" }));
    await slot.findByText("work-note");
    await act(async () => {
      resolvePersonal(listed([{ ...memory, name: "private-personal-note" }]));
      await personal;
    });
    expect(slot.queryByText("private-personal-note")).toBeNull();
    expect(slot.getByText("work-note")).toBeTruthy();
  });

  it("keeps a conflicting edit visible without replacing the stored summary", async () => {
    const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: {
      ...scopes, listMemories: () => listed([memory]),
      updateMemory: () => { throw new Error("Concurrent owner update; reload before saving."); },
    } });
    await slot.findByText("answer-style");
    fireEvent.click(slot.getByRole("button", { name: "Edit answer-style" }));
    fireEvent.change(slot.getByLabelText("Memory summary"), { target: { value: "My unsaved revision" } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await slot.findByRole("alert");
    const draft = slot.getByLabelText("Memory summary");
    expect(draft instanceof HTMLInputElement ? draft.value : null).toBe("My unsaved revision");
    expect(slot.getByText("Use concise answers.")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
    expect(slot.queryByLabelText("Memory summary")).toBeNull();
    expect(slot.getByText("Use concise answers.")).toBeTruthy();
  });

  it("retains a note until inline deletion is explicitly confirmed", async () => {
    let retained = true;
    const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: {
      ...scopes, listMemories: () => listed(retained ? [memory] : []),
      deleteMemory: () => { retained = false; return { deleted: { id: memory.id, version: 2 } }; },
    } });
    await slot.findByText("answer-style");
    fireEvent.click(slot.getByRole("button", { name: "Delete answer-style" }));
    expect(slot.getByText("answer-style")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Keep answer-style" }));
    expect(slot.getByText("answer-style")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Delete answer-style" }));
    fireEvent.click(slot.getByRole("button", { name: "Confirm delete answer-style" }));
    await waitFor(() => expect(slot.queryByText("answer-style")).toBeNull());
  });
});
