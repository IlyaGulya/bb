import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { Configuration } from "./contract.js";
import type { MessageChange } from "./events.js";

export const migrations = [
  `CREATE TABLE slack_messages (
    scope TEXT NOT NULL, channel TEXT NOT NULL, ts TEXT NOT NULL, thread TEXT NOT NULL,
    version TEXT NOT NULL, text TEXT NOT NULL, mentioned INTEGER NOT NULL, deleted INTEGER NOT NULL,
    PRIMARY KEY(scope, channel, ts)
  ); CREATE INDEX slack_messages_discussion ON slack_messages(scope, channel, thread, mentioned);`,
  `CREATE TABLE slack_receipts (id TEXT PRIMARY KEY, received_at INTEGER NOT NULL);
   CREATE TABLE slack_sources (
    source_key TEXT PRIMARY KEY, scope TEXT NOT NULL, channel TEXT NOT NULL, thread TEXT NOT NULL,
    watermark TEXT NOT NULL, payload TEXT NOT NULL, revision TEXT NOT NULL,
    pending INTEGER NOT NULL, delivered_revision TEXT, received_at INTEGER NOT NULL
   ); CREATE INDEX slack_sources_pending ON slack_sources(pending, received_at);`,
  `CREATE TABLE slack_gaps (id INTEGER PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER, reason TEXT NOT NULL);
   CREATE TABLE slack_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
];
export const sourceSchema = z.object({
  sourceKind: z.literal("slack_mention"),
  sourceKey: z.string(),
  revision: z.string(),
  title: z.string(),
  body: z.string(),
  active: z.boolean(),
  context: z.enum(["work", "personal", "unknown"]),
  sourceUrl: z.string(),
});
export type Source = z.infer<typeof sourceSchema>;
type MessageRow = {
  thread: string;
  version: string;
  text: string;
  mentioned: number;
  deleted: number;
  ts: string;
};
type SourceRow = { payload: string; revision: string; watermark: string };
export class IntakeStore {
  constructor(
    readonly db: Database.Database,
    readonly now: () => number = Date.now,
  ) {
    db.pragma("synchronous = FULL");
  }
  accept(
    id: string,
    change: MessageChange,
    context: Configuration["context"],
  ): void {
    const scope = `${change.team}:${change.recipient}`;
    const receipt = `${scope}:${id}`;
    this.db.transaction(() => {
      if (
        this.db
          .prepare("SELECT 1 FROM slack_receipts WHERE id = ?")
          .get(receipt)
      )
        return;
      this.db
        .prepare("INSERT INTO slack_receipts VALUES (?, ?)")
        .run(receipt, this.now());
      this.setMeta("lastEventAt", String(this.now()));
      this.setMeta(
        `event:${change.team}:${change.channel}`,
        String(this.now()),
      );
      const prior = this.db
        .prepare<[string, string, string], MessageRow>(
          "SELECT * FROM slack_messages WHERE scope = ? AND channel = ? AND ts = ?",
        )
        .get(scope, change.channel, change.ts);
      if (
        prior &&
        (prior.deleted ||
          change.version < prior.version ||
          (change.version === prior.version && !change.deleted))
      )
        return;
      const thread = prior?.thread ?? change.thread ?? change.ts;
      this.db
        .prepare(`INSERT INTO slack_messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope, channel, ts) DO UPDATE SET version=excluded.version, text=excluded.text,
        mentioned=excluded.mentioned, deleted=excluded.deleted`)
        .run(
          scope,
          change.channel,
          change.ts,
          thread,
          change.version,
          change.text,
          Number(change.mentioned),
          Number(change.deleted),
        );
      const key = `${scope}:${change.channel}:${thread}`;
      const source = this.db
        .prepare<[string], SourceRow>(
          "SELECT payload, revision, watermark FROM slack_sources WHERE source_key = ?",
        )
        .get(key);
      if (!source && !change.mentioned) return;
      if (
        !prior &&
        source &&
        change.version < source.watermark &&
        !change.deleted
      ) {
        this.db
          .prepare(
            "UPDATE slack_messages SET text = '', mentioned = 0 WHERE scope = ? AND channel = ? AND ts = ?",
          )
          .run(scope, change.channel, change.ts);
        return;
      }
      const messages = this.db
        .prepare<[string, string, string], MessageRow>(
          `SELECT ts, text FROM slack_messages WHERE scope = ? AND channel = ? AND thread = ?
         AND mentioned = 1 AND deleted = 0 ORDER BY ts DESC LIMIT 25`,
        )
        .all(scope, change.channel, thread);
      const body = messages.length
        ? `Received Slack source; not accepted work. Review and link or convert in Inbox.\n\n${messages.map((row) => `${row.ts}\n${row.text.slice(0, 3500)}`).join("\n\n")}\n\nExcerpts only; open Slack for full context.`
        : "The observed human mentions in this discussion were removed or deleted. Linked tasks are unchanged.";
      const content = {
        sourceKind: "slack_mention" as const,
        sourceKey: key,
        title: `Slack mention · ${change.channel}`,
        body,
        active: messages.length > 0,
        context,
        sourceUrl: `https://app.slack.com/client/${change.team}/${change.channel}/thread/${change.channel}-${thread}`,
      };
      const revision = createHash("sha256")
        .update(JSON.stringify(content))
        .digest("hex");
      const watermark =
        source && source.watermark > change.version
          ? source.watermark
          : change.version;
      this.db
        .prepare(`INSERT INTO slack_sources
        (source_key, scope, channel, thread, watermark, payload, revision, pending, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(source_key) DO UPDATE SET watermark=excluded.watermark,
        payload=excluded.payload, revision=excluded.revision,
        pending=CASE WHEN slack_sources.revision = excluded.revision THEN slack_sources.pending ELSE 1 END`)
        .run(
          key,
          scope,
          change.channel,
          thread,
          watermark,
          JSON.stringify({ ...content, revision }),
          revision,
          this.now(),
        );
    })();
  }
  pending(configuration: Configuration): Source | null {
    const channels = configuration.conversations.map((row) => row.id);
    if (channels.length === 0) return null;
    const row = this.db
      .prepare<string[], { payload: string }>(
        `SELECT payload FROM slack_sources WHERE pending = 1 AND scope = ? AND channel IN (${channels.map(() => "?").join(",")}) ORDER BY received_at LIMIT 1`,
      )
      .get(`${configuration.teamId}:${configuration.userId}`, ...channels);
    return row ? sourceSchema.parse(JSON.parse(row.payload)) : null;
  }
  delivered(source: Source): void {
    this.db
      .prepare(`UPDATE slack_sources SET pending = 0, delivered_revision = ?
      WHERE source_key = ? AND revision = ?`)
      .run(source.revision, source.sourceKey, source.revision);
    this.setMeta("deliveryError", "");
  }
  counts(): { pending: number; receivedDiscussions: number } {
    return this.db
      .prepare<[], { pending: number; receivedDiscussions: number }>(
        "SELECT COALESCE(SUM(pending), 0) AS pending, COUNT(*) AS receivedDiscussions FROM slack_sources",
      )
      .get()!;
  }
  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO slack_meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }
  meta(key: string): string | null {
    return (
      this.db
        .prepare<[string], { value: string }>(
          "SELECT value FROM slack_meta WHERE key = ?",
        )
        .get(key)?.value ?? null
    );
  }
  gap(reason: string, startedAt = this.now()): void {
    if (
      this.db
        .prepare(
          "SELECT 1 FROM slack_gaps WHERE ended_at IS NULL AND reason = ?",
        )
        .get(reason)
    )
      return;
    this.db
      .prepare("INSERT INTO slack_gaps (started_at, reason) VALUES (?, ?)")
      .run(startedAt, reason);
  }
  connected(): void {
    this.db
      .prepare(`UPDATE slack_gaps SET ended_at = ? WHERE ended_at IS NULL
      AND reason != 'conversation_access_gap; no history backfill'
      AND reason != 'unsupported_or_malformed_event; inspect Slack app subscription configuration'`)
      .run(this.now());
    this.setMeta("heartbeat", String(this.now()));
  }
  coverageRecovered(): void {
    this.db
      .prepare(
        "UPDATE slack_gaps SET ended_at = ? WHERE ended_at IS NULL AND reason = 'conversation_access_gap; no history backfill'",
      )
      .run(this.now());
  }
  gaps(): { startedAt: number; endedAt: number | null; reason: string }[] {
    return this.db
      .prepare<
        [],
        { startedAt: number; endedAt: number | null; reason: string }
      >(
        "SELECT started_at AS startedAt, ended_at AS endedAt, reason FROM slack_gaps ORDER BY id DESC LIMIT 100",
      )
      .all();
  }
}

export class DeliveryQueue {
  private running: Promise<void> | null = null;
  constructor(
    readonly store: IntakeStore,
    readonly configuration: () => Configuration,
    readonly send: (source: Source) => Promise<void>,
  ) {}
  drain(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }
  private async run(): Promise<void> {
    for (let count = 0; count < 100; count++) {
      const config = this.configuration();
      if (!config.enabled || !config.approved) return;
      const source = this.store.pending(config);
      if (!source) return;
      try {
        await this.send(source);
        this.store.delivered(source);
      } catch {
        this.store.setMeta(
          "deliveryError",
          "inbox_delivery_failed; durable source retained for retry",
        );
        return;
      }
    }
  }
}
