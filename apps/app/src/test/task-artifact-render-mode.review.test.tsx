// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { renderSlot, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { RouteNavigationProvider } from "@/components/ui/app-route-anchor";
import { LazyMarkdownHtml } from "@/components/ui/lazy-markdown-html";
import { ConversationMessageContent } from "@/components/thread/timeline/ConversationMessageContent";
import { TaskArtifactStore } from "../../../../plugins/tasks/artifacts/store";
import { taskArtifactSchema } from "../../../../plugins/tasks/shared/artifacts";
import { artifactConsumerRpc, loadTaskArtifactApp, withArtifactActionPanel } from "./task-artifact-action-review-fixture";
import { REVIEW_DECISION, sha256, withTaskArtifactReviewFixture, type TaskArtifactReviewFixture } from "./task-artifact-review-fixture";

type Role = "user" | "assistant";

beforeAll(() => LazyMarkdownHtml.preload());

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  cleanup();
  vi.restoreAllMocks();
});

function sourceMessage(fixture: TaskArtifactReviewFixture, role: Role, text: string) {
  const source = fixture.threads.get("thr_work_source");
  if (!source) throw new Error("Synthetic source message is missing");
  source.role = role;
  source.text = text;
}

function renderActualMessage(role: Role, text: string) {
  return render(<MemoryRouter><RouteNavigationProvider>
    {role === "user" ? <ConversationMessageContent
      role="user"
      attachments={null}
      initiator="user"
      mentions={[]}
      senderThreadId={null}
      senderThreadTitle={null}
      senderIsPluginSideChat={false}
      systemMessageKind="unlabeled"
      systemMessageSubject={null}
      text={text}
      timestamp={0}
      threadId="thr_work_source"
      projectId="proj_work"
      turnRequest={{ isGrouped: false, kind: "message", status: "accepted" }}
    /> : <ConversationMessageContent
      role="assistant"
      attachments={null}
      id="synthetic-source-message"
      threadId="thr_work_source"
      turnId="synthetic-source-turn"
      showActions={false}
      mobileActionDisplay="overflow"
      streaming={false}
      timestamp={0}
      text={text}
    />}
  </RouteNavigationProvider></MemoryRouter>);
}

async function actualInlineText(role: Role, raw: string) {
  const view = renderActualMessage(role, raw);
  try {
    await waitFor(() => expect(view.container.querySelector('[aria-label="Loading embedded HTML"]')).toBeNull());
    return await waitFor(() => {
      const paragraph = [...view.container.querySelectorAll("p")].find(element => element.textContent?.startsWith("Use"));
      if (!paragraph?.textContent) throw new Error("Actual role-specific prose has not rendered");
      if (raw.includes("<b>")) {
        if (role === "user") expect(paragraph.querySelector("b")).toBeNull();
        else expect(paragraph.querySelector("b")?.textContent).toBe("red");
      }
      return paragraph.textContent;
    });
  } finally {
    view.unmount();
  }
}

function retained(fixture: TaskArtifactReviewFixture) {
  return new TaskArtifactStore(fixture.store).list(fixture.workTask.id, "context_work", ["proj_work"]);
}

async function confirmActualForm(slot: RenderedSlot, fixture: TaskArtifactReviewFixture, expectedQuote: string, role: Role, raw: string) {
  fireEvent.click(await slot.findByRole("combobox", { name: "Task" }));
  fireEvent.click(await screen.findByRole("option", { name: `${fixture.workTask.key} · ${fixture.workTask.title}` }));
  fireEvent.change(slot.getByRole("textbox", { name: "Decision or requested change" }), { target: { value: REVIEW_DECISION } });
  const save = slot.getByRole("button", { name: "Save retained artifact" });
  expect(save).toHaveProperty("disabled", true);
  expect(retained(fixture)).toEqual([]);
  fireEvent.click(slot.getByRole("checkbox", { name: /I have reviewed/ }));
  expect(save).toHaveProperty("disabled", false);
  fireEvent.click(save);
  await waitFor(() => expect(retained(fixture).map(artifact => ({ source: artifact.source, decision: artifact.decision, annotation: artifact.annotation }))).toEqual([{
    source: { threadId: "thr_work_source", eventSeq: 7, role, quote: expectedQuote, textSha256: sha256(raw) },
    decision: REVIEW_DECISION,
    annotation: null,
  }]));
  expect(fixture.store.tasks.getTask(fixture.workTask.id)?.status).toBe(fixture.workTask.status);
}

