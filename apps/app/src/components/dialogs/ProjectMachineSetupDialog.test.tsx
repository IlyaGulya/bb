// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ProjectSource } from "@bb/domain";
import type { PrepareMachineResponse } from "@bb/server-contract";
import { BbHttpError } from "@bb/sdk/browser";
import { createDeferredPromise } from "@bb/test-helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import {
  ProjectMachineSetupDialog,
  type ProjectMachineSetupDialogTarget,
} from "./ProjectMachineSetupDialog";

vi.mock("@/lib/sdk", () => ({
  sdk: {
    hosts: {
      cloneDefaultPath: vi.fn(),
      directory: vi.fn(),
      pathsExist: vi.fn(),
    },
    projects: { prepareMachine: vi.fn(), sources: { add: vi.fn() } },
  },
}));

const DEFAULT_CLONE_PATH = "/Users/me/bb/checkouts/bb";

const createdSource: ProjectSource = {
  id: "src_new",
  projectId: "proj_test",
  type: "local_path",
  hostId: "host_studio",
  path: DEFAULT_CLONE_PATH,
  isDefault: false,
  createdAt: 0,
  updatedAt: 0,
};

const originalSource: ProjectSource = {
  ...createdSource,
  id: "src_original",
  hostId: "host_laptop",
  path: "/Users/me/code/bb",
};

const gitTarget: ProjectMachineSetupDialogTarget = {
  projectId: "proj_test",
  projectName: "bb",
  gitRemoteUrl: "git@github.com:sawyerhood/bb.git",
  hostId: "host_studio",
  hostName: "Mac Studio",
  sources: [originalSource],
};

const prepared: PrepareMachineResponse = {
  source: createdSource,
  copiedFiles: [],
  readiness: {
    ready: true,
    checks: [
      { name: "git checkout", ok: true, detail: "HEAD is available on target" },
      { name: "project source", ok: true, detail: "Registered target checkout" },
    ],
  },
};

function renderDialog(target: ProjectMachineSetupDialogTarget = gitTarget) {
  const onComplete = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ProjectMachineSetupDialog
        target={target}
        onOpenChange={onOpenChange}
        onComplete={onComplete}
      />
    </QueryClientProvider>,
  );
  return { onComplete, onOpenChange };
}

