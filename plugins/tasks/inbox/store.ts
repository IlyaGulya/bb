import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import { inboxEntrySchema, type InboxEntry } from "../shared/inbox-contract.js";

export type InboxSource = Pick<
  InboxEntry,
  | "sourceKind"
  | "sourceKey"
  | "revision"
  | "title"
  | "body"
  | "context"
  | "active"
  | "lane"
  | "reason"
> & {
  sourceUrl?: string | null;
  taskId?: string | null;
  threadId?: string | null;
};
const select = `SELECT i.id, source_kind AS sourceKind, source_key AS sourceKey, revision,
  i.title, body, source_url AS sourceUrl, context, lane, reason, state, active,
  snoozed_until AS snoozedUntil, task_id AS taskId, thread_id AS threadId,
  i.created_at AS createdAt, i.updated_at AS updatedAt,
  CASE WHEN t.id IS NULL THEN NULL ELSE p.prefix || '-' || t.number END AS taskKey
  FROM inbox_entries i LEFT JOIN tasks t ON t.id = i.task_id LEFT JOIN projects p ON p.id = t.project_id`;
function entry(row: unknown): InboxEntry {
  if (typeof row !== "object" || row === null || !("active" in row))
    throw new Error("Inbox entry not found");
  return inboxEntrySchema.parse({
    ...row,
    active: row.active === 1 || row.active === true,
  });
}

