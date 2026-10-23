import fs from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  getEnvironment,
  listEnvironments,
  threads,
  terminalSessions,
} from "@bb/db";
import { and, inArray } from "drizzle-orm";
import type { TransferWorkspaceResponse } from "@bb/server-contract";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";

const groupSchema = z
  .object({
    primaryEnvironmentId: z.string(),
    hostId: z.string(),
    writerThreadId: z.string().nullable(),
    roots: z
      .array(
        z
          .object({
            environmentId: z.string(),
            sourceEnvironmentId: z.string(),
            operationId: z.string(),
            path: z.string(),
            head: z.string(),
            branch: z.string().nullable(),
          })
          .strict(),
      )
      .min(2),
  })
  .strict();
type Group = z.infer<typeof groupSchema>;
type Deps = Pick<AppDeps, "db" | "config">;
const registries = new WeakMap<
  AppDeps["db"],
  Map<string, Group> | Promise<Map<string, Group>>
>();
const emptyRegistries = new WeakSet<AppDeps["db"]>();
const saving = new WeakSet<Group>();
// This synchronous predicate keeps ordinary dispatch free of extra promises and
// awaits. A persisted registry is still loaded before admitting any bound work.
export function mayHaveWorkspaceRepositoryGroups(
  deps: Deps,
  environmentId?: string,
): boolean {
  if (emptyRegistries.has(deps.db)) return false;
  const current = registries.get(deps.db);
  if (current instanceof Map) {
    if (environmentId === undefined) return current.size > 0;
    const environment = getEnvironment(deps.db, environmentId);
    if (!environment?.path) return false;
    for (const group of current.values())
      for (const root of group.roots) {
        if (
          group.hostId === environment.hostId &&
          root.path === environment.path
        )
          return true;
        const source = getEnvironment(deps.db, root.sourceEnvironmentId);
        if (
          source?.hostId === environment.hostId &&
          source.path === environment.path
        )
          return true;
      }
    return false;
  }
  if (current) return true;
  try {
    statSync(path.join(deps.config.dataDir, "workspace-repository-groups"));
    return true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
    emptyRegistries.add(deps.db);
    return false;
  }
}
async function registry(deps: Deps): Promise<Map<string, Group>> {
  let pending = registries.get(deps.db);
  if (!pending) {
    if (!mayHaveWorkspaceRepositoryGroups(deps)) {
      pending = new Map<string, Group>();
    } else {
      pending = (async () => {
        const directory = path.join(
          deps.config.dataDir,
          "workspace-repository-groups",
        );
        const result = new Map<string, Group>();
        for (const filename of await fs.readdir(directory)) {
          if (!filename.endsWith(".json")) continue;
          const group = groupSchema.parse(
            JSON.parse(
              await fs.readFile(path.join(directory, filename), "utf8"),
            ),
          );
          result.set(group.primaryEnvironmentId, group);
        }
        if (!result.size) emptyRegistries.add(deps.db);
        return result;
      })();
    }
    registries.set(deps.db, pending);
    if (pending instanceof Promise)
      void pending.then(
        (loaded) => registries.set(deps.db, loaded),
        () => registries.delete(deps.db),
      );
  }
  return pending;
}
async function save(deps: Deps, group: Group): Promise<void> {
  if (!/^[a-zA-Z0-9_-]+$/u.test(group.primaryEnvironmentId))
    throw new Error("Invalid primary environment ID");
  await fs.mkdir(
    path.join(deps.config.dataDir, "workspace-repository-groups"),
    { recursive: true, mode: 0o700 },
  );
  const filename = path.join(
    deps.config.dataDir,
    "workspace-repository-groups",
    `${group.primaryEnvironmentId}.json`,
  );
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(groupSchema.parse(group)));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, filename);
}
export async function assertRepositoryTargetUnowned(
  deps: Deps,
  hostId: string,
  targetPath: string,
): Promise<void> {
  for (const group of (await registry(deps)).values())
    if (
      group.hostId === hostId &&
      group.roots.some(
        (root) =>
          root.path === targetPath ||
          root.path.startsWith(`${targetPath}/`) ||
          targetPath.startsWith(`${root.path}/`),
      )
    )
      throw new ApiError(
        409,
        "repository_group_owned",
        "The requested target overlaps a repository owned by a coherent executor",
      );
}
export async function registerWorkspaceRepositoryGroup(
  deps: Deps,
  operations: TransferWorkspaceResponse[],
): Promise<void> {
  const primary = operations[0];
  if (!primary || operations.length < 2)
    throw new ApiError(
      400,
      "invalid_repository_group",
      "A repository group requires at least two verified transfers",
    );
  const groups = await registry(deps);
  if (operations.some((entry) => entry.hostId !== primary.hostId))
    throw new ApiError(
      409,
      "repository_host_mismatch",
      "All repositories must be prepared on the same execution host",
    );
  const paths = operations.map((entry) => entry.rootPath);
  if (
    paths.some((root, index) =>
      paths.some(
        (other, otherIndex) =>
          index !== otherIndex &&
          (root === other || root.startsWith(`${other}/`)),
      ),
    )
  )
    throw new ApiError(
      409,
      "repository_roots_overlap",
      "Repository roots must be distinct and non-nested",
    );
  const ids = operations.map((entry) => entry.operationId);
  const existing = groups.get(primary.environmentId);
  if (existing) {
    if (saving.has(existing))
      throw new ApiError(
        409,
        "repository_group_busy",
        "Repository ownership is being persisted; retry after it settles",
      );
    if (
      JSON.stringify(existing.roots.map((entry) => entry.operationId)) !==
      JSON.stringify(ids)
    )
      throw new ApiError(
        409,
        "repository_group_changed",
        "An established repository group cannot be replaced",
      );
    return;
  }
  if (operations.some((entry) => entry.continuationThreadId))
    throw new ApiError(
      409,
      "repository_already_started",
      "An existing single-repository executor cannot be silently converted into a repository group",
    );
  for (const group of groups.values())
    if (
      group.roots.some((root) =>
        operations.some(
          (entry) =>
            root.operationId === entry.operationId ||
            root.sourceEnvironmentId === entry.sourceEnvironmentId ||
            (group.hostId === entry.hostId &&
              (root.path === entry.rootPath ||
                root.path.startsWith(`${entry.rootPath}/`) ||
                entry.rootPath.startsWith(`${root.path}/`))),
        ),
      )
    )
      throw new ApiError(
        409,
        "repository_group_owned",
        "A repository is already bound to another executor group",
      );
  const group: Group = {
    primaryEnvironmentId: primary.environmentId,
    hostId: primary.hostId,
    writerThreadId: null,
    roots: operations.map((entry) => ({
      environmentId: entry.environmentId,
      sourceEnvironmentId: entry.sourceEnvironmentId,
      operationId: entry.operationId,
      path: entry.rootPath,
      head: entry.head,
      branch: entry.branch,
    })),
  };
  saving.add(group);
  groups.set(group.primaryEnvironmentId, group);
  emptyRegistries.delete(deps.db);
  try {
    await save(deps, group);
  } catch (error) {
    groups.delete(group.primaryEnvironmentId);
    if (!groups.size) emptyRegistries.add(deps.db);
    throw error;
  } finally {
    saving.delete(group);
  }
}
export async function repositoryWorkspacePaths(
  deps: Deps,
  environmentId: string,
  threadId: string,
): Promise<string[]> {
  const group = (await registry(deps)).get(environmentId);
  if (!group) return [];
  if (saving.has(group))
    throw new ApiError(
      409,
      "repository_group_busy",
      "Repository ownership is being persisted; no executor may start yet",
    );
  if (group.writerThreadId && group.writerThreadId !== threadId)
    throw new ApiError(
      409,
      "repository_writer_conflict",
      "This repository group belongs to another writer",
    );
  for (const root of group.roots) {
    const environment = getEnvironment(deps.db, root.environmentId);
    if (
      !environment ||
      environment.hostId !== group.hostId ||
      environment.path !== root.path ||
      environment.status !== "ready" ||
      environment.retireAt !== null ||
      environment.teardownStatus !== null
    )
      throw new ApiError(
        409,
        "repository_not_ready",
        `Required bound workspace is not ready: ${root.environmentId}`,
      );
  }
  return group.roots.slice(1).map((root) => root.path);
}
export async function assertRepositoryGroupAdmission(
  deps: Deps,
  environmentId: string,
  threadId?: string,
): Promise<void> {
  const environment = getEnvironment(deps.db, environmentId);
  if (!environment) return;
  for (const group of (await registry(deps)).values()) {
    const target =
      group.hostId === environment.hostId &&
      group.roots.some((root) => root.path === environment.path);
    const source = group.roots.some((root) => {
      const original = getEnvironment(deps.db, root.sourceEnvironmentId);
      return (
        original?.hostId === environment.hostId &&
        original.path === environment.path
      );
    });
    if (!target && !source) continue;
    if (source) {
      const active = deps.db
        .select({ id: threads.id })
        .from(threads)
        .where(
          and(
            inArray(threads.environmentId, [group.primaryEnvironmentId]),
            inArray(threads.status, ["starting", "active", "stopping"]),
          ),
        )
        .limit(1)
        .get();
      if (active)
        throw new ApiError(
          409,
          "repository_source_active",
          "The coherent repository executor is active; source writers remain blocked",
        );
      continue;
    }
    if (
      environmentId !== group.primaryEnvironmentId ||
      !threadId ||
      (group.writerThreadId && group.writerThreadId !== threadId)
    )
      throw new ApiError(
        409,
        "repository_writer_conflict",
        "Bound repositories have one coherent writer; use the primary executor thread",
      );
    await repositoryWorkspacePaths(deps, group.primaryEnvironmentId, threadId);
    if (group.writerThreadId && group.writerThreadId !== threadId)
      throw new ApiError(
        409,
        "repository_writer_conflict",
        "Another writer claimed the repository group",
      );
    const sourceIds = group.roots.flatMap((root) => {
      const original = getEnvironment(deps.db, root.sourceEnvironmentId);
      return original?.path
        ? listEnvironments(deps.db, {
            hostId: original.hostId,
            path: original.path,
          }).map((entry) => entry.id)
        : [root.sourceEnvironmentId];
    });
    const sourceWriter = deps.db
      .select({ id: threads.id })
      .from(threads)
      .where(
        and(
          inArray(threads.environmentId, sourceIds),
          inArray(threads.status, ["starting", "active", "stopping"]),
        ),
      )
      .limit(1)
      .get();
    const sourceTerminal = deps.db
      .select({ id: terminalSessions.id })
      .from(terminalSessions)
      .where(
        and(
          inArray(terminalSessions.environmentId, sourceIds),
          inArray(terminalSessions.status, [
            "starting",
            "running",
            "disconnected",
          ]),
        ),
      )
      .limit(1)
      .get();
    if (sourceWriter || sourceTerminal)
      throw new ApiError(
        409,
        "repository_source_active",
        "Stop writers and terminals in every bound source before continuing the coherent executor",
      );
    if (!group.writerThreadId) {
      group.writerThreadId = threadId;
      saving.add(group);
      try {
        await save(deps, group);
      } catch (error) {
        group.writerThreadId = null;
        throw error;
      } finally {
        saving.delete(group);
      }
    }
  }
}