const INLINE_RAW = "Use <b>red</b> button";
const ROLE_CASES = [
  { role: "user", visible: INLINE_RAW, undisplayed: "Use red button" },
  { role: "assistant", visible: "Use red button", undisplayed: INLINE_RAW },
] as const;

describe.each(ROLE_CASES)("authoritative $role HTML display mode", example => {
  it("prefills an ordinary message action with the actual role-specific displayed text", async () => withTaskArtifactReviewFixture(async fixture => {
    const visible = await actualInlineText(example.role, INLINE_RAW);
    expect(visible).toBe(example.visible);
    sourceMessage(fixture, example.role, INLINE_RAW);
    await withArtifactActionPanel(fixture, { text: INLINE_RAW, panelStateId: `artifact-role-prefill-${example.role}` }, async ({ slot, tab, storageKey }) => {
      await waitFor(() => expect(slot.getByRole("textbox", { name: /Source quote/ })).toHaveProperty("value", visible));
      expect(JSON.parse(tab.paramsJson ?? "null")).toEqual({ sourceThreadId: "thr_work_source", eventSeq: 7 });
      expect(window.localStorage.getItem(storageKey)).not.toContain("red");
      expect(retained(fixture)).toEqual([]);
    });
  }));

  it("retains the ordinary action's display text without repairing its quote or replacing raw provenance", async () => withTaskArtifactReviewFixture(async fixture => {
    const visible = await actualInlineText(example.role, INLINE_RAW);
    sourceMessage(fixture, example.role, INLINE_RAW);
    await withArtifactActionPanel(fixture, { text: INLINE_RAW, panelStateId: `artifact-role-save-${example.role}` }, async ({ slot }) => {
      await confirmActualForm(slot, fixture, visible, example.role, INLINE_RAW);
    });
  }));

  it("accepts the actual displayed quote through RPC with the authoritative source role and raw hash", async () => withTaskArtifactReviewFixture(async fixture => {
    const visible = await actualInlineText(example.role, INLINE_RAW);
    sourceMessage(fixture, example.role, INLINE_RAW);
    const saved = taskArtifactSchema.parse(await fixture.harness.callRpc("createTaskArtifact", fixture.request(null, { quote: visible })));
    const view = await fixture.view(saved);
    expect(view.sourceStatus).toBe("available");
    expect(view.artifact.source).toEqual({ threadId: "thr_work_source", eventSeq: 7, role: example.role, quote: visible, textSha256: sha256(INLINE_RAW) });
  }));

  it("refuses a whole-message phrase that belongs to the other role's display mode", async () => withTaskArtifactReviewFixture(async fixture => {
    const visible = await actualInlineText(example.role, INLINE_RAW);
    expect(visible.includes(example.undisplayed)).toBe(false);
    sourceMessage(fixture, example.role, INLINE_RAW);
    await expect(fixture.harness.callRpc("createTaskArtifact", fixture.request(null, { quote: example.undisplayed }))).rejects.toThrow();
    expect(retained(fixture)).toEqual([]);
  }));
});

it("restores a user-message panel from identity only using the source's literal-HTML display mode", async () => withTaskArtifactReviewFixture(async fixture => {
  const visible = await actualInlineText("user", INLINE_RAW);
  sourceMessage(fixture, "user", INLINE_RAW);
  const app = await loadTaskArtifactApp();
  const panel = app.threadPanelActions.find(entry => entry.id === "save-artifact");
  if (!panel?.component) throw new Error("Actual Tasks retention panel is missing");
  const slot = renderSlot({ component: panel.component }, {
    threadId: "thr_work_source",
    params: { sourceThreadId: "thr_work_source", eventSeq: 7 },
  }, {
    pluginId: "tasks",
    rpc: artifactConsumerRpc(fixture),
    sdk: { threads: { message: input => fixture.bb.sdk.threads.message(input) } },
  });
  try {
    await waitFor(() => expect(slot.getByRole("textbox", { name: /Source quote/ })).toHaveProperty("value", visible));
    expect(slot.getByRole("checkbox", { name: /I have reviewed/ })).toHaveProperty("checked", false);
    expect(slot.getByRole("button", { name: "Save retained artifact" })).toHaveProperty("disabled", true);
    expect(retained(fixture)).toEqual([]);
  } finally {
    slot.unmount();
  }
}));

