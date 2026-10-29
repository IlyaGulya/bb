// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { MarkdownPreview } from "@/components/ui/markdown-preview";
import { LazyMarkdownHtml } from "@/components/ui/lazy-markdown-html";
import { SelectableMessageProse } from "@/components/thread/timeline/SelectableMessageProse";
import { TaskArtifactStore } from "../../../../plugins/tasks/artifacts/store";
import { taskArtifactSchema } from "../../../../plugins/tasks/shared/artifacts";
import { artifactConsumerRpc, loadTaskArtifactApp, withArtifactActionPanel } from "./task-artifact-action-review-fixture";
import { REVIEW_DECISION, sha256, staticReviewImage, withTaskArtifactReviewFixture } from "./task-artifact-review-fixture";

beforeAll(() => LazyMarkdownHtml.preload());

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  cleanup();
  vi.restoreAllMocks();
});

const UNREVIEWED_MARKER = "unreviewedPrivateDecision_719";

describe.each(["message", "selection"] as const)("pre-confirmation privacy from the %s action", invocation => {
  it("persists only source identity before confirmation and after closing the unsaved panel", async () => withTaskArtifactReviewFixture(async fixture => {
    await withArtifactActionPanel(fixture, {
      text: `Use **red** button. ${UNREVIEWED_MARKER}`,
      ...(invocation === "selection" ? { selectedText: UNREVIEWED_MARKER } : {}),
      panelStateId: `artifact-unconfirmed-${invocation}`,
    }, async ({ slot, tab, storageKey, close }) => {
      expect(await slot.findByRole("checkbox", { name: /I have reviewed/ })).toHaveProperty("checked", false);
      expect(slot.getByRole("button", { name: "Save retained artifact" })).toHaveProperty("disabled", true);
      const beforeCancel = z.string().parse(window.localStorage.getItem(storageKey));
      close();
      const afterCancel = window.localStorage.getItem(storageKey) ?? "";
      expect(new TaskArtifactStore(fixture.store).list(fixture.workTask.id, "context_work", ["proj_work"])).toEqual([]);
      expect(JSON.parse(tab.paramsJson ?? "null")).toEqual({ sourceThreadId: "thr_work_source", eventSeq: 7 });
      expect(tab.id).not.toContain(UNREVIEWED_MARKER);
      expect(beforeCancel).not.toContain(UNREVIEWED_MARKER);
      expect(afterCancel).not.toContain(UNREVIEWED_MARKER);
    });
  }));
});

async function renderedMessageText(markdown: string) {
  const view = render(<MarkdownPreview content={markdown} />);
  try {
    return await waitFor(() => {
      const paragraph = view.container.querySelector("p");
      if (!paragraph?.textContent) throw new Error("Actual message prose has not rendered");
      return paragraph.textContent;
    });
  } finally {
    view.unmount();
  }
}

const ORDINARY_MESSAGES = [
  { name: "plain", raw: "Use red button", visible: "Use red button" },
  { name: "Markdown", raw: "Use **red** button", visible: "Use red button" },
] as const;

describe.each(ORDINARY_MESSAGES)("ordinary $name message action without a selection", example => {
  it("prefills the actual displayed message rather than Markdown formatting", async () => withTaskArtifactReviewFixture(async fixture => {
    const displayed = await renderedMessageText(example.raw);
    expect(displayed).toBe(example.visible);
    await withArtifactActionPanel(fixture, {
      text: example.raw,
      panelStateId: `artifact-prefill-${example.name}`,
    }, async ({ slot }) => {
      await waitFor(() => expect(slot.getByRole("textbox", { name: /Source quote/ })).toHaveProperty("value", displayed));
    });
  }));

  it("saves through the real form and source authority without manually repairing the quote", async () => withTaskArtifactReviewFixture(async fixture => {
    const displayed = await renderedMessageText(example.raw);
    await withArtifactActionPanel(fixture, {
      text: example.raw,
      panelStateId: `artifact-save-${example.name}`,
    }, async ({ slot }) => {
      fireEvent.click(await slot.findByRole("combobox", { name: "Task" }));
      fireEvent.click(await screen.findByRole("option", { name: `${fixture.workTask.key} · ${fixture.workTask.title}` }));
      fireEvent.change(slot.getByRole("textbox", { name: "Decision or requested change" }), { target: { value: REVIEW_DECISION } });
      fireEvent.click(slot.getByRole("checkbox", { name: /I have reviewed/ }));
      const save = slot.getByRole("button", { name: "Save retained artifact" });
      expect(save).toHaveProperty("disabled", false);
      fireEvent.click(save);
      await waitFor(() => {
        const retained = new TaskArtifactStore(fixture.store).list(fixture.workTask.id, "context_work", ["proj_work"]);
        expect(retained.map(artifact => ({ source: artifact.source, decision: artifact.decision, annotation: artifact.annotation }))).toEqual([{
          source: { threadId: "thr_work_source", eventSeq: 7, role: "assistant", quote: displayed, textSha256: sha256(example.raw) },
          decision: REVIEW_DECISION,
          annotation: null,
        }]);
      });
      expect(fixture.store.tasks.getTask(fixture.workTask.id)?.status).toBe(fixture.workTask.status);
    });
  }));
});

