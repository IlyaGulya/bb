import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { TasksApiStore } from "../api/index.js";
import {
  taskWorkflowSchema,
  type TaskWorkflow,
} from "../shared/workflow-contract.js";
import {
  buildReviewStartSchema,
  assertBuildEvidencePolicy,
  type BuildReviewStart,
  uiEvidenceSchema,
  type BuildReviewResult,
} from "../../workflows/src/build-review-contract.js";

export const taskWorkflowMigration = `CREATE TABLE task_workflow_runs (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  launch_key TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL, state TEXT NOT NULL,
  request_json TEXT NOT NULL, launch_json TEXT NOT NULL, view_json TEXT NOT NULL,
  published_revision INTEGER NOT NULL DEFAULT 0, released INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX task_workflow_task ON task_workflow_runs(task_id);
CREATE UNIQUE INDEX task_workflow_active ON task_workflow_runs(task_id) WHERE state <> 'accepted';`;

export function assertTaskWorkflowExecutionAvailable(store: TasksApiStore, taskId: string): void {
  const owner = store.database.prepare<[string], { id: string }>(
    "SELECT id FROM task_workflow_runs WHERE task_id = ? AND state <> 'accepted' AND released <> 1 LIMIT 1",
  ).get(taskId);
  if (owner) throw new Error(`Task is owned by workflow ${owner.id}; use its retained Return or complete explicit acceptance/release before independent execution`);
}

export const taskWorkflowVideoLineageMigration = `
ALTER TABLE task_workflow_runs ADD COLUMN video_lineage_json TEXT NOT NULL DEFAULT '[]';
UPDATE task_workflow_runs SET video_lineage_json = (
  SELECT COALESCE(json_group_array(json_object(
    'attachmentId', json_extract(evidence.value, '$.attachmentId'),
    'recording', json(json_extract(evidence.value, '$.recording'))
  )), '[]')
  FROM json_each(task_workflow_runs.view_json, '$.native.result.build.uiEvidence') AS evidence
  WHERE json_extract(evidence.value, '$.kind') = 'video'
)
WHERE published_revision = revision AND state IN ('in_review', 'accepted')
  AND json_type(view_json, '$.native.result.build.uiEvidence') = 'array';`;

export const taskWorkflowUnverifiableVideoOriginsMigration = `
UPDATE task_workflow_runs SET video_lineage_json = (
  SELECT COALESCE(json_group_array(json(entry)), '[]') FROM (
    SELECT value AS entry FROM json_each(task_workflow_runs.video_lineage_json)
    UNION ALL
    SELECT json_object('attachmentId', attachment.id, 'recording', NULL) AS entry
    FROM attachments AS attachment
    WHERE (
      attachment.task_id = task_workflow_runs.task_id
      OR attachment.comment_id IN (SELECT id FROM comments WHERE task_id = task_workflow_runs.task_id)
    ) AND NOT EXISTS (
      SELECT 1 FROM task_workflow_runs AS known JOIN json_each(known.video_lineage_json) AS lineage
      WHERE known.task_id = task_workflow_runs.task_id
        AND (json_extract(lineage.value, '$.attachmentId') = attachment.id
          OR json_extract(lineage.value, '$.recording.sourceAttachmentId') = attachment.id)
    )
  )
)
WHERE published_revision > 0 AND revision > 1;`;

const videoLineageSchema = uiEvidenceSchema.options[2].pick({ attachmentId: true, recording: true });
const videoLineagesSchema = z.array(videoLineageSchema.extend({ recording: videoLineageSchema.shape.recording.nullable() }));
type RecordingClaim = z.infer<typeof videoLineageSchema>["recording"];

function assertSameRecordingRun(previous: RecordingClaim, next: RecordingClaim): void {
  if (previous.commit !== next.commit || previous.runId !== next.runId)
    throw new Error("Recording attachment has different persisted commit or run lineage");
}

function assertSameRecordingOriginal(previous: RecordingClaim, next: RecordingClaim): void {
  if (previous.sourceAttachmentId !== next.sourceAttachmentId || previous.transformation !== next.transformation)
    throw new Error("Original attachment or editing disclosure differs from persisted recording lineage");
}