it("keeps a plain user message usable through the same confirmed action and source-proof path", async () => withTaskArtifactReviewFixture(async fixture => {
  const raw = "Use red button";
  const visible = await actualInlineText("user", raw);
  sourceMessage(fixture, "user", raw);
  await withArtifactActionPanel(fixture, { text: raw, panelStateId: "artifact-role-user-plain" }, async ({ slot }) => {
    await confirmActualForm(slot, fixture, visible, "user", raw);
  });
}));

const FLOW_CASES = [
  { name: "br", raw: "Use<br>red button", visible: "Use\nred button" },
  { name: "adjacent block elements", raw: "<div>Use</div><div>red button</div>", visible: "Use\nred button" },
] as const;
type FlowCase = (typeof FLOW_CASES)[number];

async function actualFlowText(example: FlowCase) {
  const view = renderActualMessage("assistant", example.raw);
  try {
    await waitFor(() => expect(view.container.querySelector('[aria-label="Loading embedded HTML"]')).toBeNull());
    const visible = await waitFor(() => {
      if (example.name === "br") {
        const br = view.container.querySelector("br");
        const parent = br?.parentElement;
        if (!br || !parent) throw new Error("Actual assistant break has not rendered");
        const before = document.createRange();
        before.setStart(parent, 0);
        before.setEndBefore(br);
        const after = document.createRange();
        after.setStartAfter(br);
        after.setEnd(parent, parent.childNodes.length);
        expect([before.toString(), after.toString()]).toEqual(["Use", "red button"]);
        return `${before.toString()}\n${after.toString()}`;
      }
      const blocks = [...view.container.querySelectorAll("div")].filter(element => element.childElementCount === 0 && ["Use", "red button"].includes(element.textContent ?? ""));
      expect(blocks.map(element => element.textContent)).toEqual(["Use", "red button"]);
      return blocks.map(element => element.textContent).join("\n");
    });
    expect(visible).toBe(example.visible);
    return visible;
  } finally {
    view.unmount();
  }
}

describe.each(FLOW_CASES)("assistant visible flow boundary: $name", example => {
  it("does not prefill an ordinary action with visibly separated words concatenated", async () => withTaskArtifactReviewFixture(async fixture => {
    const visible = await actualFlowText(example);
    sourceMessage(fixture, "assistant", example.raw);
    await withArtifactActionPanel(fixture, { text: example.raw, panelStateId: `artifact-flow-prefill-${example.name}` }, async ({ slot }) => {
      await waitFor(() => expect(slot.getByRole("textbox", { name: /Source quote/ })).toHaveProperty("value", visible));
      expect(retained(fixture)).toEqual([]);
    });
  }));

  it("retains visible break text through the actual selected-text action after explicit confirmation", async () => withTaskArtifactReviewFixture(async fixture => {
    const visible = await actualFlowText(example);
    sourceMessage(fixture, "assistant", example.raw);
    await withArtifactActionPanel(fixture, { text: example.raw, selectedText: visible, panelStateId: `artifact-flow-selected-${example.name}` }, async ({ slot }) => {
      await confirmActualForm(slot, fixture, visible, "assistant", example.raw);
    });
  }));

  it("accepts the DOM-grounded visible break quote through RPC while retaining raw source provenance", async () => withTaskArtifactReviewFixture(async fixture => {
    const visible = await actualFlowText(example);
    sourceMessage(fixture, "assistant", example.raw);
    const saved = taskArtifactSchema.parse(await fixture.harness.callRpc("createTaskArtifact", fixture.request(null, { quote: visible })));
    expect((await fixture.view(saved)).artifact.source).toEqual({ threadId: "thr_work_source", eventSeq: 7, role: "assistant", quote: visible, textSha256: sha256(example.raw) });
  }));

  it("rejects a fabricated joined phrase rather than treating separated words as contiguous source text", async () => withTaskArtifactReviewFixture(async fixture => {
    const visible = await actualFlowText(example);
    expect(visible.includes("Usered button")).toBe(false);
    sourceMessage(fixture, "assistant", example.raw);
    await expect(fixture.harness.callRpc("createTaskArtifact", fixture.request(null, { quote: "Usered button" }))).rejects.toThrow();
    expect(retained(fixture)).toEqual([]);
  }));
});
