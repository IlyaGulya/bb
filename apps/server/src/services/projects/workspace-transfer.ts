import type { Thread } from "@bb/domain";
import type { CreateThreadRequest } from "@bb/server-contract";
import { getThreadSafe } from "../threads/thread-create-helpers.js";
import {
  assertWorkspaceContinuationAdmission,
  rememberWorkspaceContinuation,
} from "./workspace-transfer-admission.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import {
  createEnvironment,
  getEnvironment,
  getProjectSourceByHost,
  listEnvironments,
  threads,
  terminalSessions,
} from "@bb/db";
import {
  workspaceTransferOperationSchema,
  type PrepareMachineRequest,
  type PrepareMachineResponse,
  type PreviewWorkspaceTransferRequest,
  type PreviewWorkspaceTransferResponse,
  type TransferWorkspaceRequest,
  type TransferWorkspaceResponse,
  type WorkspaceTransferOperation,
} from "@bb/server-contract";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import {
  requireNonDestroyedHostWithStatus,
  requirePublicStandardProject,
} from "../lib/entity-lookup.js";
import { assertUsableHostId } from "../hosts/primary-host.js";
import { callHostOnlineRpcForWork } from "../hosts/online-rpc.js";
import { acquireWorkspaceTransferLock } from "./workspace-transfer-locks.js";
import {
  cloneProjectCheckoutOnHost,
  projectSourceHostConflict,
  registerProjectSourceOnHost,
} from "./project-source-setup.js";

const running = new Map<string, WorkspaceTransferOperation>();
const preparing = new WeakMap<AppDeps["db"], Set<string>>();
const TIMEOUT_MS = 20 * 60 * 1000;

function operationPath(deps: AppDeps, operationId: string): string {
  if (!/^wtx_[a-f0-9-]{36}$/u.test(operationId))
    throw new ApiError(
      400,
      "invalid_operation_id",
      "Invalid workspace transfer operation ID",
    );
  return path.join(
    deps.config.dataDir,
    "workspace-transfers",
    `${operationId}.json`,
  );
}

async function saveOperation(
  deps: AppDeps,
  operation: WorkspaceTransferOperation,
): Promise<void> {
  const filename = operationPath(deps, operation.operationId);
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(operation));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, filename);
  running.set(operation.operationId, operation);
  if (operation.status === "ready")
    await rememberWorkspaceContinuation(deps, operation);
}

