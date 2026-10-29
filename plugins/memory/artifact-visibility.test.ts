import { describe, expect, it } from "vitest";
import { memoryRpcContract } from "./server.js";
import { createArtifactMemoryFixture } from "./artifact-memory.test-fixtures.js";

type Fixture = Awaited<ReturnType<typeof createArtifactMemoryFixture>>;
const privateMarker = "visibilityprivatemarker";
const publicMarker = "visibilitypublicmarker";

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const fixture = await createArtifactMemoryFixture();
  try { await run(fixture); } finally { await fixture.dispose(); }
}

async function hiddenOutsideOrigin(f: Fixture, ids: string[], proposalIds: string[], publicId: string) {
  for (const selection of [f.other, f.unbound]) {
    const catalog = await f.call("listMemories", { ...selection, offset: 0 }, memoryRpcContract.listMemories.output);
    expect(catalog.memories.map((record) => record.id)).toContain(publicId);
    expect(JSON.stringify(catalog)).not.toContain(privateMarker);
    expect((await f.call("searchMemories", { ...selection, query: privateMarker }, memoryRpcContract.searchMemories.output)).memories).toEqual([]);
    for (const id of ids) {
      expect(catalog.memories.map((record) => record.id)).not.toContain(id);
      expect(await f.read(id, selection)).toBeNull();
      expect(await f.history(id, selection)).toEqual([]);
      expect((await f.call("memoryHistory", { ...selection, name: id, version: 1 }, memoryRpcContract.memoryHistory.output)).history).toEqual([]);
    }
    const proposals = await f.call("listReflections", selection, memoryRpcContract.listReflections.output);
    expect(JSON.stringify(proposals)).not.toContain(privateMarker);
    for (const id of proposalIds) {
      await expect(f.call("getReflection", { ...selection, id }, memoryRpcContract.getReflection.output)).rejects.toThrow();
    }
    const summary = await f.call("taskSummary", selection, memoryRpcContract.taskSummary.output);
    expect(summary.summary).toContain(publicMarker);
    expect(summary.summary).not.toContain(privateMarker);
    const injected = await f.injected(selection);
    expect(injected).toContain(publicMarker);
    expect(injected).not.toContain(privateMarker);
  }
}

async function attempt<T>(operation: () => Promise<T>) {
  try { return { accepted: true as const, value: await operation() }; }
  catch (error) { return { accepted: false as const, error }; }
}