export class InboxStore {
  constructor(
    readonly db: Database,
    readonly now = () => new Date().toISOString(),
  ) {}
  get(id: string): InboxEntry {
    return entry(
      this.db.prepare<[string], unknown>(`${select} WHERE i.id = ?`).get(id),
    );
  }
  list(
    state: InboxEntry["state"] | "all",
    context?: InboxEntry["context"],
  ): InboxEntry[] {
    return this.db
      .prepare<
        [string, string, string | null, string | null],
        unknown
      >(`${select}
      WHERE (? = 'all' OR i.state = ?) AND (? IS NULL OR i.context = ?)
      ORDER BY i.updated_at DESC, i.id`)
      .all(state, state, context ?? null, context ?? null)
      .map(entry);
  }
  history(id: string) {
    this.get(id);
    return this.db
      .prepare<[string], { revision: string; decision: string; at: string }>(
        "SELECT revision, decision, at FROM inbox_decisions WHERE inbox_id = ? ORDER BY id",
      )
      .all(id);
  }
  record(item: InboxEntry, decision: string): void {
    this.db
      .prepare<[string, string, string, string]>(
        "INSERT INTO inbox_decisions (inbox_id, revision, decision, at) VALUES (?, ?, ?, ?)",
      )
      .run(item.id, item.revision, decision, this.now());
  }
  upsert(input: InboxSource): { item: InboxEntry; changed: boolean } {
    return this.db.transaction(() => {
      const prior = this.db
        .prepare<[string, string], { id: string }>(
          "SELECT id FROM inbox_entries WHERE source_kind = ? AND source_key = ?",
        )
        .get(input.sourceKind, input.sourceKey);
      const current = prior ? this.get(prior.id) : null;
      const timestamp = this.now();
      if (current) {
        const revised = current.revision !== input.revision;
        const recovered = !input.active && current.active;
        if (!revised && !recovered && current.active === input.active)
          return { item: current, changed: false };
        const state = !input.active
          ? "resolved"
          : revised
            ? "open"
            : current.state;
        this.db
          .prepare<
            [
              string,
              string,
              string,
              string | null,
              string,
              string,
              string,
              string,
              number,
              string | null,
              string | null,
              string | null,
              string,
              string,
            ]
          >(
            `UPDATE inbox_entries SET revision = ?, title = ?, body = ?, source_url = ?, context = ?, lane = ?, reason = ?, state = ?, active = ?, snoozed_until = ?, task_id = ?, thread_id = ?, updated_at = ? WHERE id = ?`,
          )
          .run(
            input.revision,
            input.title,
            input.body,
            input.sourceUrl ?? null,
            input.context,
            input.lane,
            input.reason,
            state,
            Number(input.active),
            state === "snoozed" ? current.snoozedUntil : null,
            current.taskId ?? input.taskId ?? null,
            input.threadId ?? current.threadId,
            timestamp,
            current.id,
          );
        const item = this.get(current.id);
        this.record(
          item,
          !input.active
            ? "source_resolved"
            : revised
              ? "source_revised"
              : "source_active",
        );
        return { item, changed: true };
      }
      const id = randomUUID();
      this.db
        .prepare<
          [
            string,
            string,
            string,
            string,
            string,
            string,
            string | null,
            string,
            string,
            string,
            string,
            number,
            string | null,
            string | null,
            string,
            string,
          ]
        >(
          `INSERT INTO inbox_entries (id, source_kind, source_key, revision, title, body, source_url, context, lane, reason, state, active, task_id, thread_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.sourceKind,
          input.sourceKey,
          input.revision,
          input.title,
          input.body,
          input.sourceUrl ?? null,
          input.context,
          input.lane,
          input.reason,
          input.active ? "open" : "resolved",
          Number(input.active),
          input.taskId ?? null,
          input.threadId ?? null,
          timestamp,
          timestamp,
        );
      const item = this.get(id);
      this.record(item, input.active ? "received" : "source_resolved");
      return { item, changed: true };
    })();
  }
  decide(
    id: string,
    action: "resolve" | "snooze" | "unsnooze",
    until?: string,
  ): InboxEntry {
    return this.db.transaction(() => {
      const item = this.get(id);
      if (
        action === "snooze" &&
        (!until || Date.parse(until) <= Date.parse(this.now()))
      )
        throw new Error("Snooze requires a future time");
      if (action !== "snooze" && until !== undefined)
        throw new Error("until is only valid for snooze");
      if (action !== "resolve" && !item.active)
        throw new Error("The source is no longer active");
      const state =
        action === "resolve"
          ? "resolved"
          : action === "snooze"
            ? "snoozed"
            : "open";
      const snoozedUntil =
        action === "snooze" ? new Date(until!).toISOString() : null;
      if (item.state === state && item.snoozedUntil === snoozedUntil)
        return item;
      this.db
        .prepare<[string, string | null, string, string]>(
          "UPDATE inbox_entries SET state = ?, snoozed_until = ?, updated_at = ? WHERE id = ?",
        )
        .run(state, snoozedUntil, this.now(), id);
      this.record(item, action);
      return this.get(id);
    })();
  }
  link(id: string, taskId: string): InboxEntry {
    return this.db.transaction(() => {
      const item = this.get(id);
      if (item.taskId && item.taskId !== taskId)
        throw new Error("Inbox item already links a task");
      if (!item.taskId) {
        this.db
          .prepare<[string, string, string]>(
            "UPDATE inbox_entries SET task_id = ?, updated_at = ? WHERE id = ?",
          )
          .run(taskId, this.now(), id);
        this.record(item, `linked:${taskId}`);
      }
      return this.decide(id, "resolve");
    })();
  }
  wake(): string[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare<[string], { id: string }>(
          "SELECT id FROM inbox_entries WHERE state = 'snoozed' AND active = 1 AND snoozed_until <= ?",
        )
        .all(this.now());
      for (const { id } of rows) {
        const item = this.get(id);
        this.db
          .prepare<[string, string]>(
            "UPDATE inbox_entries SET state = 'open', snoozed_until = NULL, updated_at = ? WHERE id = ?",
          )
          .run(this.now(), id);
        this.record(item, "time_return");
      }
      return rows.map(({ id }) => id);
    })();
  }
  nativeEntries(): InboxEntry[] {
    return this.db
      .prepare<[], unknown>(
        `${select} WHERE i.active = 1 AND i.source_kind IN ('native_interaction', 'native_failure', 'task_review', 'task_workflow')`,
      )
      .all()
      .map(entry);
  }
  taskContext(taskId: string): InboxEntry["context"] {
    return (
      this.db
        .prepare<[string], { context: InboxEntry["context"] }>(
          "SELECT context FROM inbox_entries WHERE task_id = ? AND source_kind NOT IN ('native_interaction', 'native_failure', 'task_review', 'task_workflow') ORDER BY created_at LIMIT 1",
        )
        .get(taskId)?.context ?? "unknown"
    );
  }
}
