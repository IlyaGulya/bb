// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createArtifactMemoryFixture } from "./artifact-memory.test-fixtures.js";
import { memoryRpcContract } from "./server.js";
import { taskArtifactRpcContract } from "../tasks/shared/artifacts.js";

type Fixture = Awaited<ReturnType<typeof createArtifactMemoryFixture>>;
type Surface = "fact" | "history" | "proposal-before" | "proposal-after";
const app = await loadPluginApp(() => import("./app"));
const fixtures: Fixture[] = [];
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
const memoryName = "pin-protected-fact";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
  Object.defineProperty(window, "matchMedia", { configurable: true, value: (media: string) => ({
    matches: false, media, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
  }) });
});

afterEach(async () => {
  cleanup();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
  vi.useRealTimers();
  if (originalMatchMedia) Object.defineProperty(window, "matchMedia", originalMatchMedia);
  else Reflect.deleteProperty(window, "matchMedia");
});

function mount(f: Fixture) {
  const rpc = Object.fromEntries(Object.keys(memoryRpcContract).map((method) => [method, (input: unknown) => f.memory.harness.behavior.callRpc(method, input)]));
  return renderSlot(app.threadPanelActions[0]!, { threadId: f.threadId, params: null }, { rpc });
}

async function openStoredOriginal(slot: ReturnType<typeof mount>, surface: Surface) {
  await slot.findByRole("button", { name: `History of ${memoryName}` });
  if (surface === "fact") {
    await act(async () => { fireEvent.click(slot.getByRole("button", { name: `Read retained original for ${memoryName}` })); });
    return;
  }
  if (surface === "history") {
    fireEvent.click(slot.getByRole("button", { name: `History of ${memoryName}` }));
    const history = await slot.findByRole("region", { name: "Memory version history" });
    fireEvent.click(within(history).getByText(/^pin-protected-fact v1 ·/));
    const button = await within(history).findByRole("button", { name: `Read retained original for ${memoryName} v1` });
    await waitFor(() => expect(button.matches(":disabled")).toBe(false));
    await act(async () => { fireEvent.click(button); });
    return;
  }
  const proposals = slot.getByRole("region", { name: "Reflection proposals" });
  fireEvent.click(within(proposals).getByText(/^Review pending reflection/));
  const name = surface === "proposal-before" ? "Read retained before-original" : "Read retained proposed original";
  await act(async () => { fireEvent.click(within(proposals).getByRole("button", { name })); });
}

const cases = (["fact", "history", "proposal-before", "proposal-after"] as const)
  .flatMap((surface) => [false, true].map((reused) => ({ surface, reused })));

describe("stored original source pins", () => {
  it.each(cases)("uses the persisted ID/hash pin in the $surface reader when UUID reuse = $reused", async ({ surface, reused }) => {
    const f = await createArtifactMemoryFixture();
    fixtures.push(f);
    const artifact = await f.retain();
    const { source } = await f.inspect(artifact.id);
    const saved = await f.remember(memoryName, "A decision pinned to the first retained source", source);
    if (surface === "proposal-before" || surface === "proposal-after") {
      await f.propose(saved, source, "A reviewed conclusion still pinned to the first original");
    }
    const secondQuote = "A different retained decision from the second source message.";
    let secondHash: string | null = null;
    if (reused) {
      expect(await f.native.harness.behavior.callRpc("deleteTaskArtifact", { ...f.native.scope, artifactId: artifact.id })).toEqual({ deleted: true });
      const replacement = await f.retain(secondQuote, artifact.id, 8);
      expect(replacement.id).toBe(artifact.id);
      expect(replacement.source.textSha256).not.toBe(source.revision);
      secondHash = replacement.source.textSha256;
      const fresh = await f.inspect(artifact.id);
      expect(fresh.view).toMatchObject({ artifact: { source: { quote: secondQuote, eventSeq: 8, textSha256: secondHash } }, sourceStatus: "available" });
    }
    expect((await f.read(saved.id))?.lineage?.source).toEqual(source);
    expect((await f.history(saved.id))[0]?.snapshot.lineage?.source).toEqual(source);
    const slot = mount(f);
    await openStoredOriginal(slot, surface);
    if (reused) {
      await waitFor(() => {
        const inspected = slot.queryByRole("region", { name: "Retained thread original" });
        const rejected = slot.queryByRole("alert");
        expect(inspected !== null || rejected !== null).toBe(true);
      });
      expect(slot.queryByText(secondQuote)).toBeNull();
      expect(slot.queryByText(`Raw source hash: ${secondHash}`)).toBeNull();
      expect(slot.queryByRole("region", { name: "Retained thread original" })).toBeNull();
      expect(slot.getByRole("alert")).toBeTruthy();
    } else {
      const inspected = await slot.findByRole("region", { name: "Retained thread original" });
      expect(within(inspected).getByText(artifact.source.quote)).toBeTruthy();
      expect(within(inspected).getByText(`Raw source hash: ${source.revision}`)).toBeTruthy();
    }
    expect((await f.read(saved.id))?.lineage?.source).toEqual(source);
    expect((await f.history(saved.id))[0]?.snapshot.lineage?.source).toEqual(source);
  }, 60_000);
});

