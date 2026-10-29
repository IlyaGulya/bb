import { setAiServiceSelection } from "@bb/db";
import { createDeferredPromise } from "@bb/test-helpers";
import { describe, expect, it } from "vitest";
import { classifyTaskRoute } from "../../src/services/ai/task-route.js";
import { updateAiServiceSelection } from "../../src/services/ai/ai-services-view.js";
import { registerFakeAiService } from "../helpers/ai-services.js";
import { withTestHarness } from "../helpers/test-app.js";

const request = {
  text: "Investigate the retained writer's failing checkout",
  candidates: [{ id: "task-1", key: "DEV-1", title: "Fix checkout", projectId: "project-1" }],
  projects: [{ id: "project-1", name: "Development" }],
};
const signal = () => new AbortController().signal;

describe("bounded task-route helper", () => {
  it("is off by default and refuses automatic selection instead of silently selecting a payer", async () => {
    await withTestHarness({}, async harness => {
      const service = registerFakeAiService(harness.deps.aiServices);
      const outcome = await classifyTaskRoute(harness.deps, request, signal());
      expect(outcome.decision.kind).toBe("unavailable");
      expect(service.completeCalls).toEqual([]);
      await expect(updateAiServiceSelection(harness.deps, { task: "task-route", selection: { mode: "automatic" } })).rejects.toMatchObject({ status: 400 });
    });
  });
  it.each([
    JSON.stringify({ kind: "existing", taskId: "outside-candidates", reason: "Use another task" }),
    JSON.stringify({ kind: "new", projectId: "outside-projects", reason: "Use another project" }),
    JSON.stringify({ kind: "existing", taskId: "task-1", reason: "Use this", command: "publish" }),
    JSON.stringify({ kind: "clarify", question: "Which?", reason: "Ambiguous" }),
    "x".repeat(16001),
  ])("rejects an unsafe or unbounded classifier reply without retry or fallback", async reply => {
    await withTestHarness({}, async harness => {
      const selected = registerFakeAiService(harness.deps.aiServices, { id: "selected", complete: async () => reply });
      const other = registerFakeAiService(harness.deps.aiServices, { id: "other" });
      setAiServiceSelection(harness.db, "task-route", { mode: "service", pluginId: "fake-ai-plugin", serviceId: "selected" });
      const outcome = await classifyTaskRoute(harness.deps, request, signal());
      expect(outcome.decision.kind).toBe("unavailable");
      expect(outcome.callbackInvocations).toBe(1);
      expect(selected.completeCalls).toHaveLength(1);
      expect(other.completeCalls).toEqual([]);
    });
  });
  it("preserves a substantial scope question instead of line-cleaning JSON into a guessed route", async () => {
    await withTestHarness({}, async harness => {
      registerFakeAiService(harness.deps.aiServices, { complete: async () => JSON.stringify({ kind: "clarify", question: "Does this request extend DEV-1, or should it be a separate task in Development?", reason: "The existing task covers checkout failures, but the incoming scope could include a new feature." }, null, 2) });
      setAiServiceSelection(harness.db, "task-route", { mode: "service", pluginId: "fake-ai-plugin", serviceId: "fake-ai" });
      const outcome = await classifyTaskRoute(harness.deps, request, signal());
      expect(outcome.decision).toEqual({ kind: "clarify", question: "Does this request extend DEV-1, or should it be a separate task in Development?", reason: "The existing task covers checkout failures, but the incoming scope could include a new feature." });
    });
  });
  it("does not invoke a registered replacement or another service after the selected service is removed", async () => {
    await withTestHarness({}, async harness => {
      const selected = registerFakeAiService(harness.deps.aiServices, { id: "selected" });
      const other = registerFakeAiService(harness.deps.aiServices, { id: "other" });
      setAiServiceSelection(harness.db, "task-route", { mode: "service", pluginId: "fake-ai-plugin", serviceId: "selected" });
      selected.dispose();
      const outcome = await classifyTaskRoute(harness.deps, request, signal());
      expect(outcome.decision.kind).toBe("unavailable");
      expect(outcome.callbackInvocations).toBe(0);
      expect(other.completeCalls).toEqual([]);
    });
  });
  it("does not call a selected or replacement service when registration changes while readiness is pending", async () => {
    await withTestHarness({}, async harness => {
      const entered = createDeferredPromise<void>();
      const ready = createDeferredPromise<void>();
      const selected = registerFakeAiService(harness.deps.aiServices, { id: "selected", status: async () => { entered.resolve(); await ready.promise; return { ready: true }; } });
      setAiServiceSelection(harness.db, "task-route", { mode: "service", pluginId: "fake-ai-plugin", serviceId: "selected" });
      const pending = classifyTaskRoute(harness.deps, request, signal());
      await entered.promise;
      selected.dispose();
      const replacement = registerFakeAiService(harness.deps.aiServices, { id: "selected" });
      ready.resolve();
      const outcome = await pending;
      expect(outcome).toMatchObject({ decision: { kind: "unavailable" }, callbackInvocations: 0 });
      expect(selected.completeCalls).toEqual([]);
      expect(replacement.completeCalls).toEqual([]);
    });
  });
  it("does not invoke the completion callback for an already cancelled request", async () => {
    await withTestHarness({}, async harness => {
      const service = registerFakeAiService(harness.deps.aiServices);
      setAiServiceSelection(harness.db, "task-route", { mode: "service", pluginId: "fake-ai-plugin", serviceId: "fake-ai" });
      const controller = new AbortController();
      controller.abort();
      const outcome = await classifyTaskRoute(harness.deps, request, controller.signal);
      expect(outcome).toMatchObject({ decision: { kind: "unavailable" }, callbackInvocations: 0 });
      expect(service.completeCalls).toEqual([]);
    });
  });
});
