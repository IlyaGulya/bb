import type { TasksApiStore } from "../api";
import {
  repositoryCheckpointSchema,
  type RepositoryCheckpoint,
} from "../shared/repositories";

export const repositoryMigrations = [
  `CREATE TABLE task_repository_checkpoints (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, state TEXT NOT NULL, checkpoint_json TEXT NOT NULL)`,
  `CREATE INDEX task_repository_checkpoints_task ON task_repository_checkpoints(task_id)`,
  `CREATE TABLE task_repository_claims (host_id TEXT NOT NULL, path TEXT NOT NULL, checkpoint_id TEXT NOT NULL REFERENCES task_repository_checkpoints(id) ON DELETE CASCADE, PRIMARY KEY(host_id, path))`,
] as const;

export class RepositoryStore {
  constructor(private readonly store: TasksApiStore) {}
  list(taskId: string): RepositoryCheckpoint[] {
    return this.store.database
      .prepare<[string], { checkpoint_json: string }>(
        "SELECT checkpoint_json FROM task_repository_checkpoints WHERE task_id = ? ORDER BY rowid DESC",
      )
      .all(taskId)
      .map((row) =>
        repositoryCheckpointSchema.parse(JSON.parse(row.checkpoint_json)),
      );
  }
  preparing(): RepositoryCheckpoint[] {
    return this.store.database
      .prepare<[], { checkpoint_json: string }>(
        "SELECT checkpoint_json FROM task_repository_checkpoints WHERE state = 'preparing' ORDER BY rowid",
      )
      .all()
      .map((row) =>
        repositoryCheckpointSchema.parse(JSON.parse(row.checkpoint_json)),
      );
  }
  get(id: string): RepositoryCheckpoint {
    const row = this.store.database
      .prepare<[string], { checkpoint_json: string }>(
        "SELECT checkpoint_json FROM task_repository_checkpoints WHERE id = ?",
      )
      .get(id);
    if (!row) throw new Error("Repository checkpoint not found");
    return repositoryCheckpointSchema.parse(JSON.parse(row.checkpoint_json));
  }
  save(checkpoint: RepositoryCheckpoint): void {
    checkpoint.updatedAt = new Date().toISOString();
    this.store.database
      .prepare(
        "UPDATE task_repository_checkpoints SET state = ?, checkpoint_json = ? WHERE id = ?",
      )
      .run(
        checkpoint.state,
        JSON.stringify(repositoryCheckpointSchema.parse(checkpoint)),
        checkpoint.id,
      );
  }
  create(checkpoint: RepositoryCheckpoint): void {
    this.store.transaction(() => {
      const existing = this.store.database
        .prepare<[string], { id: string }>(
          "SELECT id FROM task_repository_checkpoints WHERE task_id = ? LIMIT 1",
        )
        .get(checkpoint.taskId);
      if (existing)
        throw new Error(
          `Task already has repository checkpoint ${existing.id}; inspect and continue it rather than creating duplicate writers`,
        );
      this.store.database
        .prepare(
          "INSERT INTO task_repository_checkpoints(id, task_id, state, checkpoint_json) VALUES (?, ?, ?, ?)",
        )
        .run(
          checkpoint.id,
          checkpoint.taskId,
          checkpoint.state,
          JSON.stringify(repositoryCheckpointSchema.parse(checkpoint)),
        );
      for (const { binding } of checkpoint.roots) {
        for (const [host, path] of [
          [binding.sourceHostId, binding.sourcePath],
          [binding.targetHostId, binding.targetPath],
        ]) {
          const conflict = this.store.database.prepare<
            [string, string, string, string, string],
            { checkpoint_id: string }
          >(
            "SELECT checkpoint_id FROM task_repository_claims WHERE host_id = ? AND (path = ? OR substr(path, 1, length(?) + 1) = ? || '/' OR substr(?, 1, length(path) + 1) = path || '/') LIMIT 1",
          );
          const owner = conflict.get(host!, path!, path!, path!, path!);
          if (owner && owner.checkpoint_id !== checkpoint.id)
            throw new Error(
              `Repository root is owned by checkpoint ${owner.checkpoint_id}`,
            );
          this.store.database
            .prepare(
              "INSERT OR IGNORE INTO task_repository_claims(host_id, path, checkpoint_id) VALUES (?, ?, ?)",
            )
            .run(host, path, checkpoint.id);
        }
      }
    });
  }
  reserveRetry(checkpoint: RepositoryCheckpoint): void {
    this.store.transaction(() => {
      for (const { binding, state } of checkpoint.roots) {
        if (state !== "pending") continue;
        const owner = this.store.database
          .prepare<
            [string, string, string, string, string],
            { checkpoint_id: string }
          >(
            "SELECT checkpoint_id FROM task_repository_claims WHERE host_id = ? AND (path = ? OR substr(path, 1, length(?) + 1) = ? || '/' OR substr(?, 1, length(path) + 1) = path || '/') LIMIT 1",
          )
          .get(
            binding.targetHostId,
            binding.targetPath,
            binding.targetPath,
            binding.targetPath,
            binding.targetPath,
          );
        if (owner)
          throw new Error(
            `Repository root is owned by checkpoint ${owner.checkpoint_id}`,
          );
        this.store.database
          .prepare(
            "INSERT OR IGNORE INTO task_repository_claims(host_id, path, checkpoint_id) VALUES (?, ?, ?)",
          )
          .run(binding.targetHostId, binding.targetPath, checkpoint.id);
      }
      this.save(checkpoint);
    });
  }
  assertSingleRootAllowed(taskId: string): void {
    if (this.list(taskId).length)
      throw new Error(
        "This task has an explicit multi-repository checkpoint. Use its repository continuation, not single-root dispatch.",
      );
  }
}
