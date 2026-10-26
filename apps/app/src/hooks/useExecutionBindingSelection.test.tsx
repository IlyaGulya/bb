// @vitest-environment jsdom
import { useState, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { executionContextSchema, modelConnectionSchema } from "@bb/domain";
import { useExecutionBindingSelection } from "./useExecutionBindingSelection";

const fixtures = vi.hoisted(() => ({
  contexts: [] as unknown[],
  connections: [] as unknown[],
}));
vi.mock("@/lib/sdk", () => ({ sdk: {
  experimental_executionContexts: {
    list: async () => fixtures.contexts,
    getProjectDefaults: async ({ projectId }: { projectId: string }) => ({ projectId, executionContextId: "work", modelConnectionId: null }),
  },
  experimental_modelConnections: { list: async () => fixtures.connections },
} }));

function wrapper({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useExecutionBindingSelection", () => {
  it("resolves server defaults but keeps an explicit account independent when context changes", async () => {
    fixtures.contexts = ["work", "personal"].map((id) => executionContextSchema.parse({ id, name: id, projectIds: ["project"], defaultModelConnectionId: id === "work" ? "work-account" : "personal-account", createdAt: 0, updatedAt: 0 }));
    fixtures.connections = ["work-account", "personal-account"].map((id) => modelConnectionSchema.parse({ id, name: id, provider: "claude-code", hostId: "host", createdAt: 0, updatedAt: 0 }));
    const { result } = renderHook(() => useExecutionBindingSelection({ projectId: "project", providerId: "claude-code", hostId: "host" }), { wrapper });
    await waitFor(() => expect(result.current.unavailableReason).toBeNull());
    expect(result.current.executionContextId).toBeUndefined();
    expect(result.current.effectiveContextId).toBe("work");
    expect(result.current.effectiveConnectionId).toBe("work-account");
    act(() => result.current.selectConnection("personal-account"));
    act(() => result.current.selectContext("personal"));
    expect(result.current.executionContextId).toBe("personal");
    expect(result.current.modelConnectionId).toBe("personal-account");
    act(() => result.current.selectContext("work"));
    expect(result.current.effectiveConnectionId).toBe("personal-account");
    expect(result.current.unavailableReason).toBeNull();
  });

  it("retains a now-incompatible explicit account and blocks it instead of silently replacing it", async () => {
    fixtures.contexts = [executionContextSchema.parse({ id: "work", name: "Work", projectIds: ["project"], createdAt: 0, updatedAt: 0 })];
    fixtures.connections = [modelConnectionSchema.parse({ id: "account", name: "Account", provider: "claude-code", hostId: "host", createdAt: 0, updatedAt: 0 })];
    const { result, rerender } = renderHook(({ hostId }) => useExecutionBindingSelection({ projectId: "project", providerId: "claude-code", hostId }), { wrapper, initialProps: { hostId: "host" } });
    await waitFor(() => expect(result.current.unavailableReason).toBeNull());
    act(() => result.current.selectConnection("account"));
    rerender({ hostId: "other-host" });
    expect(result.current.modelConnectionId).toBe("account");
    expect(result.current.unavailableReason).toBe("Model connection belongs to a different machine.");
  });
});
