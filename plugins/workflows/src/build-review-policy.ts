import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { Db, WorkflowCallRow, WorkflowRunRow } from "./data.js";
import {
  buildReviewStartSchema,
  type BuildReviewStart,
} from "./build-review-contract.js";

export const buildReviewMigration = `CREATE TABLE workflow_build_reviews (
  request_key TEXT PRIMARY KEY, group_key TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE REFERENCES workflow_runs(id) ON DELETE CASCADE,
  request_json TEXT NOT NULL, released INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX workflow_build_reviews_group ON workflow_build_reviews(group_key);
CREATE TABLE workflow_build_review_workers (
  group_key TEXT NOT NULL, role TEXT NOT NULL, thread_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY(group_key, role)
);
CREATE TABLE workflow_build_review_deliveries (
  call_id TEXT PRIMARY KEY REFERENCES workflow_calls(id) ON DELETE CASCADE, thread_id TEXT, state TEXT NOT NULL
);`;

export function managedRequest(db: Db, runId: string): BuildReviewStart | null {
  const row = db
    .prepare<[string], { request_json: string }>(
      "SELECT request_json FROM workflow_build_reviews WHERE run_id = ?",
    )
    .get(runId);
  return row
    ? buildReviewStartSchema.parse(JSON.parse(row.request_json))
    : null;
}
export function managedRunId(db: Db, key: string): string | null {
  return (
    db
      .prepare<[string], { run_id: string }>(
        "SELECT run_id FROM workflow_build_reviews WHERE request_key = ?",
      )
      .get(key)?.run_id ?? null
  );
}
export function managedRole(index: number): "writer" | "reviewer" {
  if (index < 0 || index > 2)
    throw new Error(
      "Build/review permits only plan, writer/smoke and independent review calls",
    );
  return index === 2 ? "reviewer" : "writer";
}
export function managedProfile(db: Db, runId: string, index: number) {
  const request = managedRequest(db, runId);
  return request === null ? null : request[managedRole(index)];
}

