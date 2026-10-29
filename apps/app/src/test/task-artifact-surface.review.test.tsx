// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { MarkdownPreview } from "@/components/ui/markdown-preview";
import { LazyMarkdownHtml } from "@/components/ui/lazy-markdown-html";
import { SelectableMessageProse } from "@/components/thread/timeline/SelectableMessageProse";
import { tasksRpcContract, type Attachment } from "../../../../plugins/tasks/shared/contract";
import { taskArtifactSchema, taskArtifactViewSchema } from "../../../../plugins/tasks/shared/artifacts";
import { TaskArtifactStore } from "../../../../plugins/tasks/artifacts/store";
import { REVIEW_DECISION, sha256, withTaskArtifactReviewFixture } from "./task-artifact-review-fixture";

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  cleanup();
  vi.restoreAllMocks();
});

beforeAll(() => LazyMarkdownHtml.preload());

const recoveryModules = import.meta.glob([
  "../../../../plugins/tasks/views/detail/artifacts.tsx",
  "../../../../plugins/tasks/shell/refresh.tsx",
]);
type SectionProps = { taskId: string; bbProjectId: string | null; attachments: Attachment[] };

async function recoverySection() {
  const sectionLoader = recoveryModules["../../../../plugins/tasks/views/detail/artifacts.tsx"];
  const refreshLoader = recoveryModules["../../../../plugins/tasks/shell/refresh.tsx"];
  if (!sectionLoader || !refreshLoader) throw new Error("Actual Tasks recovery surface could not be located");
  const { TaskArtifactsSection } = z.object({ TaskArtifactsSection: z.custom<ComponentType<SectionProps>>(value => typeof value === "function") }).parse(await sectionLoader());
  const { TasksRefreshProvider } = z.object({ TasksRefreshProvider: z.custom<ComponentType<{ children: import("react").ReactNode }>>(value => typeof value === "function") }).parse(await refreshLoader());
  return function RecoverySection(props: SectionProps) {
    return <TasksRefreshProvider><TaskArtifactsSection {...props} /></TasksRefreshProvider>;
  };
}

describe.each(["move", "relink"] as const)("readable history recovery after %s", operation => {
  it("lets an operator choose the original Work history and remove its pin without raw IDs or task reversal", async () => withTaskArtifactReviewFixture(async f => {
    const retained = await f.retain();
    const snapshot = await f.readImage(retained.image.attachmentId);
    await f.relocate(operation);
    const component = await recoverySection();
    const attachments = tasksRpcContract.listAttachments.output.parse(await f.harness.callRpc("listAttachments", { taskId: f.workTask.id })).attachments;
    const slot = renderSlot({ component }, { taskId: f.workTask.id, bbProjectId: "proj_personal", attachments }, {
      pluginId: "tasks",
      sdk: { experimental_executionContexts: { list: () => f.bb.sdk.experimental_executionContexts.list() } },
      rpc: {
        listTaskArtifacts: input => f.harness.callRpc("listTaskArtifacts", input),
        getTaskArtifact: input => f.harness.callRpc("getTaskArtifact", input),
        deleteTaskArtifact: input => f.harness.callRpc("deleteTaskArtifact", input),
      },
    });
    try {
      fireEvent.click(await screen.findByRole("combobox", { name: "Artifact context" }));
      fireEvent.click(await screen.findByRole("option", { name: "Work" }));
      fireEvent.click(await screen.findByRole("button", { name: REVIEW_DECISION }));
      expect((await screen.findByRole("link", { name: "Open source message" })).getAttribute("href")).toBe("/projects/proj_work/threads/thr_work_source#msg=7");
      fireEvent.click(screen.getByRole("button", { name: "Remove retained artifact" }));
      fireEvent.click(await screen.findByRole("button", { name: "Remove artifact" }));
      await waitFor(() => expect(new TaskArtifactStore(f.store).get(retained.saved.id)).toBeNull());
      await waitFor(() => expect(screen.queryByRole("button", { name: REVIEW_DECISION })).toBeNull());
      expect(f.store.tasks.getTask(f.workTask.id)?.status).toBe(f.workTask.status);
      expect((await f.readImage(retained.image.attachmentId)).equals(snapshot)).toBe(true);
      const removed = tasksRpcContract.deleteAttachment.output.parse(await f.harness.callRpc("deleteAttachment", { attachmentId: retained.image.attachmentId }));
      expect(removed).toMatchObject({ ok: true, deleted: true });
    } finally { slot.unmount(); }
  }));
});