export class TaskWorkflowStore {
  constructor(readonly store: TasksApiStore) {}
  assertRecordingLineage(taskId: string, build: BuildReviewResult["build"]): void {
    if (!build.uiEvidence.some(evidence => evidence.kind === "video")) return;
    const versions = new Map<string, RecordingClaim>();
    const originals = new Map<string, RecordingClaim>();
    const recorded = this.store.database.prepare<[string, string, string, string, string], { attachment_id: string; recording_json: string | null }>(`
      SELECT json_extract(lineage.value, '$.attachmentId') AS attachment_id,
        json_extract(lineage.value, '$.recording') AS recording_json
      FROM task_workflow_runs AS workflow JOIN json_each(workflow.video_lineage_json) AS lineage
      WHERE workflow.task_id = ? AND (
        json_extract(lineage.value, '$.attachmentId') IN (?, ?)
        OR json_extract(lineage.value, '$.recording.sourceAttachmentId') IN (?, ?)
      )
    `);
    for (const evidence of build.uiEvidence) {
      if (evidence.kind !== "video") continue;
      const { attachmentId, recording } = evidence;
      for (const id of [attachmentId, recording.sourceAttachmentId]) {
        const previous = versions.get(id);
        if (previous) assertSameRecordingRun(previous, recording);
        else versions.set(id, recording);
      }
      const previousOriginal = originals.get(attachmentId);
      if (previousOriginal) assertSameRecordingOriginal(previousOriginal, recording);
      else originals.set(attachmentId, recording);
      for (const row of recorded.iterate(taskId, attachmentId, recording.sourceAttachmentId, attachmentId, recording.sourceAttachmentId)) {
        if (row.recording_json === null)
          throw new Error("Recording origin is unverifiable after a pre-upgrade Return. Keep the historical result and attach a fresh recording instead of relabelling an old attachment.");
        const previous = videoLineageSchema.shape.recording.parse(JSON.parse(row.recording_json));
        assertSameRecordingRun(previous, recording);
        if (row.attachment_id === attachmentId) assertSameRecordingOriginal(previous, recording);
      }
    }
  }
  private rememberRecordingLineage(id: string, build: BuildReviewResult["build"]): void {
    if (!build.uiEvidence.some(evidence => evidence.kind === "video")) return;
    const row = this.store.database.prepare<[string], { video_lineage_json: string }>(
      "SELECT video_lineage_json FROM task_workflow_runs WHERE id = ?",
    ).get(id);
    if (!row) throw new Error("Unknown task workflow");
    const lineage = videoLineagesSchema.parse(JSON.parse(row.video_lineage_json));
    const known = new Set(lineage.map(evidence => evidence.attachmentId));
    let changed = false;
    for (const evidence of build.uiEvidence) {
      if (evidence.kind !== "video" || known.has(evidence.attachmentId)) continue;
      lineage.push({ attachmentId: evidence.attachmentId, recording: evidence.recording });
      known.add(evidence.attachmentId);
      changed = true;
    }
    if (changed) this.store.database.prepare(
      "UPDATE task_workflow_runs SET video_lineage_json = ? WHERE id = ?",
    ).run(JSON.stringify(lineage), id);
  }
  get(id: string): TaskWorkflow {
    const row = this.store.database
      .prepare<[string], { view_json: string }>(
        "SELECT view_json FROM task_workflow_runs WHERE id = ?",
      )
      .get(id);
    if (!row) throw new Error("Unknown task workflow");
    return taskWorkflowSchema.parse(JSON.parse(row.view_json));
  }
  request(id: string): BuildReviewStart {
    const row = this.store.database
      .prepare<[string], { request_json: string }>(
        "SELECT request_json FROM task_workflow_runs WHERE id = ?",
      )
      .get(id);
    if (!row) throw new Error("Unknown task workflow");
    return buildReviewStartSchema.parse(JSON.parse(row.request_json));
  }
  save(view: TaskWorkflow): TaskWorkflow {
    const parsed = taskWorkflowSchema.parse({
      ...view,
      updatedAt: new Date().toISOString(),
    });
    this.store.database
      .prepare(
        "UPDATE task_workflow_runs SET revision = ?, state = ?, view_json = ? WHERE id = ?",
      )
      .run(parsed.revision, parsed.state, JSON.stringify(parsed), parsed.id);
    return parsed;
  }
  create(
    launchKey: string,
    taskId: string,
    request: BuildReviewStart,
    launchJson: string,
  ): TaskWorkflow {
    const now = new Date().toISOString();
    const view: TaskWorkflow = {
      id: request.group,
      taskId,
      revision: 1,
      state: "launching",
      native: null,
      error: null,
      feedback: "",
      createdAt: now,
      updatedAt: now,
    };
    this.store.database
      .prepare(
        "INSERT INTO task_workflow_runs(id, task_id, launch_key, revision, state, request_json, launch_json, view_json) VALUES (?, ?, ?, 1, 'launching', ?, ?, ?)",
      )
      .run(
        view.id,
        taskId,
        launchKey,
        JSON.stringify(request),
        launchJson,
        JSON.stringify(view),
      );
    return view;
  }
  publish(
    id: string,
    native: NonNullable<TaskWorkflow["native"]>,
  ): TaskWorkflow {
    return this.store.transaction(() => {
      const view = this.get(id);
      if (view.state === "accepted") return view;
      const request = this.request(id);
      if (native.key !== request.key) return view;
      if (native.status !== "succeeded")
        return this.save({
          ...view,
          native,
          state: ["failed", "cancelled"].includes(native.status)
            ? "failed"
            : "running",
          error: native.error,
        });
      if (!native.result)
        throw new Error("Completed workflow has no result package");
      assertBuildEvidencePolicy(request, native.result.build);
      this.assertRecordingLineage(view.taskId, native.result.build);
      this.rememberRecordingLineage(id, native.result.build);
      const claimed = this.store.database
        .prepare(
          "UPDATE task_workflow_runs SET published_revision = ? WHERE id = ? AND published_revision < ?",
        )
        .run(view.revision, id, view.revision).changes;
      if (claimed) {
        const task = this.store.tasks.getTask(view.taskId);
        if (!task || ["done", "canceled"].includes(task.status))
          throw new Error(
            "Task was closed outside this workflow; result retained without reopening it",
          );
        this.store.tasks.createComment({
          taskId: view.taskId,
          kind: "agent",
          authorName: "Build → review",
          threadId:
            native.workers.find((worker) => worker.role === "writer")
              ?.threadId ?? null,
          body: `Workflow ${native.runId}, revision ${view.revision}. Independent review: ${native.result.review.verdict}. Human Accept or Return required.\n\n${JSON.stringify(native.result, null, 2)}\n\nPolicy limitations:\n${native.policyLimitations.join("\n")}`,
        });
        this.store.tasks.updateTask(view.taskId, { status: "in_review" });
      }
      return this.save({ ...view, native, state: "in_review", error: null });
    });
  }
  accept(id: string, revision: number): TaskWorkflow {
    return this.store.transaction(() => {
      const view = this.get(id);
      if (view.revision !== revision)
        throw new Error("Stale workflow revision");
      if (view.state === "accepted") return view;
      if (view.state !== "in_review")
        throw new Error("Only a published result can be accepted");
      if (view.native?.result) this.assertRecordingLineage(view.taskId, view.native.result.build);
      this.store.tasks.updateTask(view.taskId, { status: "done" });
      this.store.tasks.createComment({
        taskId: view.taskId,
        kind: "system",
        authorName: "Human review",
        body: `Accepted workflow ${view.id} revision ${revision}.`,
      });
      return this.save({ ...view, state: "accepted" });
    });
  }
  return(
    id: string,
    revision: number,
    feedback: string,
    retryProfiles?: Pick<BuildReviewStart, "writer" | "reviewer">,
  ): TaskWorkflow {
    return this.store.transaction(() => {
      const view = this.get(id);
      if (view.revision === revision + 1 && view.feedback === feedback)
        return view;
      if (view.revision !== revision)
        throw new Error("Stale workflow revision");
      if (!["in_review", "failed"].includes(view.state))
        throw new Error("Only a completed or failed workflow can be returned");
      const request = this.request(id);
      if (retryProfiles && view.native?.contextStarted !== false)
        throw new Error(
          "Cannot replace an existing or uncertain writer context",
        );
      const next = {
        ...request,
        ...retryProfiles,
        key: `${id}:${revision + 1}`,
        feedback,
      };
      this.store.database
        .prepare("UPDATE task_workflow_runs SET request_json = ? WHERE id = ?")
        .run(JSON.stringify(next), id);
      this.store.tasks.updateTask(view.taskId, { status: "in_progress" });
      this.store.tasks.createComment({
        taskId: view.taskId,
        kind: "system",
        authorName: "Human review",
        body: `Returned workflow ${id} revision ${revision} ${view.native?.contextStarted === false ? "for its first writer launch; no writer session existed" : "to the same writer/context"}.\n\n${feedback}`,
      });
      return this.save({
        ...view,
        revision: revision + 1,
        state: "launching",
        error: null,
        native: null,
        feedback,
      });
    });
  }
}
export const newTaskWorkflowId = () => `twf_${randomUUID()}`;
