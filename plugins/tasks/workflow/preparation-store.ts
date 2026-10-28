import { randomUUID } from "node:crypto";
import type { TasksApiStore } from "../api/index.js";
import {
  workflowDraftSchema, workflowPreparationSchema, workflowSelectionSchema,
  type WorkflowDraft, type WorkflowPreparation, type WorkflowSelection,
} from "../shared/workflow-preparation.js";

export const workflowPreparationMigration = `
CREATE TABLE task_workflow_drafts (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL, selection_json TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE task_workflow_settings (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  template TEXT NOT NULL, revision INTEGER NOT NULL, selection_json TEXT NOT NULL,
  PRIMARY KEY(project_id, template)
);
CREATE TABLE task_workflow_preparations (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  id TEXT NOT NULL UNIQUE, view_json TEXT NOT NULL
);
CREATE TABLE task_workflow_preparation_deliveries (
  preparation_id TEXT NOT NULL REFERENCES task_workflow_preparations(id) ON DELETE CASCADE,
  role TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(preparation_id, role)
);`;

export class WorkflowPreparationStore {
  constructor(readonly store: TasksApiStore) {}
  project(taskId: string) {
    const task = this.store.tasks.getTask(taskId);
    if (!task) throw new Error("Task no longer exists");
    const project = this.store.tasks.getProject(task.projectId);
    if (!project) throw new Error("Tracker project no longer exists");
    return project;
  }
  settings(taskId: string, template: WorkflowSelection["template"]) {
    const project = this.project(taskId);
    const row = this.store.database.prepare<[string, string], { revision: number; selection_json: string }>(
      "SELECT revision, selection_json FROM task_workflow_settings WHERE project_id = ? AND template = ?",
    ).get(project.id, template);
    return { revision: row?.revision ?? 0, selection: row ? workflowSelectionSchema.parse(JSON.parse(row.selection_json)) : null };
  }
  saveSettings(taskId: string, revision: number, selection: WorkflowSelection) {
    return this.store.transaction(() => {
      const project = this.project(taskId);
      const current = this.settings(taskId, selection.template);
      if (current.revision !== revision) throw new Error("Project workflow settings changed in another session; reload before saving");
      const parsed = workflowSelectionSchema.parse(selection);
      this.store.database.prepare(`INSERT INTO task_workflow_settings(project_id, template, revision, selection_json) VALUES (?, ?, ?, ?)
        ON CONFLICT(project_id, template) DO UPDATE SET revision = excluded.revision, selection_json = excluded.selection_json`).run(project.id, parsed.template, revision + 1, JSON.stringify(parsed));
      return { revision: revision + 1, selection: parsed };
    });
  }
  savedDraft(taskId: string): WorkflowDraft | null {
    this.project(taskId);
    const row = this.store.database.prepare<[string], { revision: number; selection_json: string; updated_at: string }>(
      "SELECT revision, selection_json, updated_at FROM task_workflow_drafts WHERE task_id = ?",
    ).get(taskId);
    return row ? workflowDraftSchema.parse({
      taskId, revision: row.revision, updatedAt: row.updated_at,
      selection: JSON.parse(row.selection_json),
    }) : null;
  }
  draft(taskId: string): WorkflowDraft {
    return this.savedDraft(taskId) ?? workflowDraftSchema.parse({
      taskId, revision: 0, updatedAt: "",
      selection: this.settings(taskId, "development-review").selection ?? {
        template: "development-review", hostId: null, baseBranch: "", writer: null, reviewer: null, smokeCommands: [], uiRequired: false,
      },
    });
  }
  saveDraft(taskId: string, revision: number, selection: WorkflowSelection): WorkflowDraft {
    return this.store.transaction(() => {
      const current = this.draft(taskId);
      const parsed = workflowSelectionSchema.parse(selection);
      if (current.revision !== revision) {
        if (JSON.stringify(current.selection) === JSON.stringify(parsed)) return current;
        throw new Error("Draft changed in another session; your choices are retained locally. Reload the saved draft or retry after reconciling");
      }
      const updatedAt = new Date().toISOString();
      this.store.database.prepare(`INSERT INTO task_workflow_drafts(task_id, revision, selection_json, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET revision = excluded.revision, selection_json = excluded.selection_json, updated_at = excluded.updated_at`).run(taskId, revision + 1, JSON.stringify(parsed), updatedAt);
      return { taskId, revision: revision + 1, selection: parsed, updatedAt };
    });
  }
  preparation(taskId: string): WorkflowPreparation | null {
    this.project(taskId);
    const row = this.store.database.prepare<[string], { view_json: string }>("SELECT view_json FROM task_workflow_preparations WHERE task_id = ?").get(taskId);
    return row ? workflowPreparationSchema.parse(JSON.parse(row.view_json)) : null;
  }
  savePreparation(view: WorkflowPreparation): WorkflowPreparation {
    const parsed = workflowPreparationSchema.parse(view);
    this.store.database.prepare("UPDATE task_workflow_preparations SET view_json = ? WHERE task_id = ? AND id = ?").run(JSON.stringify(parsed), parsed.taskId, parsed.id);
    return parsed;
  }
  reserve(taskId: string, projectId: string, selection: WorkflowSelection): WorkflowPreparation {
    const existing = this.preparation(taskId);
    if (existing) return existing;
    const view: WorkflowPreparation = {
      id: `twp_${randomUUID()}`, taskId, projectId, selection, state: "reserved", threadId: null,
      environmentId: null, reviewerThreadId: null, error: null, progress: "Workspace preparation reserved; no agent has started", workspacePath: null, branch: null, head: null,
    };
    this.store.database.prepare("INSERT INTO task_workflow_preparations(task_id, id, view_json) VALUES (?, ?, ?)").run(taskId, view.id, JSON.stringify(view));
    return view;
  }
}
