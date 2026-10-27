// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  executionContextSchema,
  modelConnectionSchema,
  type McpConfigurationInspection,
} from "@bb/domain";
import { createDeferredPromise } from "@bb/test-helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { useExecutionBindingSelection } from "./useExecutionBindingSelection";

vi.mock("@/lib/sdk", () => ({
  sdk: {
    experimental_executionContexts: {
      list: vi.fn(),
      getProjectDefaults: vi.fn(),
      inspectMcp: vi.fn(),
    },
    experimental_modelConnections: { list: vi.fn() },
  },
}));

const contexts = ["work", "personal"].map((id) =>
  executionContextSchema.parse({
    id,
    name: id,
    projectIds: ["project"],
    mcpServers: [{ name: `${id}-tools`, configPath: `/${id}.json` }],
    createdAt: 0,
    updatedAt: 0,
  }),
);
const connections = ["work-account", "personal-account"].map((id) =>
  modelConnectionSchema.parse({
    id,
    name: id,
    provider: "claude-code",
    hostId: "worker",
    createdAt: 0,
    updatedAt: 0,
  }),
);
const validInspection: McpConfigurationInspection = {
  hostId: "worker",
  providerId: "claude-code",
  files: [
    {
      configPath: "/work.json",
      status: "ok",
      issue: null,
      servers: [
        {
          name: "work-tools",
          transport: "stdio",
          supported: true,
          issue: null,
          authStatus: "not_checked",
        },
      ],
    },
  ],
};

beforeEach(() => {
  vi.mocked(sdk.experimental_executionContexts.list).mockResolvedValue(
    contexts,
  );
  vi.mocked(sdk.experimental_modelConnections.list).mockResolvedValue(
    connections,
  );
  vi.mocked(
    sdk.experimental_executionContexts.getProjectDefaults,
  ).mockResolvedValue({
    projectId: "project",
    executionContextId: "work",
    modelConnectionId: null,
  });
  vi.mocked(sdk.experimental_executionContexts.inspectMcp).mockResolvedValue(
    validInspection,
  );
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("execution binding MCP selection", () => {
  it("keeps context tools independent of explicitly selected model accounts", async () => {
    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useExecutionBindingSelection({
          projectId: "project",
          providerId: "claude-code",
          hostId: "worker",
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.effectiveContextId).toBe("work"));

    act(() => result.current.selectConnection("work-account"));
    act(() => result.current.selectConnection("personal-account"));
    expect(result.current.effectiveContext?.mcpServers).toEqual(
      contexts[0]?.mcpServers,
    );
    expect(result.current.effectiveConnectionId).toBe("personal-account");

    act(() => result.current.selectContext("personal"));
    expect(result.current.effectiveContext?.mcpServers).toEqual(
      contexts[1]?.mcpServers,
    );
    expect(result.current.effectiveConnectionId).toBe("personal-account");
  });

  it("selects a gateway independently of context and rejects an unapproved execution machine", async () => {
    const gateway = modelConnectionSchema.parse({
      id: "personal-cpa",
      name: "Personal CPA",
      provider: "acp-omp",
      hostId: null,
      gateway: {
        baseUrl: "http://cpa:8317/v1",
        protocol: "openai-responses",
        accountPrefix: "personal",
        modelProvider: "openai-codex",
        credential: { kind: "file", path: "/private/cpa-client-key" },
        allowedHostIds: ["worker"],
      },
      createdAt: 0,
      updatedAt: 0,
    });
    vi.mocked(sdk.experimental_modelConnections.list).mockResolvedValue([
      ...connections,
      gateway,
    ]);
    vi.mocked(sdk.experimental_executionContexts.getProjectDefaults).mockResolvedValue({
      projectId: "project",
      executionContextId: null,
      modelConnectionId: null,
    });
    const { wrapper } = createQueryClientTestHarness();
    const { result, rerender } = renderHook(
      ({ hostId }: { hostId: string }) =>
        useExecutionBindingSelection({
          projectId: "project",
          providerId: "acp-omp",
          hostId,
        }),
      { wrapper, initialProps: { hostId: "worker" } },
    );
    await waitFor(() => expect(result.current.connections.isSuccess).toBe(true));
    act(() => result.current.selectConnection(gateway.id));
    await waitFor(() => expect(result.current.unavailableReason).toBeNull());
    expect(result.current.effectiveContext).toBeUndefined();
    expect(result.current.effectiveConnection).toEqual(gateway);

    rerender({ hostId: "other-worker" });
    expect(result.current.unavailableReason).toBe(
      "This machine is not allowed to use the CPA gateway connection.",
    );
    expect(result.current.effectiveConnectionId).toBe(gateway.id);
    expect(result.current.effectiveContext).toBeUndefined();
  });

  it("does not reuse another machine's valid inspection and blocks known invalid configuration", async () => {
    const nextInspection = createDeferredPromise<McpConfigurationInspection>();
    const { wrapper } = createQueryClientTestHarness();
    const { result, rerender } = renderHook(
      ({ hostId }: { hostId: string }) =>
        useExecutionBindingSelection({
          projectId: "project",
          providerId: "claude-code",
          hostId,
        }),
      { wrapper, initialProps: { hostId: "worker" } },
    );
    await waitFor(() =>
      expect(result.current.mcpInspection.isSuccess).toBe(true),
    );
    expect(result.current.mcpIssue).toBeNull();
    expect(result.current.unavailableReason).toBeNull();

    vi.mocked(
      sdk.experimental_executionContexts.inspectMcp,
    ).mockReturnValueOnce(nextInspection.promise);
    rerender({ hostId: "other-worker" });
    expect(result.current.mcpInspection.data).toBeUndefined();
    expect(result.current.effectiveContextId).toBe("work");
    expect(result.current.effectiveContext?.mcpServers).toEqual(
      contexts[0]?.mcpServers,
    );

    await act(async () => {
      nextInspection.resolve({
        hostId: "other-worker",
        providerId: "claude-code",
        files: [
          {
            configPath: "/work.json",
            status: "invalid",
            issue: "Invalid JSON configuration",
            servers: [],
          },
        ],
      });
      await nextInspection.promise;
    });
    await waitFor(() => expect(result.current.mcpIssue).not.toBeNull());
    expect(result.current.unavailableReason).toBe(result.current.mcpIssue);
    expect(result.current.effectiveContext?.mcpServers).toEqual(
      contexts[0]?.mcpServers,
    );
  });
});