const MARKDOWN_SELECTIONS = [
  { markdown: "Use **red** button", visible: "Use red button", selector: "strong" },
  { markdown: "Read [the guide](https://example.invalid/) first", visible: "Read the guide first", selector: "a" },
  { markdown: "Keep `safe()` unchanged", visible: "Keep safe() unchanged", selector: "code" },
  { markdown: "Use &amp; keep **red**", visible: "Use & keep red", selector: "strong" },
] as const;

async function selectRenderedPassage(markdown: string, selector: string) {
  let selectedText: string | null = null;
  const view = render(<SelectableMessageProse onSelect={selection => { selectedText = selection?.text ?? null; }}>
    <MarkdownPreview content={markdown} />
  </SelectableMessageProse>);
  const target = await waitFor(() => {
    const paragraph = view.container.querySelector(selector)?.closest("p");
    if (!paragraph) throw new Error("Actual Markdown prose paragraph is not rendered yet");
    return paragraph;
  });
  const selection = window.getSelection();
  if (!selection) throw new Error("DOM selection is unavailable in this test platform");
  const range = document.createRange();
  range.selectNodeContents(target);
  vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 20, 120, 20));
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent(document, new Event("selectionchange"));
  fireEvent.mouseUp(target, { clientX: 80, clientY: 25 });
  await waitFor(() => expect(selectedText).not.toBeNull());
  return z.string().trim().min(1).max(4000).parse(selectedText);
}

describe("bounded source proof from actual Core Markdown selection", () => {
  it.each(MARKDOWN_SELECTIONS)("retains rendered selection from $markdown without replacing raw source provenance", async example => withTaskArtifactReviewFixture(async f => {
    const raw = `Unselected source context.\n\n${example.markdown}\n\nUnselected trailing context.`;
    const source = f.threads.get("thr_work_source");
    if (!source) throw new Error("Synthetic source thread is missing");
    source.text = raw;
    const selected = await selectRenderedPassage(raw, example.selector);
    expect(selected).toBe(example.visible);
    expect(raw.includes(selected)).toBe(false);
    const saved = taskArtifactSchema.parse(await f.harness.callRpc("createTaskArtifact", f.request(null, { quote: selected })));
    const result = taskArtifactViewSchema.parse(await f.harness.callRpc("getTaskArtifact", f.target(saved)));
    expect(result.sourceStatus).toBe("available");
    expect(result.artifact.source).toEqual({ threadId: "thr_work_source", eventSeq: 7, quote: selected, role: "assistant", textSha256: sha256(raw) });
    expect(result.artifact.annotation).toBeNull();
  }));

  it("keeps plain selected text working through the same durable source-proof path", async () => withTaskArtifactReviewFixture(async f => {
    const source = f.threads.get("thr_work_source");
    if (!source) throw new Error("Synthetic source thread is missing");
    source.text = "Use red button";
    const selected = await selectRenderedPassage(source.text, "p");
    expect(selected).toBe("Use red button");
    const saved = taskArtifactSchema.parse(await f.harness.callRpc("createTaskArtifact", f.request(null, { quote: selected })));
    expect((await f.view(saved)).artifact.source).toEqual({ threadId: "thr_work_source", eventSeq: 7, quote: selected, role: "assistant", textSha256: sha256(source.text) });
  }));

  it("still refuses a fabricated passage after the real renderer and selection produce a legitimate one", async () => withTaskArtifactReviewFixture(async f => {
    const source = f.threads.get("thr_work_source");
    if (!source) throw new Error("Synthetic source thread is missing");
    source.text = "Use **red** button";
    const selected = await selectRenderedPassage(source.text, "strong");
    expect(selected).toBe("Use red button");
    await expect(f.harness.callRpc("createTaskArtifact", f.request(null, { quote: "Use blue button" }))).rejects.toThrow();
    expect(taskArtifactSchema.array().parse(await f.harness.callRpc("listTaskArtifacts", f.scope))).toEqual([]);
  }));
});
