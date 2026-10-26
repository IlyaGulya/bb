// @vitest-environment jsdom

import { useState } from "react";
import type { ExecutionContext, McpConfigurationInspection } from "@bb/domain";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { McpServerManager } from "./McpServerManager";

const machine = vi.hoisted(() => ({ status: "connected" }));

vi.mock("@/hooks/queries/host-queries", () => ({
  useHosts: () => ({
    data: [{ id: "worker", name: "Preview worker", status: machine.status }],
    isError: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/lib/sdk", () => ({
  sdk: { experimental_executionContexts: { inspectMcp: vi.fn() } },
}));

function inspection(configPaths: string[]): McpConfigurationInspection {
  return {
    hostId: "worker",
    providerId: "claude-code",
    files: configPaths.map((configPath) => ({
      configPath,
      status: "ok",
      issue: null,
      servers: [
        {
          name: configPath === "/extra.json" ? "extra" : "shared",
          transport: "stdio",
          supported: true,
          issue: null,
          authStatus: "not_checked",
        },
      ],
    })),
  };
}

function arrange() {
  function Editor() {
    const [refs, setRefs] = useState<ExecutionContext["mcpServers"]>([
      { name: "shared", configPath: "/saved.json" },
    ]);
    return <McpServerManager value={refs} onChange={setRefs} />;
  }
  const { wrapper } = createQueryClientTestHarness();
  return render(<Editor />, { wrapper });
}

function chooseMachine() {
  fireEvent.change(screen.getByLabelText("Preview machine"), {
    target: { value: "worker" },
  });
}

function inspectPath(path: string) {
  fireEvent.change(screen.getByLabelText("Add from native config file"), {
    target: { value: path },
  });
  fireEvent.click(screen.getByRole("button", { name: "Inspect config" }));
}

beforeEach(() => {
  machine.status = "connected";
  vi.mocked(sdk.experimental_executionContexts.inspectMcp).mockImplementation(
    async ({ configPaths }) => inspection(configPaths),
  );
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("MCP server selection", () => {
  it("keeps both saved and unsaved selections when inspection fails, without displaying raw errors", async () => {
    arrange();
    chooseMachine();
    await screen.findByRole("checkbox", { name: /shared · stdio/u });
    inspectPath("/extra.json");
    const extra = await screen.findByRole<HTMLInputElement>("checkbox", {
      name: /extra · stdio/u,
    });
    fireEvent.click(extra);
    expect(extra.checked).toBe(true);
    expect(screen.getByRole("button", { name: "Remove extra" })).toBeTruthy();

    vi.mocked(
      sdk.experimental_executionContexts.inspectMcp,
    ).mockRejectedValueOnce(
      new Error("private-credential-in-raw-parser-error"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Inspect config" }));
    await screen.findByRole("button", { name: "Retry inspection" });

    const selected = within(
      screen.getByRole("list", { name: "Selected MCP servers" }),
    );
    expect(selected.getByText("/saved.json")).toBeTruthy();
    expect(selected.getByText("/extra.json")).toBeTruthy();
    expect(screen.queryByText(/private-credential/u)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove shared" }));
    expect(screen.queryByRole("button", { name: "Remove shared" })).toBeNull();
    expect(screen.getByRole("button", { name: "Remove extra" })).toBeTruthy();
  });

  it("does not allow one selected name to refer to two different files", async () => {
    arrange();
    chooseMachine();
    await screen.findByRole("checkbox", { name: /shared · stdio/u });
    inspectPath("/other.json");
    const conflict = await screen.findByRole<HTMLInputElement>("checkbox", {
      name: /shared · stdio.*Name already selected/u,
    });
    expect(conflict.disabled).toBe(true);
    expect(
      within(
        screen.getByRole("list", { name: "Selected MCP servers" }),
      ).queryByText("/other.json"),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove shared" }));
    const replacement = await screen.findByRole<HTMLInputElement>("checkbox", {
      name: /shared · stdio/u,
    });
    await waitFor(() => expect(replacement.disabled).toBe(false));
    fireEvent.click(replacement);
    const selected = within(
      screen.getByRole("list", { name: "Selected MCP servers" }),
    );
    expect(selected.getByText("/other.json")).toBeTruthy();
    expect(selected.queryByText("/saved.json")).toBeNull();
  });

  it("keeps path entry and existing references editable while the machine is offline", () => {
    machine.status = "disconnected";
    arrange();
    chooseMachine();
    const path = screen.getByLabelText<HTMLInputElement>(
      "Add from native config file",
    );
    fireEvent.change(path, { target: { value: "/later.json" } });
    expect(path.value).toBe("/later.json");
    expect(path.disabled).toBe(false);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Inspect config" })
        .disabled,
    ).toBe(true);
    expect(screen.getByRole("button", { name: "Remove shared" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove shared" }));
    expect(screen.queryByRole("button", { name: "Remove shared" })).toBeNull();
    expect(path.value).toBe("/later.json");
  });
});
