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

export class TaskArtifactStore {
  constructor(private readonly store: TasksApiStore) {}

  get(id: string): TaskArtifact | null {
    const row = this.store.database.prepare<[string], ArtifactRow>(
      "SELECT artifact_json FROM task_artifacts WHERE id = ?",
    ).get(id);
    return row ? taskArtifactSchema.parse(JSON.parse(row.artifact_json)) : null;
  }

  list(taskId: string, contextId: string, bbProjectId: string): TaskArtifact[] {
    return this.store.database.prepare<[string, string, string], ArtifactRow>(
      "SELECT artifact_json FROM task_artifacts WHERE task_id = ? AND execution_context_id = ? AND bb_project_id = ? ORDER BY created_at, id",
    ).all(taskId, contextId, bbProjectId).map(row => taskArtifactSchema.parse(JSON.parse(row.artifact_json)));
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
