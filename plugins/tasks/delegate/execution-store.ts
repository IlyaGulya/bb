import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  executionTargetSchema,
  taskContinuationSchema,
  type ExecutionTarget,
  type TaskContinuation,
} from "../shared/execution";

const continuationRequestSchema = z
  .object({
    includePaths: z.array(z.string()),
    branch: z.string().optional(),
    extraInstructions: z.string().optional(),
    executionContextId: z.string().trim().min(1).optional(),
    modelConnectionId: z.string().trim().min(1).optional(),
  })
  .strict();
type ContinuationRequest = z.infer<typeof continuationRequestSchema>;
type Database = ReturnType<BbPluginApi["storage"]["database"]>;
interface ContinuationRow {
  operation_id: string;
  task_id: string;
  source_thread_id: string;
  bb_project_id: string;
  source_environment_id: string;
  target_host_id: string;
  target_path: string;
  preset_id: string;
  environment_id: string;
  state: TaskContinuation["state"];
  thread_id: string | null;
  last_error: string | null;
  request_json: string;
  handoff: string;
  created_at: string;
}
export interface StoredContinuation {
  receipt: TaskContinuation;
  request: ContinuationRequest;
  handoff: string;
}
function continuation(row: ContinuationRow): StoredContinuation {
  return {
    receipt: taskContinuationSchema.parse({
      operationId: row.operation_id,
      taskId: row.task_id,
      sourceThreadId: row.source_thread_id,
      bbProjectId: row.bb_project_id,
      sourceEnvironmentId: row.source_environment_id,
      targetHostId: row.target_host_id,
      targetPath: row.target_path,
      presetId: row.preset_id,
      environmentId: row.environment_id,
      state: row.state,
      threadId: row.thread_id,
      lastError: row.last_error,
      createdAt: row.created_at,
    }),
    request: continuationRequestSchema.parse(JSON.parse(row.request_json)),
    handoff: row.handoff,
  };
}
export class ExecutionStore {
  constructor(private readonly db: Database) {}
  target(taskId: string): ExecutionTarget | null {
    const row = this.db
      .prepare<[string], { target_json: string }>(
        "SELECT target_json FROM task_execution_targets WHERE task_id = ?",
      )
      .get(taskId);
    return row
      ? executionTargetSchema.parse(JSON.parse(row.target_json))
      : null;
  }
  setTarget(taskId: string, target: ExecutionTarget | null): void {
    if (target === null) {
      this.db
        .prepare<[string]>(
          "DELETE FROM task_execution_targets WHERE task_id = ?",
        )
        .run(taskId);
    } else {
      this.db
        .prepare<[string, string]>(
          "INSERT INTO task_execution_targets(task_id, target_json) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET target_json = excluded.target_json",
        )
        .run(taskId, JSON.stringify(executionTargetSchema.parse(target)));
    }
  }
  list(taskId: string): StoredContinuation[] {
    return this.db
      .prepare<[string], ContinuationRow>(
        "SELECT * FROM task_continuations WHERE task_id = ? ORDER BY created_at, operation_id",
      )
      .all(taskId)
      .map(continuation);
  }
  get(operationId: string): StoredContinuation | null {
    const row = this.db
      .prepare<[string], ContinuationRow>(
        "SELECT * FROM task_continuations WHERE operation_id = ?",
      )
      .get(operationId);
    return row ? continuation(row) : null;
  }
  pending(taskId: string): StoredContinuation | null {
    const row = this.db
      .prepare<[string], ContinuationRow>(
        "SELECT * FROM task_continuations WHERE task_id = ? AND state IN ('ready', 'spawning') LIMIT 1",
      )
      .get(taskId);
    return row ? continuation(row) : null;
  }
  hasStartedSource(taskId: string, threadId: string): boolean {
    return Boolean(
      this.db
        .prepare<[string, string], { found: number }>(
          "SELECT 1 AS found FROM task_continuations WHERE task_id = ? AND source_thread_id = ? AND state = 'started' LIMIT 1",
        )
        .get(taskId, threadId),
    );
  }
  create(input: StoredContinuation): void {
    const receipt = taskContinuationSchema.parse(input.receipt);
    this.db
      .prepare<
        [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string | null,
          string | null,
          string,
          string,
          string,
        ]
      >(
        `INSERT INTO task_continuations(operation_id, task_id, source_thread_id, bb_project_id,
        source_environment_id, target_host_id, target_path, preset_id, environment_id,
        state, thread_id, last_error, request_json, handoff, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.operationId,
        receipt.taskId,
        receipt.sourceThreadId,
        receipt.bbProjectId,
        receipt.sourceEnvironmentId,
        receipt.targetHostId,
        receipt.targetPath,
        receipt.presetId,
        receipt.environmentId,
        receipt.state,
        receipt.threadId,
        receipt.lastError,
        JSON.stringify(continuationRequestSchema.parse(input.request)),
        input.handoff,
        receipt.createdAt,
      );
  }
  state(
    operationId: string,
    state: TaskContinuation["state"],
    threadId: string | null,
    lastError: string | null,
  ): void {
    this.db
      .prepare<
        [TaskContinuation["state"], string | null, string | null, string]
      >(
        "UPDATE task_continuations SET state = ?, thread_id = ?, last_error = ? WHERE operation_id = ?",
      )
      .run(state, threadId, lastError, operationId);
  }
}
