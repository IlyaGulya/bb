import type { HostWorkspace } from "@bb/host-workspace";
import { makeWorkspaceMergeBase, makeWorkspaceStatus } from "@bb/test-helpers";
import { vi } from "vitest";

type GetCurrentBranchArgs = Parameters<HostWorkspace["getCurrentBranch"]>;
type GetStatusResult = Awaited<ReturnType<HostWorkspace["getStatus"]>>;
type GetDiffResult = Awaited<ReturnType<HostWorkspace["getDiff"]>>;
type GetLocalStateFingerprintResult = Awaited<ReturnType<HostWorkspace["getLocalStateFingerprint"]>>;
type GetSharedGitRefsFingerprintResult = Awaited<ReturnType<HostWorkspace["getSharedGitRefsFingerprint"]>>;
type CommitArgs = Parameters<HostWorkspace["commit"]>;

export function createFakeWorkspace(path: string, isGitRepo = true) {
  const status: GetStatusResult = makeWorkspaceStatus({
    mergeBase: makeWorkspaceMergeBase(),
  });
  const diff: GetDiffResult = {
    diff: "",
    truncated: false,
    shortstat: "",
    files: "",
    mergeBaseRef: null,
  };
  let localStateFingerprint: GetLocalStateFingerprintResult = `local:${path}:initial`;
  let localStateFingerprintError: Error | null = null;
  let sharedGitRefsFingerprint: GetSharedGitRefsFingerprintResult = `refs:${path}:initial`;
  let sharedGitRefsFingerprintError: Error | null = null;
  const workspace = {
    path,
    isGitRepo,
    isWorktree: false,
    getDefaultBranch: vi.fn(async () => "main"),
    getCurrentBranch: vi.fn(async (..._args: GetCurrentBranchArgs) => "main"),
    getHeadSha: vi.fn(async () => "commit-1"),
    getLocalStateFingerprint: vi.fn(async () => {
      if (localStateFingerprintError) {
        throw localStateFingerprintError;
      }
      return localStateFingerprint;
    }),
    getSharedGitRefsFingerprint: vi.fn(async () => {
      if (sharedGitRefsFingerprintError) {
        throw sharedGitRefsFingerprintError;
      }
      return sharedGitRefsFingerprint;
    }),
    getAdditionalWorkspaceWriteRoots: vi.fn(async () => []),
    getStatus: vi.fn(async () => status),
    getDiff: vi.fn(async () => diff),
    diffFiles: vi.fn(async () => ({
      files: [],
      shortstat: "",
      truncated: false,
      mergeBaseRef: null,
    })),
    diffPatch: vi.fn(async () => []),
    getPullRequest: vi.fn(async () => ({ outcome: "none" as const })),
    runPullRequestAction: vi.fn(async () => undefined),
    commit: vi.fn(async (..._args: CommitArgs) => ({
      commitSha: "commit-1",
      commitSubject: "commit",
    })),
    setLocalStateFingerprint(value: GetLocalStateFingerprintResult) {
      localStateFingerprint = value;
    },
    setLocalStateFingerprintError(value: Error | null) {
      localStateFingerprintError = value;
    },
    setSharedGitRefsFingerprint(value: GetSharedGitRefsFingerprintResult) {
      sharedGitRefsFingerprint = value;
    },
    setSharedGitRefsFingerprintError(value: Error | null) {
      sharedGitRefsFingerprintError = value;
    },
  } satisfies HostWorkspace & {
    setLocalStateFingerprint: (value: GetLocalStateFingerprintResult) => void;
    setLocalStateFingerprintError: (value: Error | null) => void;
    setSharedGitRefsFingerprint: (value: GetSharedGitRefsFingerprintResult) => void;
    setSharedGitRefsFingerprintError: (value: Error | null) => void;
  };

  return workspace;
}
