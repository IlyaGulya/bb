// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProductAnalyticsEvent } from "@bb/server-contract";
import { PluginContext } from "@/components/plugin/plugin-context";
import { experimental_useProductAnalytics } from "./plugin-sdk-hooks";
import { productAnalyticsOutbox, recordProductAnalytics } from "./product-analytics";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter initialEntries={["/projects/proj_analytics_fixture"]}><PluginContext.Provider value="tasks">{children}</PluginContext.Provider></MemoryRouter>;
}

describe("plugin-local analytics provenance", () => {
  it("does not let structurally extra caller options forge human attribution outside trusted input", () => {
    const envelopes: ProductAnalyticsEvent[] = [];
    vi.spyOn(productAnalyticsOutbox, "record").mockImplementation(async event => { envelopes.push(event); return true; });
    const hook = renderHook(() => experimental_useProductAnalytics(), { wrapper: Wrapper });
    const ordinaryOperation = crypto.randomUUID();
    const forgedOptions = { operationId: crypto.randomUUID(), actorKind: "human" as const };
    const coreOperation = crypto.randomUUID();
    const envelope = (operationId: string) => {
      const event = envelopes.find(value => value.operationId === operationId);
      if (!event) throw new Error("Core did not construct the requested action envelope");
      return event;
    };
    act(() => {
      hook.result.current("video.open", "started", { operationId: ordinaryOperation });
      recordProductAnalytics("plugin.tasks", "video.open", "started", { operationId: coreOperation, actorKind: "system", scope: { kind: "project", projectId: "proj_analytics_fixture" } });
    });
    expect(envelope(ordinaryOperation).actorKind).toBe("unknown");
    expect(envelope(ordinaryOperation).scope).toEqual({ kind: "project", projectId: "proj_analytics_fixture" });
    expect(envelope(coreOperation).actorKind).toBe("system");
    act(() => { hook.result.current("video.open", "started", forgedOptions); });
    expect(envelope(forgedOptions.operationId).actorKind).toBe("unknown");
    expect(envelope(forgedOptions.operationId).scope).toEqual({ kind: "project", projectId: "proj_analytics_fixture" });
  });
});