export function managedContextStarted(db: Db, group: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM workflow_build_review_workers WHERE group_key = ?
    UNION ALL SELECT 1 FROM workflow_build_review_deliveries d
      JOIN workflow_calls c ON c.id = d.call_id JOIN workflow_build_reviews r ON r.run_id = c.run_id
      WHERE r.group_key = ? AND d.state <> 'rejected' LIMIT 1`)
    .get(group, group);
}

export async function managedWorker(
  bb: BbPluginApi,
  db: Db,
  run: WorkflowRunRow,
  call: WorkflowCallRow,
  prompt: string,
  spawn: () => Promise<{ id: string }>,
): Promise<{ id: string } | null> {
  const request = managedRequest(db, run.id);
  if (!request) return null;
  const role = managedRole(call.callIndex);
  const previous = db
    .prepare<[string], { thread_id: string | null; state: string }>(
      "SELECT thread_id, state FROM workflow_build_review_deliveries WHERE call_id = ?",
    )
    .get(call.id);
  if (previous?.thread_id) {
    if (previous.state === "sending")
      throw new Error(
        "Writer continuation delivery is uncertain after interruption; no duplicate message was sent. Inspect the retained writer before returning with explicit feedback.",
      );
    return { id: previous.thread_id };
  }
  if (previous) {
    for (let offset = 0; ; offset += 100) {
      const threads = await bb.sdk.threads.list({
        originPluginId: bb.pluginId,
        includeHidden: true,
        limit: 100,
        offset,
      });
      for (const thread of threads) {
        const metadata = z
          .object({ callId: z.string() })
          .safeParse(
            await bb.sdk.threads.getPluginMetadata({ threadId: thread.id }),
          );
        if (metadata.success && metadata.data.callId === call.id) {
          save(thread.id);
          return { id: thread.id };
        }
      }
      if (threads.length < 100) break;
    }
    throw new Error(
      "Worker launch outcome is uncertain after interruption; refusing to create a duplicate writer. Inspect native threads and retry only after resolving the launch.",
    );
  }
  let session = db
    .prepare<[string, string], { thread_id: string }>(
      "SELECT thread_id FROM workflow_build_review_workers WHERE group_key = ? AND role = ?",
    )
    .get(request.group, role);
  if (!session) {
    const uncertain = new Set(
      db
        .prepare<
          [string, string],
          { call_id: string }
        >(`SELECT d.call_id FROM workflow_build_review_deliveries d
      JOIN workflow_calls c ON c.id = d.call_id JOIN workflow_build_reviews r ON r.run_id = c.run_id
      WHERE r.group_key = ? AND d.state = 'spawning'
        AND CASE WHEN c.call_index = 2 THEN 'reviewer' ELSE 'writer' END = ?`)
        .all(request.group, role)
        .map((row) => row.call_id),
    );
    if (uncertain.size > 0) {
      for (let offset = 0; !session; offset += 100) {
        const threads = await bb.sdk.threads.list({
          originPluginId: bb.pluginId,
          includeHidden: true,
          limit: 100,
          offset,
        });
        for (const thread of threads) {
          const metadata = z
            .object({ callId: z.string() })
            .safeParse(
              await bb.sdk.threads.getPluginMetadata({ threadId: thread.id }),
            );
          if (metadata.success && uncertain.has(metadata.data.callId)) {
            session = { thread_id: thread.id };
            db.prepare(
              "INSERT INTO workflow_build_review_workers(group_key, role, thread_id) VALUES (?, ?, ?)",
            ).run(request.group, role, thread.id);
            db.prepare(
              "UPDATE workflow_build_review_deliveries SET thread_id = ?, state = 'sent' WHERE call_id = ?",
            ).run(thread.id, metadata.data.callId);
            break;
          }
        }
        if (threads.length < 100) break;
      }
      if (!session)
        throw new Error(
          "An earlier writer launch remains uncertain; Return cannot create a replacement session. Resolve that native launch first.",
        );
    }
  }
  db.prepare(
    "INSERT INTO workflow_build_review_deliveries(call_id, thread_id, state) VALUES (?, ?, ?)",
  ).run(call.id, session?.thread_id ?? null, session ? "sending" : "spawning");
  if (!session) {
    try {
      const child = await spawn();
      save(child.id);
      return child;
    } catch (error) {
      const rejection = z
        .object({
          status: z.union([
            z.literal(400),
            z.literal(401),
            z.literal(403),
            z.literal(404),
            z.literal(409),
            z.literal(422),
          ]),
          code: z.string().min(1),
        })
        .safeParse(error);
      if (rejection.success)
        db.prepare(
          "UPDATE workflow_build_review_deliveries SET state = 'rejected' WHERE call_id = ? AND thread_id IS NULL",
        ).run(call.id);
      throw error;
    }
  }
  const thread = await bb.sdk.threads.get({ threadId: session.thread_id });
  if (
    thread.archivedAt != null ||
    thread.deletedAt != null ||
    !["idle", "error"].includes(thread.status)
  ) {
    throw new Error(
      "Retained workflow worker is busy or unavailable; restore the same worker before continuing (a replacement session is not permitted)",
    );
  }
  if (thread.environmentId !== run.environmentId)
    throw new Error("Retained writer workspace changed");
  const execution = await bb.sdk.threads.defaultExecutionOptions({
    threadId: thread.id,
  });
  if (
    !execution ||
    execution.model !== call.resolvedModel ||
    execution.reasoningLevel !== call.resolvedReasoningLevel ||
    execution.permissionMode !== call.resolvedPermissionMode ||
    (request[role].serviceTier !== null &&
      execution.serviceTier !== request[role].serviceTier)
  )
    throw new Error(
      "Retained worker execution profile changed; restore its original profile rather than replacing the provider session",
    );
  db.transaction(() => {
    db.prepare(
      "UPDATE workflow_calls SET child_thread_id = NULL WHERE child_thread_id = ?",
    ).run(thread.id);
    db.prepare(
      "UPDATE workflow_calls SET child_thread_id = ?, status = 'running' WHERE id = ?",
    ).run(thread.id, call.id);
    db.prepare(
      "UPDATE workflow_workers SET run_id = ?, call_id = ? WHERE thread_id = ?",
    ).run(run.id, call.id, thread.id);
  })();
  await bb.sdk.threads.send({
    threadId: thread.id,
    mode: "steer-if-active",
    input: [{ type: "text", text: prompt, mentions: [] }],
  });
  save(thread.id);
  return { id: thread.id };

  function save(threadId: string) {
    db.transaction(() => {
      db.prepare(
        "UPDATE workflow_build_review_deliveries SET thread_id = ?, state = 'sent' WHERE call_id = ?",
      ).run(threadId, call.id);
      db.prepare(
        "INSERT INTO workflow_build_review_workers(group_key, role, thread_id) VALUES (?, ?, ?) ON CONFLICT(group_key, role) DO UPDATE SET thread_id = excluded.thread_id",
      ).run(request!.group, role, threadId);
    })();
  }
}