beforeEach(() => {
  vi.mocked(sdk.hosts.cloneDefaultPath).mockResolvedValue({
    path: DEFAULT_CLONE_PATH,
  });
  vi.mocked(sdk.projects.prepareMachine).mockResolvedValue(prepared);
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("ProjectMachineSetupDialog", () => {
  it("prepares the resolved clone destination without implicitly copying files and waits for explicit continuation", async () => {
    const { onComplete } = renderDialog();

    expect(screen.getByText("Set up bb on Mac Studio")).toBeTruthy();
    expect(screen.getByText(gitTarget.gitRemoteUrl!)).toBeTruthy();
    expect(screen.getByText("Use an existing folder on Mac Studio")).toBeTruthy();
    expect(await screen.findByText(DEFAULT_CLONE_PATH)).toBeTruthy();
    expect((screen.getByLabelText("Additional file relative paths") as HTMLTextAreaElement).value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Prepare project" }));

    expect(await screen.findByText("Project preparation ready")).toBeTruthy();
    expect(sdk.projects.prepareMachine).toHaveBeenCalledWith({
      projectId: "proj_test",
      hostId: "host_studio",
      targetPath: DEFAULT_CLONE_PATH,
    });
    expect(sdk.projects.sources.add).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getByText("Passed: git checkout")).toBeTruthy();
    expect(screen.getByText("HEAD is available on target")).toBeTruthy();
    expect(screen.getByText("Copied 0 additional files.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onComplete).toHaveBeenCalledWith({
      hostId: "host_studio",
      source: createdSource,
    });
  });

  it("sends the edited destination as targetPath", async () => {
    renderDialog();
    await screen.findByText(DEFAULT_CLONE_PATH);

    fireEvent.click(screen.getByRole("button", { name: "change" }));
    fireEvent.change(screen.getByLabelText("Clone destination"), {
      target: { value: "/Users/me/elsewhere/bb" },
    });
    fireEvent.keyDown(screen.getByLabelText("Clone destination"), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Prepare project" }));

    await waitFor(() => expect(sdk.projects.prepareMachine).toHaveBeenCalled());
    expect(sdk.projects.prepareMachine).toHaveBeenCalledWith({
      projectId: "proj_test",
      hostId: "host_studio",
      targetPath: "/Users/me/elsewhere/bb",
    });
  });

  it("copies only explicitly listed paths from a selected source of this project and displays returned hashes", async () => {
    const hash = "a".repeat(64);
    vi.mocked(sdk.projects.prepareMachine).mockResolvedValue({
      ...prepared,
      copiedFiles: [{ path: ".env.local", sha256: hash }, { path: "assets/logo.png", sha256: "b".repeat(64) }],
    });
    renderDialog({
      ...gitTarget,
      sources: [
        originalSource,
        createdSource,
        { ...originalSource, id: "src_other", projectId: "proj_other", hostId: "host_other" },
      ],
    });
    await screen.findByText(DEFAULT_CLONE_PATH);
    fireEvent.click(screen.getByRole("combobox", { name: "Additional files source machine" }));
    expect(screen.queryByRole("option", { name: /host_other/u })).toBeNull();
    expect(screen.queryByRole("option", { name: /host_studio/u })).toBeNull();
    fireEvent.click(await screen.findByRole("option", { name: "host_laptop: /Users/me/code/bb" }));
    fireEvent.change(screen.getByLabelText("Additional file relative paths"), {
      target: { value: ".env.local\nassets/logo.png\n.env.local\n" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Prepare project" }));

    expect(await screen.findByText("Copied 2 additional files.")).toBeTruthy();
    expect(screen.getByText(`SHA-256: ${hash}`)).toBeTruthy();
    expect(sdk.projects.prepareMachine).toHaveBeenCalledWith({
      projectId: "proj_test",
      hostId: "host_studio",
      targetPath: DEFAULT_CLONE_PATH,
      sourceHostId: "host_laptop",
      copyPaths: [".env.local", "assets/logo.png"],
    });
  });

  it("requires a source machine when additional paths are selected", async () => {
    renderDialog();
    await screen.findByText(DEFAULT_CLONE_PATH);
    fireEvent.change(screen.getByLabelText("Additional file relative paths"), {
      target: { value: "config/local.json" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Prepare project" }));
    expect(await screen.findByText("Choose a source machine for the additional files.")).toBeTruthy();
    expect(sdk.projects.prepareMachine).not.toHaveBeenCalled();
  });

  it.each(["../secret", "/etc/secret", "nested/../secret", "C:\\secret"])("rejects non-relative copy path %s", async (path) => {
    renderDialog();
    await screen.findByText(DEFAULT_CLONE_PATH);
    fireEvent.click(screen.getByRole("combobox", { name: "Additional files source machine" }));
    fireEvent.click(await screen.findByRole("option", { name: "host_laptop: /Users/me/code/bb" }));
    fireEvent.change(screen.getByLabelText("Additional file relative paths"), { target: { value: path } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare project" }));
    expect(await screen.findByText("Enter file paths relative to the source project folder, without . or .. segments.")).toBeTruthy();
    expect(sdk.projects.prepareMachine).not.toHaveBeenCalled();
  });

  it("shows unsuccessful actual readiness checks without completing", async () => {
    vi.mocked(sdk.projects.prepareMachine).mockResolvedValue({
      ...prepared,
      readiness: {
        ready: false,
        checks: [{ name: "file verification", ok: false, detail: "Hash mismatch for config/local.json" }],
      },
    });
    const { onComplete } = renderDialog();
    await screen.findByText(DEFAULT_CLONE_PATH);
    fireEvent.click(screen.getByRole("button", { name: "Prepare project" }));

    expect(await screen.findByText("Project preparation needs attention")).toBeTruthy();
    expect(screen.getByText("Failed: file verification")).toBeTruthy();
    expect(screen.getByText("Hash mismatch for config/local.json")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("does not claim readiness while preparation is pending or allow duplicate submission", async () => {
    const { promise, resolve: resolvePreparation } = createDeferredPromise<PrepareMachineResponse>();
    vi.mocked(sdk.projects.prepareMachine).mockReturnValue(promise);
    const { onComplete } = renderDialog();
    await screen.findByText(DEFAULT_CLONE_PATH);
    fireEvent.click(screen.getByRole("button", { name: "Prepare project" }));
    expect(await screen.findByText(/Preparing the project on Mac Studio/u)).toBeTruthy();
    expect(screen.queryByText("Project preparation ready")).toBeNull();
    const submit = screen.getByRole("button", { name: "Prepare project" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    fireEvent.click(submit);
    expect(sdk.projects.prepareMachine).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
    resolvePreparation(prepared);
    expect(await screen.findByText("Project preparation ready")).toBeTruthy();
  });

  it("shows preparation errors verbatim and allows retrying", async () => {
    const gitStderr = "git clone failed: fatal: could not read Username for 'https://github.com'";
    vi.mocked(sdk.projects.prepareMachine).mockRejectedValue(new BbHttpError({
      status: 502,
      code: "git_command_failed",
      message: gitStderr,
      body: { code: "git_command_failed", message: gitStderr },
    }));
    renderDialog();
    await screen.findByText(DEFAULT_CLONE_PATH);
    fireEvent.click(screen.getByRole("button", { name: "Prepare project" }));
    expect(await screen.findByText(gitStderr)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Prepare project" }).hasAttribute("disabled")).toBe(false);
    vi.mocked(sdk.projects.prepareMachine).mockResolvedValue(prepared);
    fireEvent.click(screen.getByRole("button", { name: "Prepare project" }));
    expect(await screen.findByText("Project preparation ready")).toBeTruthy();
  });

  it("suggests another path or explicit existing-folder registration when the target is not empty", async () => {
    vi.mocked(sdk.projects.prepareMachine).mockRejectedValue(new BbHttpError({
      status: 409,
      code: "target_not_empty",
      message: "Target directory is not empty",
      body: { code: "target_not_empty", message: "Target directory is not empty" },
    }));
    renderDialog();
    await screen.findByText(DEFAULT_CLONE_PATH);
    fireEvent.click(screen.getByRole("button", { name: "Prepare project" }));
    expect(await screen.findByText("Target directory is not empty")).toBeTruthy();
    expect(screen.getByText(/use the existing-folder option/u)).toBeTruthy();
    expect(sdk.projects.sources.add).not.toHaveBeenCalled();
  });

  it("submits an existing browsed folder as a local_path source without preparation", async () => {
    vi.mocked(sdk.hosts.directory).mockResolvedValue({
      directory: "/Users/me/code/bb",
      parent: "/Users/me/code",
      entries: [],
    });
    vi.mocked(sdk.hosts.pathsExist).mockResolvedValue({ existence: { "/Users/me/code/bb": true } });
    vi.mocked(sdk.projects.sources.add).mockResolvedValue({ ...createdSource, path: "/Users/me/code/bb" });
    const { onComplete } = renderDialog();
    fireEvent.click(screen.getByText("Use an existing folder on Mac Studio"));
    await screen.findByText("This folder is empty.");
    const submit = await screen.findByRole("button", { name: "Use folder & continue" });
    await waitFor(() => expect(submit.hasAttribute("disabled")).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(sdk.projects.sources.add).toHaveBeenCalledWith({
      projectId: "proj_test",
      type: "local_path",
      hostId: "host_studio",
      path: "/Users/me/code/bb",
    });
    expect(sdk.projects.prepareMachine).not.toHaveBeenCalled();
  });

  it("offers only the folder option for a project without a git remote", () => {
    vi.mocked(sdk.hosts.directory).mockResolvedValue({ directory: "/Users/me", parent: null, entries: [] });
    renderDialog({ ...gitTarget, gitRemoteUrl: null });
    expect(screen.queryByText("Clone from the project remote")).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.getByRole("button", { name: "Use folder & continue" })).toBeTruthy();
    expect(screen.queryByLabelText("Additional file relative paths")).toBeNull();
  });
});
