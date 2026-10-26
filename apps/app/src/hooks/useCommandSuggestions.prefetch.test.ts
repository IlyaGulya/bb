import { afterEach, describe, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { prefetchCommandCatalog } from "./useCommandSuggestions";

vi.mock("@/lib/sdk", () => ({
  sdk: {
    projects: {
      commands: vi.fn(),
    },
  },
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("useCommandSuggestions catalog prefetch", () => {
  it("warms the command catalog for the composer's project, provider, and environment", async () => {
    vi.mocked(sdk.projects.commands).mockResolvedValue({ commands: [] });
    const { queryClient } = createQueryClientTestHarness();

    await prefetchCommandCatalog(queryClient, {
      projectId: "project-1",
      providerId: "codex",
      environmentId: "env-1",
      hostId: null,
    });

    expect(sdk.projects.commands).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sdk.projects.commands).mock.calls[0]?.[0]).toEqual({
      projectId: "project-1",
      provider: "codex",
      environmentId: "env-1",
      signal: expect.any(AbortSignal),
    });
  });

  it("never reuses a warm command catalog across execution contexts or persisted threads", async () => {
    vi.mocked(sdk.projects.commands).mockResolvedValue({ commands: [] });
    const { queryClient } = createQueryClientTestHarness();
    const routing = {
      projectId: "project-1",
      providerId: "claude-code",
      environmentId: "env-1",
      hostId: null,
    };
    await prefetchCommandCatalog(queryClient, { ...routing, executionContextId: "work" });
    await prefetchCommandCatalog(queryClient, { ...routing, executionContextId: "personal" });
    await prefetchCommandCatalog(queryClient, { ...routing, threadId: "thread-work" });
    await prefetchCommandCatalog(queryClient, { ...routing, threadId: "thread-personal" });
    expect(sdk.projects.commands).toHaveBeenCalledTimes(4);
    await prefetchCommandCatalog(queryClient, { ...routing, threadId: "thread-personal" });
    expect(sdk.projects.commands).toHaveBeenCalledTimes(4);
  });
});