async function selectHtmlPassage(raw: string) {
  let selected: string | null = null;
  const view = render(<SelectableMessageProse onSelect={selection => { selected = selection?.text ?? null; }}>
    <MarkdownPreview content={raw} allowHtml />
  </SelectableMessageProse>);
  await waitFor(() => expect(view.container.querySelector('[aria-label="Loading embedded HTML"]')).toBeNull());
  const paragraph = await waitFor(() => {
    const element = view.container.querySelector("p");
    if (!element?.textContent) throw new Error("Actual HTML-enabled message prose has not rendered");
    return element;
  });
  const selection = window.getSelection();
  if (!selection) throw new Error("DOM selection is unavailable");
  const range = document.createRange();
  range.selectNodeContents(paragraph);
  vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 20, 120, 20));
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent(document, new Event("selectionchange"));
  fireEvent.mouseUp(paragraph, { clientX: 80, clientY: 25 });
  await waitFor(() => expect(selected).not.toBeNull());
  return { view, selected: z.string().trim().min(1).parse(selected) };
}

it("retains a real HTML-enabled visible b-tag selection through the same source authority", async () => withTaskArtifactReviewFixture(async fixture => {
  const raw = "Use <b>red</b> button";
  const source = fixture.threads.get("thr_work_source");
  if (!source) throw new Error("Synthetic source is missing");
  source.text = raw;
  const { view, selected } = await selectHtmlPassage(raw);
  expect(view.container.querySelector("b")?.textContent).toBe("red");
  expect(selected).toBe("Use red button");
  expect(raw.includes(selected)).toBe(false);
  const saved = taskArtifactSchema.parse(await fixture.harness.callRpc("createTaskArtifact", fixture.request(null, { quote: selected })));
  expect((await fixture.view(saved)).artifact.source).toEqual({ threadId: "thr_work_source", eventSeq: 7, role: "assistant", quote: selected, textSha256: sha256(raw) });
}));

const HIDDEN_HTML = [
  { name: "comment content", markup: "<!-- hiddenDecision_821 -->", quote: "hiddenDecision_821" },
  { name: "comment markup", markup: "<!-- hiddenDecision_821 -->", quote: "<!-- hiddenDecision_821 -->" },
  { name: "sanitized script content", markup: "<script>hiddenDecision_821</script>", quote: "hiddenDecision_821" },
] as const;

it.each(HIDDEN_HTML)("refuses $name that the actual HTML renderer does not display", async example => withTaskArtifactReviewFixture(async fixture => {
  const raw = `Public decision.\n\n${example.markup}`;
  const source = fixture.threads.get("thr_work_source");
  if (!source) throw new Error("Synthetic source is missing");
  source.text = raw;
  const { view, selected } = await selectHtmlPassage(raw);
  expect(selected).toBe("Public decision.");
  expect(view.container.textContent).not.toContain("hiddenDecision_821");
  expect(view.container.querySelector("script")).toBeNull();
  const visible = taskArtifactSchema.parse(await fixture.harness.callRpc("createTaskArtifact", fixture.request(null, { quote: selected })));
  await expect(fixture.harness.callRpc("createTaskArtifact", fixture.request(null, { quote: example.quote }))).rejects.toThrow();
  expect(new TaskArtifactStore(fixture.store).list(fixture.workTask.id, "context_work", ["proj_work"])).toEqual([visible]);
}));

it("keeps the permitted task and ordinary attachment visible in the actual Tasks UI after original-context revocation", async () => withTaskArtifactReviewFixture(async fixture => {
  const retained = await fixture.retain();
  const task = await fixture.relocate("move");
  const ordinary = await staticReviewImage();
  const ordinaryId = await fixture.upload(task.id, ordinary, "visible-personal-control.png");
  const originalContext = fixture.contexts.get("context_work");
  if (!originalContext) throw new Error("Original synthetic context is missing");
  originalContext.enabled = false;
  const app = await loadTaskArtifactApp();
  const page = app.navPanels.find(entry => entry.id === "tasks");
  if (!page) throw new Error("Actual Tasks page is missing");
  const slot = renderSlot(page, { subPath: `task/${task.key}` }, {
    pluginId: "tasks",
    rpc: artifactConsumerRpc(fixture),
    sdk: { experimental_executionContexts: { list: () => fixture.bb.sdk.experimental_executionContexts.list() } },
  });
  try {
    expect((await slot.findByRole("textbox", { name: "Task title" })).textContent).toBe(task.title);
    expect(await slot.findByText("visible-personal-control.png")).toBeTruthy();
    expect(slot.container.querySelector(`img[src*="${retained.image.attachmentId}"]`)).toBeNull();
    expect((await fixture.readImage(ordinaryId)).equals(ordinary.bytes)).toBe(true);
  } finally {
    slot.unmount();
  }
}));