const selectionCases = (["fact", "history", "proposal-before", "proposal-after"] as const)
  .flatMap((surface) => [false, true].map((changedSelection) => ({ surface, changedSelection })));

describe("stored retained-selection pins", () => {
  it.each(selectionCases)("preserves the stored excerpt in the $surface reader when the same-message selection changes = $changedSelection", async ({ surface, changedSelection }) => {
    const f = await createArtifactMemoryFixture();
    fixtures.push(f);
    const storedExcerpt = "Use SQLite for the durable store.";
    const firstSelection = `${storedExcerpt} Keep the original evidence available.`;
    const secondSelection = "Retain a separate decision about the narrow layout.";
    f.native.state.sourceText = `${firstSelection}\n\n${secondSelection}`;
    const input = f.native.input(false);
    const artifact = taskArtifactRpcContract.createTaskArtifact.output.parse(await f.native.harness.behavior.callRpc("createTaskArtifact", {
      ...input, source: { ...input.source, quote: firstSelection },
    }));
    const inspected = await f.inspect(artifact.id);
    const source = { ...inspected.source, quote: storedExcerpt };
    const saved = await f.remember(memoryName, "A decision pinned to the first retained selection", source);
    if (surface === "proposal-before" || surface === "proposal-after") {
      await f.propose(saved, source, "A reviewed conclusion retaining the original selected excerpt");
    }
    const removed = taskArtifactRpcContract.deleteTaskArtifact.output.parse(await f.native.harness.behavior.callRpc("deleteTaskArtifact", {
      ...f.native.scope, artifactId: artifact.id,
    }));
    expect(removed).toEqual({ deleted: true });
    const selectedQuote = changedSelection ? secondSelection : firstSelection;
    const recreated = taskArtifactRpcContract.createTaskArtifact.output.parse(await f.native.harness.behavior.callRpc("createTaskArtifact", {
      ...input, artifactId: artifact.id, source: { ...input.source, quote: selectedQuote },
    }));
    expect(recreated).toMatchObject({
      id: artifact.id, executionContextId: artifact.executionContextId,
      source: { threadId: artifact.source.threadId, eventSeq: artifact.source.eventSeq, textSha256: source.revision, quote: selectedQuote },
    });
    const fresh = await f.inspect(artifact.id);
    expect(fresh.view).toMatchObject({ sourceStatus: "available", artifact: {
      id: artifact.id, source: { quote: selectedQuote, textSha256: source.revision },
    } });
    expect((await f.read(saved.id))?.lineage?.source).toEqual(source);
    expect((await f.history(saved.id))[0]?.snapshot.lineage?.source).toEqual(source);
    const slot = mount(f);
    await openStoredOriginal(slot, surface);
    if (changedSelection) {
      await waitFor(() => {
        const original = slot.queryByRole("region", { name: "Retained thread original" });
        const rejected = slot.queryByRole("alert");
        expect(original !== null || rejected !== null).toBe(true);
      });
      expect(slot.queryByText(secondSelection)).toBeNull();
      expect(slot.queryByRole("region", { name: "Retained thread original" })).toBeNull();
      expect(slot.getByRole("alert")).toBeTruthy();
    } else {
      const original = await slot.findByRole("region", { name: "Retained thread original" });
      expect(within(original).getByText(firstSelection)).toBeTruthy();
      expect(within(original).getByText(`Raw source hash: ${source.revision}`)).toBeTruthy();
      expect(slot.queryByRole("alert")).toBeNull();
    }
    expect((await f.read(saved.id))?.lineage?.source).toEqual(source);
    expect((await f.history(saved.id))[0]?.snapshot.lineage?.source).toEqual(source);
  }, 60_000);
});
