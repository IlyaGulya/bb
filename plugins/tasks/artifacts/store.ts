import type { TasksApiStore } from "../api/index.js";
import { taskArtifactSchema, type TaskArtifact } from "../shared/artifacts.js";

export const taskArtifactMigration = `
  CREATE TABLE task_artifacts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    bb_project_id TEXT NOT NULL,
    execution_context_id TEXT NOT NULL,
    image_attachment_id TEXT REFERENCES attachments(id) ON DELETE NO ACTION,
    artifact_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX task_artifacts_scope ON task_artifacts(task_id, execution_context_id, created_at, id);
  CREATE INDEX task_artifacts_image ON task_artifacts(image_attachment_id);
`;

type ArtifactRow = { artifact_json: string };
type ImageScopeRow = { attachmentId: string; executionContextId: string; bbProjectId: string };

export class TaskArtifactStore {
  constructor(private readonly store: Pick<TasksApiStore, "database">) {}

  get(id: string): TaskArtifact | null {
    const row = this.store.database.prepare<[string], ArtifactRow>(
      "SELECT artifact_json FROM task_artifacts WHERE id = ?",
    ).get(id);
    return row ? taskArtifactSchema.parse(JSON.parse(row.artifact_json)) : null;
  }

  list(taskId: string, contextId: string, projectIds: readonly string[]): TaskArtifact[] {
    if (projectIds.length === 0) return [];
    const placeholders = projectIds.map(() => "?").join(", ");
    return this.store.database.prepare<string[], ArtifactRow>(
      `SELECT artifact_json FROM task_artifacts WHERE task_id = ? AND execution_context_id = ? AND bb_project_id IN (${placeholders}) ORDER BY created_at, id`,
    ).all(taskId, contextId, ...projectIds).map(row => taskArtifactSchema.parse(JSON.parse(row.artifact_json)));
  }

  forImage(attachmentId: string): TaskArtifact[] {
    return this.store.database.prepare<[string], ArtifactRow>(
      "SELECT artifact_json FROM task_artifacts WHERE image_attachment_id = ? ORDER BY created_at, id",
    ).all(attachmentId).map(row => taskArtifactSchema.parse(JSON.parse(row.artifact_json)));
  }

  imageScopes(attachmentIds: readonly string[]): ImageScopeRow[] {
    const scopes: ImageScopeRow[] = [];
    for (let offset = 0; offset < attachmentIds.length; offset += 500) {
      const batch = attachmentIds.slice(offset, offset + 500);
      const placeholders = batch.map(() => "?").join(", ");
      scopes.push(...this.store.database.prepare<string[], ImageScopeRow>(
        `SELECT image_attachment_id AS attachmentId, execution_context_id AS executionContextId, bb_project_id AS bbProjectId FROM task_artifacts WHERE image_attachment_id IN (${placeholders})`,
      ).all(...batch));
    }
    return scopes;
  }

  create(artifact: TaskArtifact): TaskArtifact {
    this.store.database.prepare(
      "INSERT INTO task_artifacts(id, task_id, bb_project_id, execution_context_id, image_attachment_id, artifact_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(artifact.id, artifact.taskId, artifact.bbProjectId, artifact.executionContextId,
      artifact.annotation?.image.attachmentId ?? null, JSON.stringify(artifact), artifact.createdAt);
    return artifact;
  }

  delete(id: string): boolean {
    return this.store.database.prepare("DELETE FROM task_artifacts WHERE id = ?").run(id).changes > 0;
  }
}
