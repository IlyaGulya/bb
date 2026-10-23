import { areHostPathsEqual } from "@bb/domain";
import { getEnvironment, type DbConnection } from "@bb/db";
import { ApiError } from "../../errors.js";

const locks = new WeakMap<
  DbConnection,
  Map<string, { operationId: string; hostId: string; rootPath: string }>
>();

export function acquireWorkspaceTransferLock(
  db: DbConnection,
  environmentId: string,
  operationId: string,
  hostId: string,
  rootPath: string,
): () => void {
  let entries = locks.get(db);
  if (!entries) {
    entries = new Map();
    locks.set(db, entries);
  }
  if (
    entries.has(environmentId) ||
    [...entries.values()].some(
      (entry) =>
        entry.hostId === hostId && areHostPathsEqual(entry.rootPath, rootPath),
    )
  ) {
    throw new ApiError(
      409,
      "workspace_transfer_in_progress",
      "This workspace already has a transfer in progress",
    );
  }
  entries.set(environmentId, { operationId, hostId, rootPath });
  return () => {
    entries.delete(environmentId);
  };
}

export function assertWorkspaceTransferAdmission(
  db: DbConnection,
  environmentId: string | null,
): void {
  const environment =
    environmentId === null ? null : getEnvironment(db, environmentId);
  if (
    environmentId !== null &&
    (locks.get(db)?.has(environmentId) ||
      (environment !== null &&
        [...(locks.get(db)?.values() ?? [])].some(
          (entry) =>
            entry.hostId === environment.hostId &&
            environment.path !== null &&
            areHostPathsEqual(entry.rootPath, environment.path),
        )))
  ) {
    throw new ApiError(
      409,
      "workspace_transfer_in_progress",
      "This workspace is being transferred; wait for the operation to finish before starting work",
    );
  }
}