export async function getWorkspaceTransfer(
  deps: AppDeps,
  operationId: string,
): Promise<WorkspaceTransferOperation> {
  const filename = operationPath(deps, operationId);
  let operation: WorkspaceTransferOperation;
  try {
    operation = workspaceTransferOperationSchema.parse(
      JSON.parse(await fs.readFile(filename, "utf8")),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new ApiError(
        404,
        "workspace_transfer_not_found",
        "Workspace transfer operation not found",
      );
    throw error;
  }
  if (
    !["ready", "failed", "interrupted"].includes(operation.status) &&
    !running.has(operationId)
  ) {
    operation = {
      ...operation,
      status: "interrupted",
      updatedAt: Date.now(),
      error:
        "The server stopped during transfer. The source is preserved. Inspect the target path before retrying with a new path; no target is overwritten automatically.",
    };
    await saveOperation(deps, operation);
    running.delete(operationId);
  }
  return operation;
}

function requireHost(deps: AppDeps, hostId: string): void {
  requireNonDestroyedHostWithStatus(deps, hostId);
  assertUsableHostId(deps, { hostId });
}

function sourceEnvironment(
  deps: AppDeps,
  projectId: string,
  environmentId: string,
) {
  requirePublicStandardProject(deps.db, projectId);
  const environment = getEnvironment(deps.db, environmentId);
  if (!environment || environment.projectId !== projectId)
    throw new ApiError(
      404,
      "environment_not_found",
      "Source environment does not belong to this project",
    );
  if (
    environment.status !== "ready" ||
    !environment.path ||
    environment.teardownStatus !== null ||
    environment.retireAt !== null
  )
    throw new ApiError(
      409,
      "workspace_not_ready",
      "Source environment must be ready and not retiring or being removed",
    );
  requireHost(deps, environment.hostId);
  return { ...environment, path: environment.path };
}

function activeThreads(deps: AppDeps, environmentId: string): string[] {
  return deps.db
    .select({ id: threads.id })
    .from(threads)
    .where(
      and(
        eq(threads.environmentId, environmentId),
        inArray(threads.status, ["starting", "active", "stopping"]),
      ),
    )
    .all()
    .map((thread) => thread.id);
}

function assertIdle(deps: AppDeps, environmentId: string): void {
  const source = getEnvironment(deps.db, environmentId);
  const environmentIds = source?.path
    ? listEnvironments(deps.db, {
        hostId: source.hostId,
        path: source.path,
      }).map((environment) => environment.id)
    : [environmentId];
  const ids = environmentIds.flatMap((id) => activeThreads(deps, id));
  if (ids.length)
    throw new ApiError(
      409,
      "workspace_active",
      `Stop all source workspace threads before transfer: ${ids.join(", ")}`,
    );
  const terminal = deps.db
    .select({ id: terminalSessions.id })
    .from(terminalSessions)
    .where(
      and(
        inArray(terminalSessions.environmentId, environmentIds),
        inArray(terminalSessions.status, [
          "starting",
          "running",
          "disconnected",
        ]),
      ),
    )
    .limit(1)
    .get();
  if (terminal)
    throw new ApiError(
      409,
      "workspace_terminal_active",
      `Close source workspace terminal ${terminal.id} before transfer`,
    );
}

export async function previewWorkspaceTransfer(
  deps: AppDeps,
  projectId: string,
  input: PreviewWorkspaceTransferRequest,
): Promise<PreviewWorkspaceTransferResponse> {
  const source = sourceEnvironment(deps, projectId, input.sourceEnvironmentId);
  requireHost(deps, input.targetHostId);
  const preview = await callHostOnlineRpcForWork(deps, {
    hostId: source.hostId,
    timeoutMs: TIMEOUT_MS,
    command: { type: "workspace.transferPreview", rootPath: source.path },
  });
  return {
    sourceEnvironmentId: source.id,
    sourceHostId: source.hostId,
    head: preview.head,
    branch: preview.branch,
    files: preview.files,
    activeThreadIds: [
      ...new Set([
        ...preview.activeThreadIds,
        ...activeThreads(deps, source.id),
      ]),
    ],
  };
}

export async function transferWorkspace(
  deps: AppDeps,
  projectId: string,
  input: TransferWorkspaceRequest,
): Promise<TransferWorkspaceResponse> {
  const source = sourceEnvironment(deps, projectId, input.sourceEnvironmentId);
  requireHost(deps, input.targetHostId);
  const relativeTarget = path.posix.relative(source.path, input.targetPath);
  if (
    source.hostId === input.targetHostId &&
    (relativeTarget === "" ||
      (relativeTarget !== ".." && !relativeTarget.startsWith("../")))
  )
    throw new ApiError(
      409,
      "workspace_target_inside_source",
      "Choose a new target outside the source workspace so transfer preserves the source unchanged",
    );
  const operationId = `wtx_${randomUUID()}`;
  const release = acquireWorkspaceTransferLock(
    deps.db,
    source.id,
    operationId,
    source.hostId,
    source.path,
  );
  let operation: WorkspaceTransferOperation = {
    operationId,
    projectId,
    sourceEnvironmentId: source.id,
    sourceHostId: source.hostId,
    targetHostId: input.targetHostId,
    targetPath: input.targetPath,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: "pending",
  };
  try {
    assertIdle(deps, source.id);
    await saveOperation(deps, operation);
    operation = { ...operation, status: "capturing", updatedAt: Date.now() };
    await saveOperation(deps, operation);
    const { checkpoint } = await callHostOnlineRpcForWork(deps, {
      hostId: source.hostId,
      timeoutMs: TIMEOUT_MS,
      command: {
        type: "workspace.capture",
        rootPath: source.path,
        includePaths: input.includePaths,
      },
    });
    assertIdle(deps, source.id);
    operation = { ...operation, status: "transferring", updatedAt: Date.now() };
    await saveOperation(deps, operation);
    const target = await callHostOnlineRpcForWork(deps, {
      hostId: input.targetHostId,
      timeoutMs: TIMEOUT_MS,
      command: {
        type: "workspace.restore",
        targetPath: input.targetPath,
        checkpoint,
        ...(input.branch === undefined ? {} : { branch: input.branch }),
      },
    });
    operation = { ...operation, status: "verifying", updatedAt: Date.now() };
    await saveOperation(deps, operation);
    if (
      target.head !== checkpoint.head ||
      target.rootPath !== input.targetPath ||
      target.branch !== (input.branch ?? checkpoint.branch)
    )
      throw new ApiError(
        502,
        "workspace_verification_failed",
        "Target did not verify the requested HEAD, branch and path; the target is preserved for inspection",
      );
    assertIdle(deps, source.id);
    const environment = createEnvironment(deps.db, deps.hub, {
      projectId,
      hostId: input.targetHostId,
      path: target.rootPath,
      isGitRepo: true,
      branchName: target.branch,
      status: "ready",
      providerOwnsPath: false,
      name: `Transferred ${source.name ?? source.id}`,
    });
    const handoff = [
      "Workspace continuation checkpoint verified.",
      `Project: ${projectId}`,
      `Operation: ${operationId}`,
      `Source environment: ${source.id} on ${source.hostId}`,
      `Target environment: ${environment.id} on ${input.targetHostId}`,
      `Workspace: ${target.rootPath}`,
      `HEAD: ${target.head}`,
      `Branch: ${target.branch ?? "detached HEAD"}`,
      "Git history (including unpublished HEAD), staged index, tracked worktree changes/deletions/modes and explicitly selected additional files were transferred and verified byte-for-byte. The source was preserved.",
      `Portable index entries: ${checkpoint.index.length}. Worktree delta entries: ${checkpoint.worktree.length}. Selected additional files: ${checkpoint.extraFiles.length}.`,
      `Tracked worktree deltas: ${checkpoint.worktree.length ? checkpoint.worktree.map((entry) => `${JSON.stringify(entry.path)}${entry.file === null ? " (deleted)" : ""}`).join(", ") : "none"}`,
      `Explicit additional files: ${input.includePaths.length ? input.includePaths.map((entry) => JSON.stringify(entry)).join(", ") : "none"}`,
      "Start a new native provider session here. No running process, native session, credentials, MCP setup or provider authentication was migrated. Review task context and inspect git status before continuing.",
    ].join("\n");
    const result: TransferWorkspaceResponse = {
      ...operation,
      status: "ready",
      updatedAt: Date.now(),
      environmentId: environment.id,
      hostId: input.targetHostId,
      rootPath: target.rootPath,
      head: target.head,
      branch: target.branch,
      handoff,
    };
    await saveOperation(deps, result);
    return result;
  } catch (error) {
    operation = {
      ...operation,
      status: "failed",
      updatedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    };
    await saveOperation(deps, operation);
    throw new ApiError(
      error instanceof ApiError ? error.status : 409,
      "workspace_transfer_failed",
      operation.error ?? "Workspace transfer failed",
      {
        details: {
          operationId,
          targetPath: input.targetPath,
          sourcePreserved: true,
        },
      },
    );
  } finally {
    running.delete(operationId);
    release();
  }
}

export async function createWorkspaceContinuationThread(
  deps: AppDeps,
  request: Pick<
    CreateThreadRequest,
    "projectId" | "environment" | "transferOperationId"
  >,
  create: () => Promise<Thread>,
): Promise<Thread> {
  if (request.transferOperationId === undefined) return create();
  const operation = await getWorkspaceTransfer(
    deps,
    request.transferOperationId,
  );
  if (
    operation.status !== "ready" ||
    operation.projectId !== request.projectId ||
    request.environment.type !== "reuse" ||
    request.environment.environmentId !== operation.environmentId
  )
    throw new ApiError(
      409,
      "invalid_workspace_continuation",
      "A continuation requires a ready transfer for this same project and reused target environment",
    );
  if (operation.continuationThreadId !== undefined)
    return getThreadSafe(deps, operation.continuationThreadId);
  const source = sourceEnvironment(
    deps,
    operation.projectId,
    operation.sourceEnvironmentId,
  );
  const release = acquireWorkspaceTransferLock(
    deps.db,
    source.id,
    operation.operationId,
    source.hostId,
    source.path,
  );
  try {
    assertIdle(deps, source.id);
    await assertWorkspaceContinuationAdmission(deps, source.id);
    assertIdle(deps, source.id);
    const existing = deps.db
      .select({ id: threads.id })
      .from(threads)
      .where(eq(threads.environmentId, operation.environmentId))
      .limit(1)
      .get();
    if (existing)
      throw new ApiError(
        409,
        "workspace_continuation_already_created",
        `The prepared target already contains thread ${existing.id}; inspect or recover that thread instead of creating another session`,
        {
          details: {
            operationId: operation.operationId,
            threadId: existing.id,
          },
        },
      );
    const thread = await create();
    if (
      thread.projectId !== operation.projectId ||
      thread.environmentId !== operation.environmentId
    )
      throw new ApiError(
        500,
        "workspace_continuation_target_mismatch",
        "Created continuation did not use its verified target environment",
      );
    await saveOperation(deps, {
      ...operation,
      continuationThreadId: thread.id,
      updatedAt: Date.now(),
    });
    running.delete(operation.operationId);
    return thread;
  } finally {
    release();
  }
}

export async function prepareMachine(
  deps: AppDeps,
  projectId: string,
  input: PrepareMachineRequest,
): Promise<PrepareMachineResponse> {
  const project = requirePublicStandardProject(deps.db, projectId);
  requireHost(deps, input.hostId);
  let operations = preparing.get(deps.db);
  if (!operations) {
    operations = new Set();
    preparing.set(deps.db, operations);
  }
  const key = `${projectId}:${input.hostId}`;
  if (operations.has(key))
    throw new ApiError(
      409,
      "project_preparation_in_progress",
      "This project is already being prepared on this machine",
    );
  if (getProjectSourceByHost(deps.db, projectId, input.hostId))
    throw projectSourceHostConflict();
  const copyPaths = input.copyPaths ?? [];
  const copySource =
    input.sourceHostId === undefined
      ? null
      : getProjectSourceByHost(deps.db, projectId, input.sourceHostId);
  if (input.sourceHostId !== undefined && !copySource)
    throw new ApiError(
      400,
      "invalid_copy_source",
      "The additional-file source machine must have a source belonging to this same project",
    );
  if (copyPaths.length && !copySource)
    throw new ApiError(
      400,
      "copy_source_required",
      "Choose this project's source machine before selecting additional files",
    );
  operations.add(key);
  try {
    const selected =
      copySource && copyPaths.length
        ? await callHostOnlineRpcForWork(deps, {
            hostId: copySource.hostId,
            timeoutMs: TIMEOUT_MS,
            command: {
              type: "workspace.copyRead",
              rootPath: copySource.path,
              paths: copyPaths,
            },
          })
        : { files: [] };
    const { existence } = await callHostOnlineRpcForWork(deps, {
      hostId: input.hostId,
      timeoutMs: TIMEOUT_MS,
      command: { type: "host.paths_exist", paths: [input.targetPath] },
    });
    let source;
    if (existence[input.targetPath] === true) {
      const inspected = await callHostOnlineRpcForWork(deps, {
        hostId: input.hostId,
        timeoutMs: TIMEOUT_MS,
        command: { type: "project.inspect", path: input.targetPath },
      });
      if (
        !project.gitRemoteUrl ||
        inspected.gitRemoteUrl !== project.gitRemoteUrl ||
        inspected.path !== input.targetPath
      )
        throw new ApiError(
          409,
          "project_source_target_conflict",
          "Existing target is not verified as this project's Git source; choose another path or explicitly register the existing source",
        );
      await callHostOnlineRpcForWork(deps, {
        hostId: input.hostId,
        timeoutMs: TIMEOUT_MS,
        command: {
          type: "workspace.transferPreview",
          rootPath: input.targetPath,
        },
      });
      source = {
        path: inspected.path,
        gitRemoteUrl: inspected.gitRemoteUrl,
        ownsPath: false,
      };
    } else if (existence[input.targetPath] === false) {
      source = {
        ...(await cloneProjectCheckoutOnHost(deps, {
          projectId,
          projectName: project.name,
          hostId: input.hostId,
          remoteUrl: project.gitRemoteUrl,
          targetPath: input.targetPath,
        })),
        ownsPath: true,
      };
    } else
      throw new ApiError(
        502,
        "invalid_host_response",
        "Target machine did not report whether the preparation path exists",
      );
    const copied = selected.files.length
      ? await callHostOnlineRpcForWork(deps, {
          hostId: input.hostId,
          timeoutMs: TIMEOUT_MS,
          command: {
            type: "workspace.copyWrite",
            rootPath: source.path,
            files: selected.files,
          },
        })
      : { files: [] };
    const expectedHashes = new Map(
      selected.files.map((file) => [file.path, file.sha256]),
    );
    if (
      copied.files.length !== selected.files.length ||
      copied.files.some((file) => expectedHashes.get(file.path) !== file.sha256)
    )
      throw new ApiError(
        502,
        "project_file_verification_failed",
        "The target did not verify every explicitly selected file; inspect the target before retrying",
      );
    const registered = registerProjectSourceOnHost(deps, {
      projectId,
      hostId: input.hostId,
      ...source,
    });
    const inspected = await callHostOnlineRpcForWork(deps, {
      hostId: input.hostId,
      timeoutMs: TIMEOUT_MS,
      command: { type: "project.inspect", path: registered.path },
    });
    const checks = [
      {
        name: "project-source",
        ok: registered.path === input.targetPath,
        detail: `Registered project source at ${registered.path}`,
      },
      {
        name: "git-origin",
        ok:
          project.gitRemoteUrl !== null &&
          inspected.gitRemoteUrl === project.gitRemoteUrl,
        detail:
          inspected.gitRemoteUrl === project.gitRemoteUrl
            ? "Git origin matches this project"
            : "Git origin differs from this project; inspect it before dispatch",
      },
      {
        name: "additional-files",
        ok: copied.files.length === selected.files.length,
        detail: `${copied.files.length} explicitly selected files copied into this registered source checkout with binary hashes and modes verified; no existing files overwritten. New isolated Git worktrees do not automatically inherit untracked or ignored copies.`,
      },
    ];
    return {
      source: registered,
      copiedFiles: copied.files,
      readiness: { ready: checks.every((check) => check.ok), checks },
    };
  } finally {
    operations.delete(key);
  }
}
