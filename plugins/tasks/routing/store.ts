import { createHash, randomUUID } from "node:crypto";
import type { TasksApiStore } from "../api/index.js";
import { localAwayGrantSchema, routeOutcomeSchema, routeProposalSchema, type LocalAwayGrant, type RouteOutcome, type RouteProposal } from "../shared/routing.js";

export const routingMigration = `
CREATE TABLE task_route_proposals (
  inbox_id TEXT PRIMARY KEY REFERENCES inbox_entries(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL, view_json TEXT NOT NULL
);
CREATE TABLE task_local_away_grants (
  id TEXT PRIMARY KEY, data_json TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  operation_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE TABLE task_route_journal (
  operation_id TEXT PRIMARY KEY, inbox_id TEXT NOT NULL REFERENCES inbox_entries(id) ON DELETE CASCADE,
  grant_id TEXT REFERENCES task_local_away_grants(id), fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('reserved', 'applied', 'parked')),
  reason TEXT NOT NULL, result_json TEXT, created_at INTEGER NOT NULL, finished_at INTEGER,
  callback_state TEXT NOT NULL DEFAULT 'none'
);
CREATE INDEX task_route_journal_inbox ON task_route_journal(inbox_id, created_at);
`;

interface JournalRow {
  operationId: string; grantId: string | null; fingerprint: string; kind: string;
  state: "reserved" | "applied" | "parked"; reason: string; resultJson: string | null;
  createdAt: number; finishedAt: number | null;
  callbackState: "none" | "requested" | "invoked" | "not-invoked";
}
const journalSelect = `SELECT operation_id AS operationId, grant_id AS grantId, fingerprint, kind, state, reason, result_json AS resultJson, created_at AS createdAt, finished_at AS finishedAt, callback_state AS callbackState FROM task_route_journal`;
export const fingerprint = (value: object) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class RoutingStore {
  constructor(readonly store: TasksApiStore, readonly now = Date.now) {}
  proposal(id: string): RouteProposal | null {
    const row = this.store.database.prepare<[string], { view_json: string }>("SELECT view_json FROM task_route_proposals WHERE inbox_id = ?").get(id);
    return row ? routeProposalSchema.parse(JSON.parse(row.view_json)) : null;
  }
  saveProposal(proposal: RouteProposal, expectedRevision: number) {
    return this.store.transaction(() => {
      if ((this.proposal(proposal.id)?.revision ?? 0) !== expectedRevision) throw new Error("Routing advice changed in another session. Refresh before previewing or applying.");
      const parsed = routeProposalSchema.parse(proposal);
      this.store.database.prepare(`INSERT INTO task_route_proposals(inbox_id, revision, view_json) VALUES (?, ?, ?) ON CONFLICT(inbox_id) DO UPDATE SET revision = excluded.revision, view_json = excluded.view_json`).run(parsed.id, parsed.revision, JSON.stringify(parsed));
      return parsed;
    });
  }
  grant(id: string): LocalAwayGrant {
    const row = this.store.database.prepare<[string], { data_json: string; attempts: number; expires_at: number; revoked_at: number | null }>("SELECT data_json, attempts, expires_at, revoked_at FROM task_local_away_grants WHERE id = ?").get(id);
    if (!row) throw new Error("Local-away grant no longer exists");
    const saved = localAwayGrantSchema.parse(JSON.parse(row.data_json));
    return { ...saved, attempts: row.attempts, revokedAt: row.revoked_at, state: row.revoked_at !== null ? "revoked" : row.expires_at <= this.now() ? "expired" : row.attempts >= saved.maxAttempts ? "exhausted" : "active" };
  }
  grants(inboxId: string) {
    return this.store.database.prepare<[string, number], { id: string }>(`SELECT g.id FROM task_local_away_grants g WHERE EXISTS (SELECT 1 FROM json_each(g.data_json, '$.inboxIds') WHERE value = ?) ORDER BY (g.revoked_at IS NULL AND g.expires_at > ? AND g.attempts < json_extract(g.data_json, '$.maxAttempts')) DESC, g.rowid DESC LIMIT 20`).all(inboxId, this.now()).map(row => this.grant(row.id));
  }
  enable(input: Omit<LocalAwayGrant, "id" | "attempts" | "revokedAt" | "createdAt" | "state" | "expiresAt"> & { durationSeconds: number; operationId: string }) {
    return this.store.transaction(() => {
      const hash = fingerprint(input);
      const prior = this.store.database.prepare<[string], { id: string; request_hash: string }>("SELECT id, request_hash FROM task_local_away_grants WHERE operation_id = ?").get(input.operationId);
      if (prior) {
        if (prior.request_hash !== hash) throw new Error("Grant operation ID was already used for another scope or budget");
        return { grant: this.grant(prior.id), created: false };
      }
      const now = this.now();
      const active = this.store.database.prepare<[number, string], { id: string }>(`SELECT g.id FROM task_local_away_grants g WHERE g.revoked_at IS NULL AND g.expires_at > ? AND g.attempts < json_extract(g.data_json, '$.maxAttempts') AND EXISTS (SELECT 1 FROM json_each(g.data_json, '$.inboxIds') old JOIN json_each(?) requested ON old.value = requested.value) LIMIT 1`).get(now, JSON.stringify(input.inboxIds));
      if (active) throw new Error("An active local-away grant already covers this incoming entry. Revoke it explicitly before choosing another scope or budget.");
      const grant = localAwayGrantSchema.parse({ ...input, id: `lag_${randomUUID()}`, expiresAt: now + input.durationSeconds * 1000, attempts: 0, revokedAt: null, createdAt: now, state: "active" });
      this.store.database.prepare("INSERT INTO task_local_away_grants(id, data_json, expires_at, operation_id, request_hash) VALUES (?, ?, ?, ?, ?)").run(grant.id, JSON.stringify(grant), grant.expiresAt, input.operationId, hash);
      return { grant, created: true };
    });
  }
  revoke(id: string) {
    this.grant(id);
    this.store.database.prepare("UPDATE task_local_away_grants SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").run(this.now(), id);
    return this.grant(id);
  }
  journal(id: string) {
    return this.store.database.prepare<[string], JournalRow>(`${journalSelect} WHERE inbox_id = ? ORDER BY created_at DESC, operation_id DESC LIMIT 50`).all(id);
  }
  prior(operationId: string, hash: string): RouteOutcome | null {
    const row = this.store.database.prepare<[string], JournalRow>(`${journalSelect} WHERE operation_id = ?`).get(operationId);
    if (!row) return null;
    if (row.fingerprint !== hash) throw new Error("Operation ID was already used for different routing input; no action was repeated.");
    if (!row.resultJson) throw new Error("This operation is already reserved. Inspect its journal; do not create a replacement attempt while its delivery is uncertain.");
    return routeOutcomeSchema.parse(JSON.parse(row.resultJson));
  }
  assertGrant(grantId: string, inboxId: string, kind: string, projectId: string | null, taskId: string | null, reserved = false) {
    const grant = this.grant(grantId);
    if (grant.revokedAt !== null || grant.expiresAt <= this.now() || (!reserved && grant.attempts >= grant.maxAttempts)) throw new Error("Local-away grant is revoked, expired or exhausted. It is never renewed automatically.");
    if (!grant.inboxIds.includes(inboxId) || projectId !== grant.projectId || (taskId !== null && !grant.taskIds.includes(taskId))) throw new Error("This source, project or existing task is outside the explicit local-away scope.");
    if (!grant.actions.some(action => action === kind)) throw new Error("This action is not permitted by the explicit local-away allowlist.");
  }
  deny(input: { operationId: string; id: string }, hash: string, kind: string, outcome: RouteOutcome) {
    this.store.database.prepare(`INSERT INTO task_route_journal(operation_id, inbox_id, grant_id, fingerprint, kind, state, reason, result_json, created_at, finished_at) VALUES (?, ?, NULL, ?, ?, 'parked', ?, ?, ?, ?)`).run(input.operationId, input.id, hash, kind, outcome.reason, JSON.stringify(outcome), this.now(), this.now());
  }
  reserve(input: { operationId: string; id: string; grantId: string | null }, hash: string, kind: string, projectId: string | null, taskId: string | null) {
    this.store.transaction(() => {
      if (input.grantId) {
        this.assertGrant(input.grantId, input.id, kind, projectId, taskId);
        const changed = this.store.database.prepare(`UPDATE task_local_away_grants SET attempts = attempts + 1 WHERE id = ? AND revoked_at IS NULL AND expires_at > ? AND attempts < json_extract(data_json, '$.maxAttempts')`).run(input.grantId, this.now()).changes;
        if (!changed) throw new Error("Local-away action budget is no longer available.");
      }
      this.store.database.prepare(`INSERT INTO task_route_journal(operation_id, inbox_id, grant_id, fingerprint, kind, state, reason, created_at) VALUES (?, ?, ?, ?, ?, 'reserved', 'Action attempt reserved by server', ?)`).run(input.operationId, input.id, input.grantId, hash, kind, this.now());
    });
  }
  callback(operationId: string, state: JournalRow["callbackState"]) {
    this.store.database.prepare("UPDATE task_route_journal SET callback_state = ? WHERE operation_id = ? AND state = 'reserved'").run(state, operationId);
  }
  finish(operationId: string, outcome: RouteOutcome) {
    const parsed = routeOutcomeSchema.parse(outcome);
    this.store.database.prepare("UPDATE task_route_journal SET state = ?, reason = ?, result_json = ?, finished_at = ? WHERE operation_id = ? AND state = 'reserved'").run(parsed.state, parsed.reason, JSON.stringify(parsed), this.now(), operationId);
    return parsed;
  }
  recover() {
    const rows = this.store.database.prepare<[], { operation_id: string; inbox_id: string }>("SELECT operation_id, inbox_id FROM task_route_journal WHERE state = 'reserved'").all();
    for (const row of rows) this.finish(row.operation_id, { state: "parked", reason: "Interrupted action attempt retained after restart. Budget stays consumed; no automatic replay or grant renewal.", proposal: this.proposal(row.inbox_id), item: null });
    return rows;
  }
}