describe("native artifact evidence visibility", () => {
  it("preserves ordinary native provenance, replacement, history and proposal sharing as positive controls", async () => withFixture(async (f) => {
    const initial = await f.remember("native-original", publicMarker, f.nativeSource());
    const proposal = await f.propose(initial, await f.commentSource());
    await f.decide(proposal.id);
    const revised = await f.read(initial.id);
    if (!revised) throw new Error("Native positive control disappeared");
    expect(revised).toMatchObject({ version: 2, summary: publicMarker, details: initial.details, lineage: { source: { kind: "comment" } } });
    const replacement = await f.remember("native-replacement", publicMarker, f.nativeSource(), { id: revised.id, version: revised.version });
    const pending = await f.propose(replacement, await f.commentSource(), `${publicMarker} reviewed`);
    for (const selection of [f.selection, f.other, f.unbound]) {
      expect(await f.read(replacement.id, selection)).toMatchObject({ id: replacement.id, summary: publicMarker });
      expect((await f.call("searchMemories", { ...selection, query: publicMarker }, memoryRpcContract.searchMemories.output)).memories.map((record) => record.id)).toContain(replacement.id);
      expect((await f.history(initial.id, selection)).map((entry) => entry.version)).toEqual([3, 2, 1]);
      expect((await f.call("getReflection", { ...selection, id: pending.id }, memoryRpcContract.getReflection.output)).diffs[0]?.before.summary).toBe(publicMarker);
      expect((await f.call("listReflections", selection, memoryRpcContract.listReflections.output)).proposals.map((entry) => entry.id)).toContain(pending.id);
      expect((await f.call("taskSummary", selection, memoryRpcContract.taskSummary.output)).summary).toContain(publicMarker);
      expect(await f.injected(selection)).toContain(publicMarker);
    }
  }), 60_000);

  it("allows same-context artifact reflections and replacements without hiding their originals from A", async () => withFixture(async (f) => {
    const artifact = await f.retain();
    const { source } = await f.inspect(artifact.id);
    const shared = await f.remember("shared-control", publicMarker, f.nativeSource());
    const initial = await f.remember("artifact-original", privateMarker, source);
    const proposal = await f.propose(initial, source, `${privateMarker} reviewed`);
    await f.decide(proposal.id);
    const revised = await f.read(initial.id);
    if (!revised) throw new Error("Same-context artifact revision disappeared");
    expect(revised).toMatchObject({ version: 2, summary: `${privateMarker} reviewed`, lineage: { source: { kind: "artifact", revision: source.revision } } });
    const replacement = await f.remember("artifact-replacement", privateMarker, source, { id: revised.id, version: revised.version });
    const pending = await f.propose(replacement, source, `${privateMarker} next review`);
    expect(await f.read(replacement.id)).toMatchObject({ id: replacement.id, summary: privateMarker });
    expect((await f.call("searchMemories", { ...f.selection, query: privateMarker }, memoryRpcContract.searchMemories.output)).memories.map((record) => record.id)).toEqual(expect.arrayContaining([initial.id, replacement.id]));
    expect((await f.history(initial.id)).map((entry) => entry.version)).toEqual([3, 2, 1]);
    expect((await f.call("getReflection", { ...f.selection, id: pending.id }, memoryRpcContract.getReflection.output)).diffs[0]?.before.summary).toBe(privateMarker);
    expect(await f.injected(f.selection)).toContain(privateMarker);
    await hiddenOutsideOrigin(f, [initial.id, replacement.id], [proposal.id, pending.id], shared.id);
  }), 60_000);

  it.each([
    { operation: "reflection", provenance: "task", state: "current" },
    { operation: "reflection", provenance: "comment", state: "current" },
    { operation: "reflection", provenance: "task", state: "obsolete" },
    { operation: "reflection", provenance: "comment", state: "obsolete" },
    { operation: "replacement", provenance: "task", state: "current" },
    { operation: "replacement", provenance: "comment", state: "current" },
  ] as const)("never declassifies artifact content through $operation to $provenance / $state", async ({ operation, provenance, state }) => withFixture(async (f) => {
    const artifact = await f.retain();
    const { source } = await f.inspect(artifact.id);
    const target = provenance === "task" ? f.nativeSource() : await f.commentSource();
    const shared = await f.remember("shared-control", publicMarker, target);
    const original = await f.remember("restricted-original", privateMarker, source, null, `${privateMarker} retained details`);
    const ids = [original.id];
    const proposalIds: string[] = [];
    expect(await f.injected(f.selection)).toContain(privateMarker);
    await hiddenOutsideOrigin(f, ids, proposalIds, shared.id);
    const transition = await attempt(async () => {
      if (operation === "replacement") {
        return f.remember("derived-native-source", original.summary, target, { id: original.id, version: original.version }, original.details);
      }
      const proposal = await f.propose(original, target, original.summary, state);
      proposalIds.push(proposal.id);
      await f.decide(proposal.id);
      const revised = await f.read(original.id);
      if (!revised) throw new Error("Accepted reflection lost the originating record");
      return revised;
    });
    if (transition.accepted) {
      const derived = transition.value;
      if (derived.id !== original.id) ids.push(derived.id);
      expect(derived).toMatchObject({ summary: original.summary, details: original.details, lineage: { source: { kind: provenance } } });
      expect(await f.read(derived.id)).toMatchObject({ id: derived.id, summary: original.summary, details: original.details });
      expect((await f.history(derived.id)).map((entry) => entry.snapshot.summary)).toContain(original.summary);
      const pending = await attempt(() => f.propose(derived, target, `${privateMarker} pending follow-up`));
      if (pending.accepted) {
        proposalIds.push(pending.value.id);
        expect((await f.call("getReflection", { ...f.selection, id: pending.value.id }, memoryRpcContract.getReflection.output)).diffs[0]?.before.summary).toBe(original.summary);
      } else {
        expect(await f.read(derived.id)).toMatchObject({ id: derived.id, version: derived.version, summary: original.summary });
      }
      const summary = await f.injected(f.selection);
      if (state === "current") expect(summary).toContain(privateMarker);
      else expect(summary).not.toContain(privateMarker);
    } else {
      expect(transition.error).toBeInstanceOf(Error);
      expect(await f.read(original.id)).toMatchObject({ id: original.id, version: 1, summary: original.summary, details: original.details, lineage: { state: "current", source } });
      expect(await f.read("derived-native-source")).toBeNull();
      expect((await f.history(original.id)).map((entry) => entry.version)).toEqual([1]);
      expect(await f.injected(f.selection)).toContain(privateMarker);
    }
    expect((await f.history(original.id)).map((entry) => entry.snapshot.summary)).toContain(original.summary);
    await hiddenOutsideOrigin(f, ids, proposalIds, shared.id);
  }), 60_000);
});
