import {
  assertRepositoryGroupAdmission,
  mayHaveWorkspaceRepositoryGroups,
} from "./workspace-repository-group.js";
import fs from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import { and, inArray } from "drizzle-orm";
import { areHostPathsEqual } from "@bb/domain";
import {
  getEnvironment,
  listEnvironments,
  threads,
  terminalSessions,
} from "@bb/db";
import {
  workspaceTransferOperationSchema,
  type TransferWorkspaceResponse,
} from "@bb/server-contract";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";

type Deps = Pick<AppDeps, "config" | "db">;
const registries = new WeakMap<
  AppDeps["db"],
  | Map<string, TransferWorkspaceResponse>
  | Promise<Map<string, TransferWorkspaceResponse>>
>();

function registry(
  deps: Deps,
):
  | Map<string, TransferWorkspaceResponse>
  | Promise<Map<string, TransferWorkspaceResponse>> {
  let current = registries.get(deps.db);
  if (!current) {
    try {
      statSync(path.join(deps.config.dataDir, "workspace-transfers"));
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
      const empty = new Map<string, TransferWorkspaceResponse>();
      registries.set(deps.db, empty);
      return empty;
    }
    current = loadRegistry(deps);
    registries.set(deps.db, current);
    void current.then(
      (loaded) => registries.set(deps.db, loaded),
      () => registries.delete(deps.db),
    );
  }
  return current;
}

async function loadRegistry(
  deps: Deps,
): Promise<Map<string, TransferWorkspaceResponse>> {
  const directory = path.join(deps.config.dataDir, "workspace-transfers");
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return new Map();
    throw error;
  }
  const result = new Map<string, TransferWorkspaceResponse>();
  for (const name of names) {
    if (!/^wtx_[a-f0-9-]{36}\.json$/u.test(name)) continue;
    const operation = workspaceTransferOperationSchema.parse(
      JSON.parse(await fs.readFile(path.join(directory, name), "utf8")),
    );
    if (operation.status === "ready")
      result.set(operation.operationId, operation);
  }
  return result;
}

export async function rememberWorkspaceContinuation(
  deps: Deps,
  operation: TransferWorkspaceResponse,
): Promise<void> {
  (await registry(deps)).set(operation.operationId, operation);
}

export function activeWorkspaceThreadIds(
  deps: Pick<AppDeps, "db">,
  environmentId: string,
): string[] {
  const environment = getEnvironment(deps.db, environmentId);
  const ids = environment?.path
    ? listEnvironments(deps.db, {
        hostId: environment.hostId,
        path: environment.path,
      }).map((entry) => entry.id)
    : [environmentId];
  return deps.db
    .select({ id: threads.id })
    .from(threads)
    .where(
      and(
        inArray(threads.environmentId, ids),
        inArray(threads.status, ["starting", "active", "stopping"]),
      ),
    )
    .all()
    .map((thread) => thread.id);
}

function workspaceHasOpenTerminal(deps: Deps, environmentId: string): boolean {
  const environment = getEnvironment(deps.db, environmentId);
  const ids = environment?.path
    ? listEnvironments(deps.db, {
        hostId: environment.hostId,
        path: environment.path,
      }).map((entry) => entry.id)
    : [environmentId];
  return (
    deps.db
      .select({ id: terminalSessions.id })
      .from(terminalSessions)
      .where(
        and(
          inArray(terminalSessions.environmentId, ids),
          inArray(terminalSessions.status, [
            "starting",
            "running",
            "disconnected",
          ]),
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

// Online dispatch must not add an asynchronous admission boundary for ordinary
// workspaces. Persisted or in-flight registries remain fail-closed.
export function workspaceContinuationAdmissionRequired(
  deps: Deps,
  environmentId: string | null,
): boolean {
  if (environmentId === null) return false;
  if (mayHaveWorkspaceRepositoryGroups(deps, environmentId)) return true;
  const current = registry(deps);
  if (current instanceof Promise) return true;
  if (!current.size) return false;
  const environment = getEnvironment(deps.db, environmentId);
  if (!environment?.path) return false;
  for (const operation of current.values()) {
    if (
      operation.hostId === environment.hostId &&
      areHostPathsEqual(operation.rootPath, environment.path)
    )
      return true;
    const source = getEnvironment(deps.db, operation.sourceEnvironmentId);
    if (
      source?.path &&
      source.hostId === environment.hostId &&
      areHostPathsEqual(source.path, environment.path)
    )
      return true;
  }
  return false;
}

export async function assertWorkspaceContinuationAdmission(
  deps: Deps,
  environmentId: string | null,
  currentThreadId?: string,
): Promise<void> {
  if (environmentId === null) return;
  if (mayHaveWorkspaceRepositoryGroups(deps, environmentId))
    await assertRepositoryGroupAdmission(deps, environmentId, currentThreadId);
  const current = registry(deps);
  const entries = current instanceof Promise ? await current : current;
  const environment = getEnvironment(deps.db, environmentId);
  if (!environment?.path) return;
  for (const operation of entries.values()) {
    const source = getEnvironment(deps.db, operation.sourceEnvironmentId);
    const isSource =
      source?.path &&
      source.hostId === environment.hostId &&
      areHostPathsEqual(source.path, environment.path);
    const isTarget =
      operation.hostId === environment.hostId &&
      areHostPathsEqual(operation.rootPath, environment.path);
    if (isTarget) {
      const writers = activeWorkspaceThreadIds(deps, environmentId).filter(
        (id) => id !== currentThreadId,
      );
      if (writers.length || workspaceHasOpenTerminal(deps, environmentId)) {
        throw new ApiError(
          409,
          "workspace_writer_conflict",
          `Transferred repository already has a writer or terminal: ${writers.join(", ") || environmentId}`,
        );
      }
    }
    const opposingEnvironmentId = isSource
      ? operation.environmentId
      : isTarget
        ? operation.sourceEnvironmentId
        : null;
    if (
      opposingEnvironmentId !== null &&
      (activeWorkspaceThreadIds(deps, opposingEnvironmentId).length ||
        workspaceHasOpenTerminal(deps, opposingEnvironmentId))
    ) {
      throw new ApiError(
        409,
        "workspace_continuation_active",
        `The other workspace in continuation ${operation.operationId} is executing or has an open terminal. Stop it before dispatching here.`,
        {
          details: {
            operationId: operation.operationId,
            opposingEnvironmentId,
          },
        },
      );
    }
  }
}
