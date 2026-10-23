import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
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
  Promise<Map<string, TransferWorkspaceResponse>>
>();

async function registry(
  deps: Deps,
): Promise<Map<string, TransferWorkspaceResponse>> {
  let current = registries.get(deps.db);
  if (!current) {
    current = loadRegistry(deps);
    registries.set(deps.db, current);
    void current.catch(() => registries.delete(deps.db));
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
  return (
    deps.db
      .select({ id: terminalSessions.id })
      .from(terminalSessions)
      .where(
        and(
          eq(terminalSessions.environmentId, environmentId),
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

export async function assertWorkspaceContinuationAdmission(
  deps: Deps,
  environmentId: string | null,
): Promise<void> {
  if (environmentId === null) return;
  const entries = await registry(deps);
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
