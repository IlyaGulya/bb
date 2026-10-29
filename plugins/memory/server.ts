import { randomBytes } from "node:crypto";
import {
  defineRpcContract,
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { isMemoryKind, MEMORY_KINDS, type MemoryKind } from "./memory-kinds.js";
import { tasksRpcContract } from "../tasks/shared/contract.js";
import {
  bindingStateSchema, lineageSchema, memorySelectionSchema,
  reflectionChangeSchema, reflectionProposalSchema, taskMemoryDraftSchema,
  taskScopeSchema, type MemoryLineage, type MemorySelection,
  type ReflectionChange, type ReflectionProposal, type TaskScope,
} from "./lineage.js";

const CATALOG_MAX_CHARS = 3_900;
const DEFAULT_RESULT_LIMIT = 20;
const MAX_RESULT_LIMIT = 100;
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const TAG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/;

type MemoryScope = "global" | "project";
type ReadScope = MemoryScope | "all";
type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  projectId: string | null;
  task: TaskScope | null;
  lineage: MemoryLineage | null;
  name: string;
  summary: string;
  details: string;
  kind: MemoryKind;
  tags: string[];
  importance: number;
  pinned: boolean;
  sourceThreadId: string | null;
  writeReason: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}

const memoryKindSchema = z.enum(MEMORY_KINDS);
const memoryRecordSchema: z.ZodType<MemoryRecord> = z
  .object({
    id: z.string(),
    scope: z.enum(["global", "project"]),
    projectId: z.string().nullable(),
    task: taskScopeSchema.nullable(),
    lineage: lineageSchema.nullable(),
    name: z.string(),
    summary: z.string(),
    details: z.string(),
    kind: memoryKindSchema,
    tags: z.array(z.string()),
    importance: z.number().int().min(0).max(100),
    pinned: z.boolean(),
    sourceThreadId: z.string().nullable(),
    writeReason: z.string(),
    version: z.number().int().positive(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();

const memoryUpdateInputSchema = memorySelectionSchema
  .safeExtend({
    id: z.string(),
    expectedVersion: z.number().int().positive(),
    summary: z.string(),
    details: z.string(),
    kind: memoryKindSchema,
    tags: z.array(z.string()),
    importance: z.number().int().min(0).max(100),
    pinned: z.boolean(),
  })
  .strict();

export const memoryRpcContract = defineRpcContract({
  listMemories: {
    input: memorySelectionSchema.safeExtend({ offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }),
    output: z.object({ memories: z.array(memoryRecordSchema), total: z.number().int().nonnegative(),
      previousOffset: z.number().int().nonnegative().nullable(), nextOffset: z.number().int().nonnegative().nullable() }).strict(),
  },
  memoryAnalytics: {
    input: z.null(),
    output: z.object({ actions: z.array(z.object({ featureId: z.string(), action: z.string(), version: z.literal(1) }).strict()) }).strict(),
  },
  listMemoryProjects: {
    input: z.null(),
    output: z.object({ projects: z.array(z.object({ id: z.string(), name: z.string() }).strict()) }).strict(),
  },
  listMemoryTasks: {
    input: z.object({ projectId: z.string().startsWith("proj_"), search: z.string().max(200) }).strict(),
    output: z.object({ tasks: z.array(z.object({ id: z.string(), key: z.string(), title: z.string(), revision: z.string() }).strict()) }).strict(),
  },
  resolveMemoryTask: {
    input: z.object({ taskKey: z.string().min(1).max(80) }).strict(),
    output: z.object({ projectId: z.string().startsWith("proj_"), task: z.object({
      id: z.string(), key: z.string(), title: z.string(), revision: z.string(),
    }).strict() }).strict(),
  },
  listMemorySources: {
    input: memorySelectionSchema,
    output: z.object({ taskKey: z.string(), sources: z.array(z.object({
      kind: z.enum(["task", "comment"]), commentId: z.string().nullable(), revision: z.string(), label: z.string(),
    }).strict()) }).strict(),
  },
  threadMemoryState: {
    input: z.object({ threadId: z.string().startsWith("thr_") }).strict(),
    output: z.object({ projectId: z.string(), bindings: bindingStateSchema }).strict(),
  },
  searchMemories: {
    input: memorySelectionSchema.safeExtend({ query: z.string().min(1).max(200) }),
    output: z.object({ memories: z.array(memoryRecordSchema) }).strict(),
  },
  getMemory: {
    input: memorySelectionSchema.safeExtend({ name: z.string() }),
    output: z.object({ memory: memoryRecordSchema.nullable() }).strict(),
  },
  memoryHistory: {
    input: memorySelectionSchema.safeExtend({ name: z.string() }),
    output: z.object({ history: z.array(z.object({ version: z.number(), action: z.string(), snapshot: memoryRecordSchema, createdAt: z.number() }).strict()) }).strict(),
  },
  taskSummary: {
    input: memorySelectionSchema,
    output: z.object({ summary: z.string(), generatedAt: z.number() }).strict(),
  },
  createTaskMemory: {
    input: memorySelectionSchema.safeExtend({ draft: taskMemoryDraftSchema }),
    output: z.object({ memory: memoryRecordSchema }).strict(),
  },
  getTaskBindings: {
    input: z.object({ projectId: z.string().startsWith("proj_"), threadId: z.string().startsWith("thr_") }).strict(),
    output: bindingStateSchema,
  },
  setTaskBindings: {
    input: z.object({ projectId: z.string().startsWith("proj_"), threadId: z.string().startsWith("thr_"), expectedVersion: z.number().int().nonnegative(), tasks: z.array(taskScopeSchema).max(20) }).strict(),
    output: bindingStateSchema,
  },
  proposeReflection: {
    input: memorySelectionSchema.safeExtend({ changes: z.array(reflectionChangeSchema).min(1).max(20) }),
    output: reflectionProposalSchema,
  },
  listReflections: {
    input: memorySelectionSchema,
    output: z.object({ proposals: z.array(reflectionProposalSchema) }).strict(),
  },
  getReflection: {
    input: memorySelectionSchema.safeExtend({ id: z.string() }),
    output: reflectionProposalSchema,
  },
  decideReflection: {
    input: memorySelectionSchema.safeExtend({ id: z.string(), decision: z.enum(["apply", "reject"]) }),
    output: reflectionProposalSchema,
  },
  updateMemory: {
    input: memoryUpdateInputSchema,
    output: z.object({ memory: memoryRecordSchema }).strict(),
  },
  deleteMemory: {
    input: memorySelectionSchema
      .safeExtend({
        id: z.string(),
        expectedVersion: z.number().int().positive(),
      })
      .strict(),
    output: z
      .object({
        deleted: z
          .object({ id: z.string(), version: z.number().int().positive() })
          .strict(),
      })
      .strict(),
  },
});

type MemorySummary = Omit<
  MemoryRecord,
  "details" | "sourceThreadId" | "writeReason" | "createdAt"
>;

interface MemoryCreate {
  scope: MemoryScope;
  projectId: string | null;
  task: TaskScope | null;
  lineage: MemoryLineage | null;
  name: string;
  summary: string;
  details: string;
  kind: MemoryKind;
  tags: string[];
  importance: number;
  pinned: boolean;
  sourceThreadId: string | null;
  writeReason: string;
}

interface MemoryUpdate {
  expectedVersion: number;
  lineage?: MemoryLineage;
  summary?: string;
  details?: string;
  kind?: MemoryKind;
  tags?: string[];
  importance?: number;
  pinned?: boolean;
  sourceThreadId: string | null;
  writeReason: string;
}

class CliError extends PluginCliError {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTags(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === "string")
      : [];
  } catch {
    return [];
  }
}

function parseMemoryRow(row: unknown): MemoryRecord {
  if (!isRecord(row))
    throw new Error("memory database returned an invalid row");
  const scope: MemoryScope = row.scope === "project" ? "project" : "global";
  const kind = isMemoryKind(row.kind) ? row.kind : "fact";
  return {
    id: String(row.id),
    scope,
    projectId: typeof row.project_id === "string" ? row.project_id : null,
    task: typeof row.task_id === "string"
      ? taskScopeSchema.parse({ taskId: row.task_id, context: row.context_name }) : null,
    lineage: typeof row.lineage_json === "string"
      ? lineageSchema.parse(JSON.parse(row.lineage_json)) : null,
    name: String(row.name),
    summary: String(row.summary),
    details: String(row.details),
    kind,
    tags: parseTags(row.tags_json),
    importance: Number(row.importance),
    pinned: Number(row.pinned) === 1,
    sourceThreadId:
      typeof row.source_thread_id === "string" ? row.source_thread_id : null,
    writeReason: String(row.write_reason),
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toMemorySummary(memory: MemoryRecord): MemorySummary {
  return {
    id: memory.id,
    scope: memory.scope,
    projectId: memory.projectId,
    task: memory.task,
    lineage: memory.lineage,
    name: memory.name,
    summary: memory.summary,
    kind: memory.kind,
    tags: memory.tags,
    importance: memory.importance,
    pinned: memory.pinned,
    version: memory.version,
    updatedAt: memory.updatedAt,
  };
}

function createMemoryId(): string {
  return `mem_${randomBytes(8).toString("base64url").toLowerCase()}`;
}

function memorySelectionFrom(input: MemorySelection): MemorySelection {
  return { projectId: input.projectId, task: input.task };
}

function scopeKey(scope: MemoryScope, projectId: string | null, task: TaskScope | null): string {
  return task ? `task:${projectId}:${task.taskId}:${task.context}`
    : scope === "global" ? "global" : `project:${projectId ?? "missing"}`;
}

function normalizeOneLine(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unsafeMemoryReason(value: string): string | null {
  if (/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/u.test(value)) {
    return "contains invisible or bidirectional control characters";
  }
  if (/<\/?\s*(system|developer|assistant|tool)(?:\s|>)/iu.test(value)) {
    return "contains a role-like prompt tag";
  }
  if (
    /\b(ignore|disregard|override)\b.{0,50}\b(previous|prior|system|developer)\b/isu.test(
      value,
    )
  ) {
    return "looks like a prompt-injection instruction";
  }
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(value)) {
    return "contains a private key";
  }
  if (/\b(?:sk-[a-z0-9_-]{20,}|gh[pousr]_[a-z0-9]{20,})\b/iu.test(value)) {
    return "contains a token-like secret";
  }
  if (/\b[A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_KEY)\s*=\s*\S+/u.test(value)) {
    return "contains a credential assignment";
  }
  if (/(?:authorization|proxy-authorization)\s*[:=]\s*["']?(?:bearer|basic)\s+\S+/iu.test(value) || /(?:set-cookie|cookie)\s*:\s*\S+/iu.test(value)) {
    return "contains authentication headers";
  }
  if (/(?:^|[\s{,])["']?(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|password|token)["']?\s*[:=]\s*["']?[^\s"',}]+/iu.test(value)) {
    return "contains a credential field";
  }
  if (/(?:^|[\s/\\])\.(?:claude|codex|omp|aws|ssh)[/\\](?:[^\s]*[/\\])?(?:auth|credentials|config|settings|id_rsa|id_ed25519)[^\s]*/iu.test(value)) {
    return "contains a private authentication or provider configuration path";
  }
  return null;
}

function validateText(label: string, value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new CliError(`${label} must not be empty`);
  if (trimmed.length > maxChars) {
    throw new CliError(`${label} must be at most ${maxChars} characters`);
  }
  const unsafe = unsafeMemoryReason(trimmed);
  if (unsafe) throw new CliError(`${label} ${unsafe}; memory was not written`);
  return trimmed;
}

function validateName(value: string): string {
  const normalized = value.trim().toLowerCase();
  const unsafe = unsafeMemoryReason(normalized);
  if (unsafe) throw new CliError(`name ${unsafe}; memory was not written`);
  if (!NAME_PATTERN.test(normalized)) {
    throw new CliError(
      "name must be 1-80 lowercase letters, digits, dots, underscores, or hyphens",
    );
  }
  return normalized;
}

function validateTags(values: string[]): string[] {
  const tags = [...new Set(values.map((tag) => tag.trim().toLowerCase()))];
  if (tags.length > 20) throw new CliError("at most 20 tags are allowed");
  for (const tag of tags) {
    const unsafe = unsafeMemoryReason(tag);
    if (unsafe) throw new CliError(`tag ${unsafe}; memory was not written`);
    if (!TAG_PATTERN.test(tag)) {
      throw new CliError(
        `invalid tag "${tag}"; use lowercase letters, digits, dots, underscores, or hyphens`,
      );
    }
  }
  return tags;
}

function writeScope(
  scope: MemoryScope,
  projectId: string | undefined,
): { scope: MemoryScope; projectId: string | null } {
  if (scope === "global") return { scope: "global", projectId: null };
  if (projectId === undefined) {
    throw new CliError(
      "project-scoped memory requires a BB project context; run inside a project thread",
    );
  }
  return { scope: "project", projectId };
}

function scopeSql(
  scope: ReadScope,
  projectId: string | undefined,
  task: TaskScope | null = null,
): { sql: string; params: string[] } {
  if (task) {
    if (!projectId || scope === "global") throw new CliError("Task memory requires project scope");
    return { sql: "m.scope = 'project' AND m.project_id = ? AND m.task_id = ? AND m.context_name = ?",
      params: [projectId, task.taskId, task.context] };
  }
  if (scope === "global") return { sql: "m.scope = 'global' AND m.task_id IS NULL", params: [] };
  if (scope === "project") {
    if (!projectId) throw new CliError("project scope requires a BB project context");
    return { sql: "m.scope = 'project' AND m.project_id = ? AND m.task_id IS NULL", params: [projectId] };
  }
  if (!projectId) return { sql: "m.scope = 'global' AND m.task_id IS NULL", params: [] };
  return { sql: "(m.scope = 'global' OR (m.scope = 'project' AND m.project_id = ?)) AND m.task_id IS NULL", params: [projectId] };
}

function searchExpression(query: string): string {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  if (tokens.length === 0)
    throw new CliError("search query has no searchable terms");
  return [...new Set(tokens)]
    .slice(0, 12)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(" OR ");
}

function memorySnapshot(memory: MemoryRecord): Record<string, unknown> {
  return {
    id: memory.id,
    scope: memory.scope,
    projectId: memory.projectId,
    task: memory.task,
    lineage: memory.lineage,
    name: memory.name,
    summary: memory.summary,
    details: memory.details,
    kind: memory.kind,
    tags: memory.tags,
    importance: memory.importance,
    pinned: memory.pinned,
    sourceThreadId: memory.sourceThreadId,
    writeReason: memory.writeReason,
    version: memory.version,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}

class MemoryStore {
  constructor(private readonly db: PluginDatabase) {}

  add(input: MemoryCreate): MemoryRecord {
    const now = Date.now();
    const id = createMemoryId();
    const record: MemoryRecord = {
      id,
      scope: input.scope,
      projectId: input.projectId,
      task: input.task,
      lineage: input.lineage,
      name: validateName(input.name),
      summary: validateText("summary", input.summary, 400),
      details: validateText("details", input.details, 16_000),
      kind: input.kind,
      tags: validateTags(input.tags),
      importance: input.importance,
      pinned: input.pinned,
      sourceThreadId: input.sourceThreadId,
      writeReason: validateText("reason", input.writeReason, 500),
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    try {
      this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO memories (
               id, scope, scope_key, project_id, name, summary, details, kind,
               tags_json, importance, pinned, source_thread_id, write_reason,
               version, created_at, updated_at, task_id, context_name, lineage_json, deleted_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          )
          .run(
            record.id,
            record.scope,
            scopeKey(record.scope, record.projectId, record.task),
            record.projectId,
            record.name,
            record.summary,
            record.details,
            record.kind,
            JSON.stringify(record.tags),
            record.importance,
            record.pinned ? 1 : 0,
            record.sourceThreadId,
            record.writeReason,
            record.version,
            record.createdAt,
            record.updatedAt,
            record.task?.taskId ?? null,
            record.task?.context ?? null,
            record.lineage ? JSON.stringify(record.lineage) : null,
          );
        this.insertHistory(
          record,
          "create",
          record.sourceThreadId,
          record.writeReason,
        );
      })();
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("UNIQUE constraint failed")
      ) {
        throw new CliError(
          `an active ${record.scope} memory named "${record.name}" already exists`,
        );
      }
      throw error;
    }
    return record;
  }

  update(
    id: string,
    input: MemoryUpdate,
    ctxProjectId: string | undefined,
    task: TaskScope | null = null,
    readScope: ReadScope = "all",
  ): MemoryRecord {
    return this.db.transaction(() => {
      const current = this.get(id, readScope, ctxProjectId, false, task, true);
      if (!current)
        throw new CliError(`memory "${id}" was not found in the current scope`);
      if (current.version !== input.expectedVersion) {
        throw new CliError(
          `version conflict for ${id}: expected ${input.expectedVersion}, current ${current.version}`,
        );
      }
      const updated: MemoryRecord = {
        ...current,
        summary:
          input.summary === undefined
            ? current.summary
            : validateText("summary", input.summary, 400),
        details:
          input.details === undefined
            ? current.details
            : validateText("details", input.details, 16_000),
        kind: input.kind ?? current.kind,
        tags:
          input.tags === undefined ? current.tags : validateTags(input.tags),
        importance: input.importance ?? current.importance,
        pinned: input.pinned ?? current.pinned,
        lineage: input.lineage ?? current.lineage,
        sourceThreadId: input.sourceThreadId,
        writeReason: validateText("reason", input.writeReason, 500),
        version: current.version + 1,
        updatedAt: Date.now(),
      };
      const result = this.db
        .prepare(
          `UPDATE memories SET
             summary = ?, details = ?, kind = ?, tags_json = ?, importance = ?,
             pinned = ?, source_thread_id = ?, write_reason = ?, version = ?, updated_at = ?, lineage_json = ?
           WHERE id = ? AND version = ? AND deleted_at IS NULL`,
        )
        .run(
          updated.summary,
          updated.details,
          updated.kind,
          JSON.stringify(updated.tags),
          updated.importance,
          updated.pinned ? 1 : 0,
          updated.sourceThreadId,
          updated.writeReason,
          updated.version,
          updated.updatedAt,
          updated.lineage ? JSON.stringify(updated.lineage) : null,
          updated.id,
          current.version,
        );
      if (result.changes !== 1)
        throw new CliError(`memory ${id} changed concurrently; retry`);
      this.insertHistory(
        updated,
        "update",
        updated.sourceThreadId,
        updated.writeReason,
      );
      return updated;
    })();
  }

  forget(
    id: string,
    expectedVersion: number,
    reason: string,
    sourceThreadId: string | null,
    ctxProjectId: string | undefined,
    task: TaskScope | null = null,
    readScope: ReadScope = "all",
  ): MemoryRecord {
    return this.db.transaction(() => {
      const current = this.get(id, readScope, ctxProjectId, false, task, true);
      if (!current)
        throw new CliError(`memory "${id}" was not found in the current scope`);
      if (current.version !== expectedVersion) {
        throw new CliError(
          `version conflict for ${id}: expected ${expectedVersion}, current ${current.version}`,
        );
      }
      const writeReason = validateText("reason", reason, 500);
      const forgotten: MemoryRecord = {
        ...current,
        sourceThreadId,
        writeReason,
        version: current.version + 1,
        updatedAt: Date.now(),
      };
      const result = this.db
        .prepare(
          `UPDATE memories SET deleted_at = ?, source_thread_id = ?, write_reason = ?,
             version = ?, updated_at = ?
           WHERE id = ? AND version = ? AND deleted_at IS NULL`,
        )
        .run(
          forgotten.updatedAt,
          sourceThreadId,
          writeReason,
          forgotten.version,
          forgotten.updatedAt,
          forgotten.id,
          current.version,
        );
      if (result.changes !== 1)
        throw new CliError(`memory ${id} changed concurrently; retry`);
      this.insertHistory(forgotten, "forget", sourceThreadId, writeReason);
      return forgotten;
    })();
  }

  get(
    idOrName: string,
    scope: ReadScope,
    projectId: string | undefined,
    touch = true,
    task: TaskScope | null = null,
    exactId = false,
  ): MemoryRecord | null {
    const scoped = scopeSql(scope, projectId, task);
    const row: unknown = this.db
      .prepare(
        `SELECT m.* FROM memories m
         WHERE m.deleted_at IS NULL AND (m.id = ? OR (? = 0 AND m.name = ?)) AND ${scoped.sql}
         ORDER BY CASE WHEN m.id = ? THEN 0 ELSE 1 END,
           CASE WHEN m.scope = 'project' THEN 0 ELSE 1 END, m.updated_at DESC
         LIMIT 1`,
      )
      .get(idOrName, exactId ? 1 : 0, idOrName, ...scoped.params, idOrName);
    if (row === undefined) return null;
    const memory = parseMemoryRow(row);
    if (touch) {
      this.db
        .prepare("UPDATE memories SET last_accessed_at = ? WHERE id = ?")
        .run(Date.now(), memory.id);
    }
    return memory;
  }

  list(
    scope: ReadScope,
    projectId: string | undefined,
    limit: number,
    task: TaskScope | null = null,
    currentOnly = false,
    offset = 0,
  ): {
    memories: MemoryRecord[];
    total: number;
  } {
    const scoped = scopeSql(scope, projectId, task);
    const lifecycleSql = currentOnly ? " AND json_extract(m.lineage_json, '$.state') = 'current'" : "";
    const rows: unknown[] = this.db
      .prepare(
        `SELECT m.* FROM memories m
         WHERE m.deleted_at IS NULL AND ${scoped.sql}${lifecycleSql}
         ORDER BY m.pinned DESC,
           CASE WHEN m.scope = 'project' THEN 0 ELSE 1 END,
           m.importance DESC, COALESCE(m.last_accessed_at, 0) DESC,
           m.updated_at DESC, m.name ASC
         LIMIT ? OFFSET ?`,
      )
      .all(...scoped.params, limit, offset);
    const countRow: unknown = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM memories m
         WHERE m.deleted_at IS NULL AND ${scoped.sql}${lifecycleSql}`,
      )
      .get(...scoped.params);
    const total = isRecord(countRow) ? Number(countRow.count) : 0;
    return { memories: rows.map(parseMemoryRow), total };
  }


  search(
    query: string,
    scope: ReadScope,
    projectId: string | undefined,
    limit: number,
    task: TaskScope | null = null,
  ): MemoryRecord[] {
    const scoped = scopeSql(scope, projectId, task);
    const rows: unknown[] = this.db
      .prepare(
        `SELECT m.* FROM memories_fts f
         JOIN memories m ON m.id = f.memory_id
         WHERE memories_fts MATCH ? AND m.deleted_at IS NULL AND ${scoped.sql}
         ORDER BY bm25(memories_fts), m.pinned DESC, m.importance DESC, m.updated_at DESC
         LIMIT ?`,
      )
      .all(searchExpression(query), ...scoped.params, limit);
    return rows.map(parseMemoryRow);
  }

  history(id: string, projectId: string | undefined, limit: number, task: TaskScope | null = null, readScope: ReadScope = "all"): unknown[] {
    const scoped = scopeSql(readScope, projectId, task);
    return this.db
      .prepare(
        `SELECT h.version, h.action, h.snapshot_json, h.source_thread_id,
           h.write_reason, h.created_at
         FROM memory_history h
         WHERE h.memory_id = (SELECT m.id FROM memories m
           WHERE (m.id = ? OR m.name = ?) AND ${scoped.sql}
           ORDER BY CASE WHEN m.id = ? THEN 0 ELSE 1 END,
             CASE WHEN m.scope = 'project' THEN 0 ELSE 1 END, m.updated_at DESC LIMIT 1)
         ORDER BY h.version DESC
         LIMIT ?`,
      )
      .all(id, id, ...scoped.params, id, limit);
  }

  retainedTaskId(projectId: string, taskKey: string): string | null {
    const rows: unknown[] = this.db.prepare(`SELECT DISTINCT task_id FROM memories
      WHERE project_id = ? AND task_id IS NOT NULL AND json_extract(lineage_json, '$.taskKey') = ? LIMIT 2`)
      .all(projectId, taskKey);
    if (rows.length > 1) throw new CliError("Retained task key is ambiguous in this Core project");
    const row = rows[0];
    return isRecord(row) && typeof row.task_id === "string" ? row.task_id : null;
  }

  bindings(projectId: string, threadId: string) {
    const row: unknown = this.db.prepare("SELECT version, tasks_json FROM memory_task_bindings WHERE project_id = ? AND thread_id = ?").get(projectId, threadId);
    return isRecord(row) ? bindingStateSchema.parse({ version: row.version, tasks: JSON.parse(String(row.tasks_json)) }) : { version: 0, tasks: [] };
  }

  setBindings(projectId: string, threadId: string, expectedVersion: number, tasks: TaskScope[]) {
    if (new Set(tasks.map((task) => `${task.taskId}:${task.context}`)).size !== tasks.length)
      throw new CliError("Duplicate task/context bindings are not allowed");
    return this.db.transaction(() => {
      const current = this.bindings(projectId, threadId);
      if (current.version !== expectedVersion) throw new CliError("Task bindings changed; reload before saving");
      const next = bindingStateSchema.parse({ version: current.version + 1, tasks });
      if (current.version === 0) {
        this.db.prepare("INSERT INTO memory_task_bindings(project_id, thread_id, version, tasks_json) VALUES (?, ?, ?, ?)")
          .run(projectId, threadId, next.version, JSON.stringify(next.tasks));
      } else {
        const result = this.db.prepare("UPDATE memory_task_bindings SET version = ?, tasks_json = ? WHERE project_id = ? AND thread_id = ? AND version = ?")
          .run(next.version, JSON.stringify(next.tasks), projectId, threadId, expectedVersion);
        if (result.changes !== 1) throw new CliError("Task bindings changed; reload before saving");
      }
      return next;
    })();
  }

  addTask(input: MemoryCreate): MemoryRecord {
    if (!input.task || !input.lineage || input.scope !== "project" || !input.projectId)
      throw new CliError("Task memory requires explicit project, task, context and provenance");
    return this.db.transaction(() => {
      const link = input.lineage?.replaces;
      const prior = link ? this.get(link.id, "project", input.projectId ?? undefined, false, input.task, true) : null;
      if (link && (!prior || prior.version !== link.version || prior.lineage?.state !== "current"))
        throw new CliError("Replacement base changed or is outside this task/context");
      const record = this.add(input);
      if (prior?.lineage) this.update(prior.id, {
        expectedVersion: prior.version, lineage: { ...prior.lineage, state: "replaced", replacedBy: { id: record.id, version: record.version } },
        sourceThreadId: input.sourceThreadId, writeReason: input.writeReason,
      }, input.projectId ?? undefined, input.task);
      return record;
    })();
  }

  propose(selection: MemorySelection, changes: ReflectionChange[]): ReflectionProposal {
    const { projectId, task } = selection;
    if (!task || !projectId) throw new CliError("Reflection requires explicit task/context scope");
    return this.db.transaction(() => {
      const seen = new Set<string>();
      const diffs = changes.map((change) => {
        const after = { ...change, summary: validateText("summary", change.summary, 400),
          details: validateText("details", change.details, 16000), reason: validateText("reason", change.reason, 500) };
        const before = this.get(after.id, "project", projectId, false, task);
        if (!before?.lineage || before.lineage.state === "replaced") throw new CliError("Reflection base is unavailable or replaced");
        if (seen.has(before.id)) throw new CliError("Reflection cannot change a record twice");
        seen.add(before.id);
        if (before.version !== after.expectedVersion) throw new CliError("Reflection base version conflict");
        if (before.summary === after.summary && before.details === after.details &&
          before.lineage.classification === after.classification && before.lineage.state === after.state &&
          JSON.stringify(before.lineage.source) === JSON.stringify(after.source)) throw new CliError("Reflection must propose an actual change");
        return { before: { id: before.id, version: before.version, summary: before.summary, details: before.details, lineage: before.lineage }, after: { ...after, id: before.id } };
      });
      const proposal = reflectionProposalSchema.parse({ id: `reflection_${randomBytes(8).toString("hex")}`, selection, state: "pending", createdAt: Date.now(), decidedAt: null, diffs });
      this.db.prepare("INSERT INTO memory_reflections(id, project_id, task_id, context_name, proposal_json) VALUES (?, ?, ?, ?, ?)")
        .run(proposal.id, projectId, task.taskId, task.context, JSON.stringify(proposal));
      return proposal;
    })();
  }

  proposals(selection: MemorySelection): ReflectionProposal[] {
    if (!selection.task || !selection.projectId) return [];
    return this.db.prepare("SELECT proposal_json FROM memory_reflections WHERE project_id = ? AND task_id = ? AND context_name = ? ORDER BY rowid DESC LIMIT 100")
      .all(selection.projectId, selection.task.taskId, selection.task.context).map((row: unknown) => {
        if (!isRecord(row)) throw new CliError("Invalid reflection storage row");
        return reflectionProposalSchema.parse(JSON.parse(String(row.proposal_json)));
      });
  }

  proposal(selection: MemorySelection, id: string): ReflectionProposal {
    if (!selection.task || !selection.projectId) throw new CliError("Reflection requires explicit task/context scope");
    const row: unknown = this.db.prepare("SELECT proposal_json FROM memory_reflections WHERE id = ? AND project_id = ? AND task_id = ? AND context_name = ?")
      .get(id, selection.projectId, selection.task.taskId, selection.task.context);
    if (!isRecord(row)) throw new CliError("Reflection was not found in this task/context");
    return reflectionProposalSchema.parse(JSON.parse(String(row.proposal_json)));
  }

  decide(selection: MemorySelection, id: string, decision: "apply" | "reject", threadId: string | null): ReflectionProposal {
    return this.db.transaction(() => {
      const proposal = this.proposal(selection, id);
      if (proposal.state !== "pending") throw new CliError("Reflection already has an explicit decision");
      if (decision === "apply") for (const diff of proposal.diffs) {
        const current = this.get(diff.before.id, "project", selection.projectId ?? undefined, false, selection.task, true);
        if (!current?.lineage || current.version !== diff.before.version) throw new CliError("Reflection base version conflict; nothing applied");
        const after = diff.after;
        this.update(current.id, { expectedVersion: diff.before.version, summary: after.summary, details: after.details,
          kind: after.classification === "decision" ? "decision" : "fact",
          lineage: { ...current.lineage, classification: after.classification, state: after.state, source: after.source },
          sourceThreadId: threadId, writeReason: after.reason,
        }, selection.projectId ?? undefined, selection.task);
      }
      const decided: ReflectionProposal = { ...proposal, state: decision === "apply" ? "applied" : "rejected", decidedAt: Date.now() };
      this.db.prepare("UPDATE memory_reflections SET proposal_json = ? WHERE id = ?").run(JSON.stringify(decided), id);
      return decided;
    })();
  }

  private insertHistory(
    memory: MemoryRecord,
    action: "create" | "update" | "forget",
    sourceThreadId: string | null,
    writeReason: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO memory_history (
           memory_id, version, action, snapshot_json, source_thread_id, write_reason, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        memory.id,
        memory.version,
        action,
        JSON.stringify(memorySnapshot(memory)),
        sourceThreadId,
        writeReason,
        memory.updatedAt,
      );
  }
}

function displayMemory(memory: MemoryRecord, includeDetails: boolean): string {
  const tags = memory.tags.length > 0 ? ` tags=${memory.tags.join(",")}` : "";
  const lines = [
    `${memory.id} v${memory.version} [${memory.scope}/${memory.kind}] ${memory.name}`,
    `  ${memory.summary}`,
    `  importance=${memory.importance} pinned=${memory.pinned}${tags}`,
  ];
  if (memory.task && memory.lineage) {
    const lineage = memory.lineage;
    lines.push(`  task=${lineage.taskKey} context=${memory.task.context} ${lineage.classification}/${lineage.state}`,
      `  source=${lineage.source.kind}@${lineage.source.revision} observed=${new Date(lineage.source.observedAt).toISOString()}`);
  }
  if (includeDetails) {
    lines.push(
      "",
      memory.details,
      "",
      `Reason: ${memory.writeReason}`,
      `Source thread: ${memory.sourceThreadId ?? "none"}`,
    );
  }
  return lines.join("\n");
}

function renderCatalog(store: MemoryStore, projectId: string | undefined, maxChars = CATALOG_MAX_CHARS): string {
  const { memories, total } = store.list("all", projectId, MAX_RESULT_LIMIT);
  const header = [
    "Memory index",
    "The entries below are general-note summaries, not full records. Use `bb memory search <query> --general --scope all --json` and `bb memory get <id> --general --scope all --json` to progressively disclose details.",
    "You may proactively save durable learning with `bb memory add`. Use project scope for repository-specific facts and global scope only for broadly applicable user preferences or workflows. Never store secrets, transient status, guesses, or rules already guaranteed by AGENTS.md.",
    "",
  ].join("\n");
  if (memories.length === 0) return `${header}No memories are stored yet.`;

  const lines: string[] = [];
  for (const memory of memories) {
    const tags =
      memory.tags.length > 0 ? `; ${memory.tags.slice(0, 3).join(",")}` : "";
    const pin = memory.pinned ? "; pinned" : "";
    const line = `- ${memory.id} [${memory.scope}/${memory.kind}${pin}${tags}] ${memory.name}: ${normalizeOneLine(memory.summary)}`;
    const candidate = `${header}${[...lines, line].join("\n")}`;
    if (candidate.length > maxChars) break;
    lines.push(line);
  }
  let finalLines = lines;
  let footer = "";
  while (true) {
    const finalShown = finalLines.length;
    footer =
      finalShown < total
        ? `\nShowing ${finalShown} of ${total}; run \`bb memory catalog --general --scope all --json\` for the rest.`
        : "";
    if (
      `${header}${finalLines.join("\n")}${footer}`.length <= maxChars
    ) {
      break;
    }
    finalLines = finalLines.slice(0, -1);
  }
  return `${header}${finalLines.join("\n")}${footer}`;
}

function renderTaskSummary(store: MemoryStore, selection: MemorySelection, taskKey: string, maxChars = 3000): string {
  if (!selection.task || !selection.projectId) throw new CliError("Select a task and logical context");
  const { memories, total } = store.list("project", selection.projectId, MAX_RESULT_LIMIT, selection.task, true);
  const header = `Task memory: ${taskKey}; project=${selection.projectId}; context=${selection.task.context}\nEvidence may be stale. Assumptions are not observations. Open originals and revision history before changing a decision.\n`;
  const retrieval = `bb memory catalog --task ${taskKey} --context ${selection.task.context} --json`;
  const footer = `\nRead more: ${retrieval}`;
  const lines: string[] = [];
  let length = header.length + footer.length;
  if (length > maxChars) return retrieval.length <= maxChars ? retrieval : "";
  for (const memory of memories) {
    const lineage = memory.lineage;
    if (!lineage) continue;
    const source = lineage.source;
    const line = `- ${memory.name} v${memory.version} [${lineage.classification}] ${normalizeOneLine(memory.summary)}\n  source=${source.kind}:${source.commentId ?? lineage.taskKey}@${source.revision}; observed=${new Date(source.observedAt).toISOString()}; memoryUpdated=${new Date(memory.updatedAt).toISOString()}`;
    if (length + line.length + 1 > maxChars) break;
    lines.push(line);
    length += line.length + 1;
  }
  return `${header}${lines.join("\n")}${lines.length === 0 && total === 0 ? "No current task memories." : ""}${footer}`;
}

const SCOPE_DESCRIPTION = "Which memories to read";
const READ_SCOPES = ["all", "project", "global"] as const;
const MAX_EXPECTED_VERSION = Number.MAX_SAFE_INTEGER;

function jsonOutput(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS memories (
       id TEXT PRIMARY KEY,
       scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
       scope_key TEXT NOT NULL,
       project_id TEXT,
       name TEXT NOT NULL,
       summary TEXT NOT NULL,
       details TEXT NOT NULL,
       kind TEXT NOT NULL,
       tags_json TEXT NOT NULL,
       importance INTEGER NOT NULL CHECK (importance BETWEEN 0 AND 100),
       pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
       source_thread_id TEXT,
       write_reason TEXT NOT NULL,
       version INTEGER NOT NULL,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL,
       deleted_at INTEGER,
       last_accessed_at INTEGER,
       access_count INTEGER NOT NULL DEFAULT 0,
       CHECK ((scope = 'global' AND project_id IS NULL) OR (scope = 'project' AND project_id IS NOT NULL))
     );
     CREATE UNIQUE INDEX IF NOT EXISTS memories_active_scope_name
       ON memories(scope_key, name) WHERE deleted_at IS NULL;
     CREATE INDEX IF NOT EXISTS memories_catalog
       ON memories(scope, project_id, deleted_at, pinned, importance, updated_at);
     CREATE TABLE IF NOT EXISTS memory_history (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       memory_id TEXT NOT NULL,
       version INTEGER NOT NULL,
       action TEXT NOT NULL CHECK (action IN ('create', 'update', 'forget')),
       snapshot_json TEXT NOT NULL,
       source_thread_id TEXT,
       write_reason TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       UNIQUE(memory_id, version)
     );
     CREATE INDEX IF NOT EXISTS memory_history_memory
       ON memory_history(memory_id, version DESC);
     CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
       memory_id UNINDEXED, name, summary, details, tags
     );
     CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
       INSERT INTO memories_fts(memory_id, name, summary, details, tags)
       VALUES (new.id, new.name, new.summary, new.details, new.tags_json);
     END;
     CREATE TRIGGER IF NOT EXISTS memories_fts_update
       AFTER UPDATE OF name, summary, details, tags_json ON memories BEGIN
       DELETE FROM memories_fts WHERE memory_id = old.id;
       INSERT INTO memories_fts(memory_id, name, summary, details, tags)
       VALUES (new.id, new.name, new.summary, new.details, new.tags_json);
     END;
     CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
       DELETE FROM memories_fts WHERE memory_id = old.id;
     END;`,
    `ALTER TABLE memories ADD COLUMN task_id TEXT;
     ALTER TABLE memories ADD COLUMN context_name TEXT;
     ALTER TABLE memories ADD COLUMN lineage_json TEXT;
     CREATE INDEX memories_task_context ON memories(project_id, task_id, context_name, deleted_at);
     CREATE TABLE memory_task_bindings (
       project_id TEXT NOT NULL, thread_id TEXT NOT NULL, version INTEGER NOT NULL,
       tasks_json TEXT NOT NULL, PRIMARY KEY(project_id, thread_id)
     );
     CREATE TABLE memory_reflections (
       id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT NOT NULL,
       context_name TEXT NOT NULL, proposal_json TEXT NOT NULL
     );
     CREATE INDEX memory_reflections_scope ON memory_reflections(project_id, task_id, context_name);`,
  ]);
  const store = new MemoryStore(db);


  async function taskFor(selection: MemorySelection) {
    if (!selection.projectId || !selection.task) throw new CliError("Select an explicit project, task and logical context");
    validateName(selection.task.context);
    const { task } = await bb.sdk.plugins.callRpc({ pluginId: "tasks", method: "getTask", input: { taskId: selection.task.taskId }, outputSchema: tasksRpcContract.getTask.output });
    if (!task) throw new CliError("Task is unavailable");
    const { projects } = await bb.sdk.plugins.callRpc({ pluginId: "tasks", method: "listProjects", input: {}, outputSchema: tasksRpcContract.listProjects.output });
    if (!projects.some((project) => project.id === task.projectId && project.linkedBbProjectId === selection.projectId))
      throw new CliError("Task is not linked to the selected Core project");
    await bb.sdk.projects.get({ projectId: selection.projectId });
    return task;
  }

  async function validateSelection(selection: MemorySelection) {
    if (selection.task) await taskFor(selection);
    return selection;
  }

  async function validateHistoricalSelection(selection: MemorySelection) {
    if (selection.task) validateName(selection.task.context);
    if (selection.projectId) await bb.sdk.projects.get({ projectId: selection.projectId });
    return selection;
  }

  async function taskSummary(selection: MemorySelection) {
    const task = await taskFor(selection);
    return renderTaskSummary(store, selection, task.key);
  }

  async function validateSource(selection: MemorySelection, source: MemoryLineage["source"]) {
    const task = await taskFor(selection);
    let revision = task.updatedAt;
    let text = `${task.title}\n${task.description}`;
    if (source.kind === "comment") {
      const { comments } = await bb.sdk.plugins.callRpc({ pluginId: "tasks", method: "listComments", input: { taskId: task.id }, outputSchema: tasksRpcContract.listComments.output });
      const comment = comments.find((entry) => entry.id === source.commentId);
      if (!comment) throw new CliError("Source comment does not belong to this task");
      revision = comment.createdAt;
      text = comment.body;
    }
    if (source.revision !== revision) throw new CliError("Source revision changed; inspect the original before proposing");
    if (source.observedAt < Date.parse(revision) || source.observedAt > Date.now())
      throw new CliError("Observation time must follow the source revision and not be in the future");
    if (source.quote && !text.includes(source.quote)) throw new CliError("Source quote must be an exact bounded excerpt of the selected original");
    if (source.quote) validateText("source quote", source.quote, 600);
    return task;
  }

  async function createTaskMemory(selection: MemorySelection, draft: z.infer<typeof taskMemoryDraftSchema>, threadId: string | null) {
    const task = await validateSource(selection, draft.source);
    return store.addTask({ scope: "project", projectId: selection.projectId, task: selection.task,
      lineage: { taskKey: task.key, classification: draft.classification, state: "current", source: draft.source, replaces: draft.replaces, replacedBy: null },
      name: draft.name, summary: draft.summary, details: draft.details,
      kind: draft.classification === "decision" ? "decision" : "fact", tags: [], importance: 50, pinned: false,
      sourceThreadId: threadId, writeReason: draft.reason,
    });
  }

  async function validateThread(projectId: string, threadId: string) {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.projectId !== projectId) throw new CliError("Thread does not belong to this Core project");
  }

  async function proposeReflection(selection: MemorySelection, changes: ReflectionChange[]) {
    for (const change of changes) await validateSource(selection, change.source);
    return store.propose(selection, changes);
  }

  async function decideReflection(selection: MemorySelection, id: string, decision: "apply" | "reject", threadId: string | null) {
    await validateHistoricalSelection(selection);
    const proposal = store.proposal(selection, id);
    if (decision === "apply") for (const diff of proposal.diffs) await validateSource(selection, diff.after.source);
    return store.decide(selection, id, decision, threadId);
  }

  const analytics = {
    actions: ["scope.select", "draft.open", "reflection.review"].map((action) =>
      bb.experimental_productAnalytics.declareAction({ action, surfaces: ["web", "compact", "mobile", "desktop"], completionSource: "client" }),
    ),
  };

  async function resolveTaskKey(taskKey: string) {
    const { task } = await bb.sdk.plugins.callRpc({ pluginId: "tasks", method: "getTaskByKey", input: { taskKey }, outputSchema: tasksRpcContract.getTaskByKey.output });
    const { projects } = await bb.sdk.plugins.callRpc({ pluginId: "tasks", method: "listProjects", input: {}, outputSchema: tasksRpcContract.listProjects.output });
    const project = projects.find((entry) => entry.id === task?.projectId);
    if (!task || !project?.linkedBbProjectId) throw new CliError("Task requires an explicit link to a Core project before using shared memory");
    await bb.sdk.projects.get({ projectId: project.linkedBbProjectId });
    return { projectId: project.linkedBbProjectId, task: { id: task.id, key: task.key, title: task.title, revision: task.updatedAt } };
  }

  bb.rpc.register(memoryRpcContract, {
    async memoryAnalytics() { return analytics; },
    async resolveMemoryTask({ taskKey }) {
      return resolveTaskKey(taskKey);
    },
    async listMemoryProjects() {
      return { projects: (await bb.sdk.projects.list({ includePersonal: true })).map((project) => ({ id: project.id, name: project.name })) };
    },
    async listMemorySources(selection) {
      const task = await taskFor(selection);
      const { comments } = await bb.sdk.plugins.callRpc({ pluginId: "tasks", method: "listComments", input: { taskId: task.id }, outputSchema: tasksRpcContract.listComments.output });
      return { taskKey: task.key, sources: [
        { kind: "task" as const, commentId: null, revision: task.updatedAt, label: `${task.key} · task revision ${task.updatedAt}` },
        ...comments.map((comment) => ({ kind: "comment" as const, commentId: comment.id, revision: comment.createdAt,
          label: `${comment.authorName} · comment ${comment.createdAt}` })),
      ] };
    },
    async threadMemoryState({ threadId }) {
      const thread = await bb.sdk.threads.get({ threadId });
      return { projectId: thread.projectId, bindings: store.bindings(thread.projectId, threadId) };
    },
    async searchMemories(input) {
      const selection = memorySelectionFrom(input);
      await validateSelection(selection);
      return { memories: store.search(input.query, selection.projectId ? "project" : "global", selection.projectId ?? undefined, MAX_RESULT_LIMIT, selection.task) };
    },
    async listMemoryTasks({ projectId, search }) {
      await bb.sdk.projects.get({ projectId });
      const { projects } = await bb.sdk.plugins.callRpc({ pluginId: "tasks", method: "listProjects", input: {}, outputSchema: tasksRpcContract.listProjects.output });
      const tasks = [];
      for (const project of projects) {
        if (project.linkedBbProjectId !== projectId) continue;
        const page = await bb.sdk.plugins.callRpc({ pluginId: "tasks", method: "listTasks", input: { projectId: project.id, search, limit: 20 }, outputSchema: tasksRpcContract.listTasks.output });
        for (const task of page.tasks) tasks.push({ id: task.id, key: task.key, title: task.title, revision: task.updatedAt });
      }
      return { tasks };
    },
    async listMemories(input) {
      const { offset } = input;
      const selection = memorySelectionFrom(input);
      await validateSelection(selection);
      const page = store.list(selection.projectId ? "project" : "global", selection.projectId ?? undefined, MAX_RESULT_LIMIT, selection.task, false, offset);
      return { memories: page.memories, total: page.total,
        previousOffset: offset === 0 ? null : Math.max(0, offset - MAX_RESULT_LIMIT),
        nextOffset: offset + page.memories.length < page.total ? offset + page.memories.length : null };
    },
    async getMemory(input) {
      const selection = memorySelectionFrom(input);
      await validateSelection(selection);
      return { memory: store.get(input.name, selection.projectId ? "project" : "global", selection.projectId ?? undefined, true, selection.task) };
    },
    async memoryHistory(input) {
      const selection = memorySelectionFrom(input);
      await validateHistoricalSelection(selection);
      return { history: store.history(input.name, selection.projectId ?? undefined, MAX_RESULT_LIMIT, selection.task, selection.projectId ? "project" : "global").map((row) => {
        if (!isRecord(row)) throw new CliError("Invalid memory history row");
        const snapshot = JSON.parse(String(row.snapshot_json));
        return { version: Number(row.version), action: String(row.action), createdAt: Number(row.created_at),
          snapshot: memoryRecordSchema.parse({ task: null, lineage: null, ...snapshot }) };
      }) };
    },
    async taskSummary(selection) {
      return { summary: selection.task ? await taskSummary(selection) : renderCatalog(store, selection.projectId ?? undefined), generatedAt: Date.now() };
    },
    async createTaskMemory(input) {
      return { memory: await createTaskMemory(memorySelectionFrom(input), input.draft, null) };
    },
    async getTaskBindings({ projectId, threadId }) {
      await validateThread(projectId, threadId);
      return store.bindings(projectId, threadId);
    },
    async setTaskBindings({ projectId, threadId, expectedVersion, tasks }) {
      await validateThread(projectId, threadId);
      for (const task of tasks) await taskFor({ projectId, task });
      return store.setBindings(projectId, threadId, expectedVersion, tasks);
    },
    async proposeReflection(input) { return proposeReflection(memorySelectionFrom(input), input.changes); },
    async listReflections(selection) {
      await validateHistoricalSelection(selection);
      return { proposals: store.proposals(selection) };
    },
    async getReflection(input) {
      const selection = memorySelectionFrom(input);
      await validateHistoricalSelection(selection);
      return store.proposal(selection, input.id);
    },
    async decideReflection(input) { return decideReflection(memorySelectionFrom(input), input.id, input.decision, null); },
    async updateMemory(input) {
      const selection = memorySelectionFrom(input);
      await validateSelection(selection);
      if (selection.task) throw new CliError("Task changes require a reviewed reflection or explicit replacement");
      return { memory: store.update(input.id, { expectedVersion: input.expectedVersion, summary: input.summary,
        details: input.details, kind: input.kind, tags: input.tags, importance: input.importance, pinned: input.pinned,
        sourceThreadId: null, writeReason: "Edited in Memory settings",
      }, selection.projectId ?? undefined, null, selection.projectId ? "project" : "global") };
    },
    async deleteMemory(input) {
      const selection = memorySelectionFrom(input);
      await validateSelection(selection);
      const memory = store.forget(input.id, input.expectedVersion, "Explicitly deleted in Memory settings", null,
        selection.projectId ?? undefined, selection.task, selection.projectId ? "project" : "global");
      return { deleted: { id: memory.id, version: memory.version } };
    },
  });

  bb.agents.contributeInstructions(({ projectId, threadId }) =>
    renderCatalog(store, projectId, store.bindings(projectId, threadId).tasks.length > 0 ? 800 : CATALOG_MAX_CHARS),
  );

  bb.agents.configure(async ({ project, thread }) => {
    const eligible: Array<{ scope: TaskScope; key: string }> = [];
    for (const scope of store.bindings(project.id, thread.id).tasks) {
      try {
        const task = await taskFor({ projectId: project.id, task: scope });
        eligible.push({ scope, key: task.key });
      } catch (error) {
        if (!(error instanceof CliError)) throw error;
      }
    }
    if (eligible.length === 0) return { tools: [], skills: ["memory"] };
    const budget = Math.min(3000, Math.floor((CATALOG_MAX_CHARS - 802 - (eligible.length - 1) * 2) / eligible.length));
    const summaries = eligible.map(({ scope, key }) => renderTaskSummary(store, { projectId: project.id, task: scope }, key, budget));
    return { tools: [], skills: ["memory"], instructions: summaries.join("\n\n") };
  });

  const taskOptions = {
    task: { type: "string", description: "Explicit BB task key, for example BBDEV-29" },
    context: { type: "string", description: "Logical context name, independent of provider or payer" },
    general: { type: "boolean", description: "Explicitly select general notes, not a thread task binding" },
  } as const;

  async function cliSelection(ctx: { projectId?: string; threadId?: string }, options: { task?: string; context?: string; general: boolean }, historical = false): Promise<MemorySelection> {
    const projectId = ctx.projectId ?? null;
    if (options.general) {
      if (options.task || options.context) throw new CliError("--general cannot be combined with --task or --context");
      return { projectId, task: null };
    }
    if (options.task || options.context) {
      if (!options.task || !options.context || !projectId) throw new CliError("--task and --context require each other and a Core project");
      if (historical) {
        const taskId = store.retainedTaskId(projectId, options.task);
        if (taskId) return validateHistoricalSelection(memorySelectionSchema.parse({ projectId, task: { taskId, context: options.context } }));
      }
      const resolved = await resolveTaskKey(options.task);
      if (resolved.projectId !== projectId) throw new CliError("Task is not linked to the current Core project");
      validateName(options.context);
      return memorySelectionSchema.parse({ projectId, task: { taskId: resolved.task.id, context: options.context } });
    }
    const bindings = ctx.threadId && projectId ? store.bindings(projectId, ctx.threadId).tasks : [];
    if (bindings.length > 1) throw new CliError("This thread has multiple explicit bindings; select --task and --context, or --general");
    const task = bindings[0] ?? null;
    return historical ? validateHistoricalSelection({ projectId, task }) : validateSelection({ projectId, task });
  }

  bb.cli.register(
    defineCli({
      name: "memory",
      summary: "Read and maintain durable global and project memories",
      description:
        "Memories are summaries first: search or list, then read one in full.\nProject scope holds repository facts; global scope holds durable user preferences.",
      commands: {
        summary: cliCommand({
          summary: "Read the same bounded current task summary used by every runtime",
          options: { ...taskOptions, json: { type: "boolean", description: "Emit JSON" } },
          async run(input, ctx) {
            const selection = await cliSelection(ctx, input.options);
            const summary = selection.task ? await taskSummary(selection) : renderCatalog(store, ctx.projectId);
            return { exitCode: 0, stdout: input.options.json ? jsonOutput({ selection, summary, generatedAt: Date.now() }) : summary };
          },
        }),
        bindings: cliCommand({
          summary: "Inspect this thread's explicit task/context bindings",
          async run(_input, ctx) {
            if (!ctx.projectId || !ctx.threadId) throw new CliError("Bindings require a project thread");
            await validateThread(ctx.projectId, ctx.threadId);
            return { exitCode: 0, stdout: jsonOutput(store.bindings(ctx.projectId, ctx.threadId)) };
          },
        }),
        bind: cliCommand({
          summary: "Explicitly attach or detach one task/context for provider-independent summaries",
          options: {
            task: { type: "string", required: true, description: "BB task key" },
            context: { type: "string", required: true, description: "Logical context name" },
            "expected-version": { type: "integer", min: 0, max: MAX_EXPECTED_VERSION, required: true, description: "Bindings version from memory bindings" },
            remove: { type: "boolean", description: "Detach this binding without deleting memory" },
          },
          async run(input, ctx) {
            if (!ctx.projectId || !ctx.threadId) throw new CliError("Bindings require a project thread");
            await validateThread(ctx.projectId, ctx.threadId);
            const selection = await cliSelection(ctx, { ...input.options, general: false }, input.options.remove);
            if (!selection.task) throw new CliError("Select a task/context");
            const task = selection.task;
            const current = store.bindings(ctx.projectId, ctx.threadId);
            const tasks = input.options.remove
              ? current.tasks.filter((entry) => entry.taskId !== task.taskId || entry.context !== task.context)
              : [...current.tasks, task];
            return { exitCode: 0, stdout: jsonOutput(store.setBindings(ctx.projectId, ctx.threadId, input.options["expected-version"], tasks)) };
          },
        }),
        remember: cliCommand({
          summary: "Save an observation, decision or assumption with explicit task/context and native source revision",
          options: {
            ...taskOptions,
            draft: { type: "string", required: true, description: "JSON {name,summary,details,classification,source:{kind,commentId,revision,observedAt,quote},reason,replaces}; replaces is null or {id,version}" },
          },
          async run(input, ctx) {
            const selection = await cliSelection(ctx, input.options);
            const draft = taskMemoryDraftSchema.parse(JSON.parse(input.options.draft));
            return { exitCode: 0, stdout: jsonOutput({ memory: await createTaskMemory(selection, draft, ctx.threadId ?? null) }) };
          },
        }),
        propose: cliCommand({
          summary: "Persist a reviewable content/provenance diff without changing memories",
          options: {
            ...taskOptions,
            changes: { type: "string", required: true, description: "JSON array of {id,expectedVersion,summary,details,classification,state,source,reason}; id accepts a memory name" },
          },
          async run(input, ctx) {
            const selection = await cliSelection(ctx, input.options);
            const changes = z.array(reflectionChangeSchema).min(1).max(20).parse(JSON.parse(input.options.changes));
            return { exitCode: 0, stdout: jsonOutput(await proposeReflection(selection, changes)) };
          },
        }),
        proposals: cliCommand({
          summary: "Inspect pending and decided reflection diffs in one task/context",
          options: { ...taskOptions },
          async run(input, ctx) {
            const selection = await cliSelection(ctx, input.options, true);
            if (!selection.task) throw new CliError("Select a task/context");
            return { exitCode: 0, stdout: jsonOutput({ proposals: store.proposals(selection) }) };
          },
        }),
        proposal: cliCommand({
          summary: "Inspect one retained reflection by the identifier returned when proposed",
          options: {
            ...taskOptions,
            proposal: { type: "string", required: true, description: "Retained proposal identifier" },
          },
          async run(input, ctx) {
            const selection = await cliSelection(ctx, input.options, true);
            return { exitCode: 0, stdout: jsonOutput(store.proposal(selection, input.options.proposal)) };
          },
        }),
        decide: cliCommand({
          summary: "Explicitly apply or reject one reviewed reflection; stale bases apply nothing",
          options: {
            ...taskOptions,
            proposal: { type: "string", required: true, description: "Proposal identifier returned by memory proposals" },
            decision: { type: "enum", values: ["apply", "reject"], required: true, description: "Explicit operator decision" },
          },
          async run(input, ctx) {
            const selection = await cliSelection(ctx, input.options, input.options.decision === "reject");
            return { exitCode: 0, stdout: jsonOutput(await decideReflection(selection, input.options.proposal, input.options.decision, ctx.threadId ?? null)) };
          },
        }),
        catalog: cliCommand({
          summary: "List compact memory summaries",
          aliases: ["list"],
          options: {
            ...taskOptions,
            scope: {
              type: "enum",
              values: READ_SCOPES,
              default: "all",
              description: SCOPE_DESCRIPTION,
            },
            limit: {
              type: "integer",
              min: 1,
              max: MAX_RESULT_LIMIT,
              default: DEFAULT_RESULT_LIMIT,
              description: "How many memories to list",
            },
            offset: {
              type: "integer",
              min: 0,
              max: Number.MAX_SAFE_INTEGER,
              default: 0,
              description: "Skip this many scoped catalog entries before the next page",
            },
            json: {
              type: "boolean",
              description: "Emit machine-readable JSON",
            },
          },
          async run(input, ctx) {
            const { scope, limit, offset } = input.options;
            const selection = await cliSelection(ctx, input.options);
            const result = store.list(scope, ctx.projectId, limit, selection.task, false, offset);
            return {
              exitCode: 0,
              stdout: input.options.json
                ? jsonOutput({
                    ok: true,
                    scope,
                    offset,
                    memories: result.memories.map(toMemorySummary),
                    total: result.total,
                  })
                : result.memories
                    .map((memory) => displayMemory(memory, false))
                    .join("\n") || "No memories.",
            };
          },
        }),
        search: cliCommand({
          summary: "Search memory summaries and details",
          positionals: [
            {
              name: "query",
              description: "Words to match; every word is searched",
              required: true,
              variadic: true,
            },
          ],
          options: {
            ...taskOptions,
            scope: {
              type: "enum",
              values: READ_SCOPES,
              default: "all",
              description: SCOPE_DESCRIPTION,
            },
            limit: {
              type: "integer",
              min: 1,
              max: MAX_RESULT_LIMIT,
              default: DEFAULT_RESULT_LIMIT,
              description: "How many matches to return",
            },
            json: {
              type: "boolean",
              description: "Emit machine-readable JSON",
            },
          },
          async run(input, ctx) {
            const query = input.positionals.query.join(" ").trim();
            if (!query) throw new CliError("search requires a query");
            const { scope, limit } = input.options;
            const selection = await cliSelection(ctx, input.options);
            const memories = store.search(query, scope, ctx.projectId, limit, selection.task);
            return {
              exitCode: 0,
              stdout: input.options.json
                ? jsonOutput({
                    ok: true,
                    query,
                    scope,
                    memories: memories.map(toMemorySummary),
                  })
                : memories
                    .map((memory) => displayMemory(memory, false))
                    .join("\n") || "No matches.",
            };
          },
        }),
        get: cliCommand({
          summary: "Read one complete memory",
          positionals: [
            {
              name: "id-or-name",
              description: "Memory id or its unique name",
              required: true,
            },
          ],
          options: {
            ...taskOptions,
            scope: {
              type: "enum",
              values: READ_SCOPES,
              default: "all",
              description: SCOPE_DESCRIPTION,
            },
            json: {
              type: "boolean",
              description: "Emit machine-readable JSON",
            },
          },
          async run(input, ctx) {
            const selection = await cliSelection(ctx, input.options);
            const idOrName = input.positionals["id-or-name"];
            const memory = store.get(
              idOrName,
              input.options.scope,
              ctx.projectId,
              true,
              selection.task,
            );
            if (!memory) {
              throw new CliError(
                `memory "${idOrName}" was not found in the current scope`,
              );
            }
            return {
              exitCode: 0,
              stdout: input.options.json
                ? jsonOutput({ ok: true, memory })
                : displayMemory(memory, true),
            };
          },
        }),
        add: cliCommand({
          summary: "Save a project or global memory",
          unexpectedPositionalHint:
            "memory text belongs in --details <TEXT>, not a bare argument",
          options: {
            ...taskOptions,
            scope: {
              type: "enum",
              values: ["project", "global"],
              required: true,
              description:
                "project for repository facts, global for user preferences",
            },
            name: {
              type: "string",
              required: true,
              placeholder: "NAME",
              aliases: ["title"],
              description:
                "Unique 1-80 character lowercase name (letters, digits, dots, underscores, hyphens)",
            },
            summary: {
              type: "string",
              required: true,
              placeholder: "TEXT",
              description: "One line retrieval summary, at most 400 characters",
            },
            details: {
              type: "string",
              required: true,
              placeholder: "TEXT",
              aliases: ["body", "text", "content"],
              description: "Full memory text, at most 16000 characters",
            },
            reason: {
              type: "string",
              required: true,
              placeholder: "TEXT",
              description:
                "Why this is worth remembering, at most 500 characters",
            },
            kind: {
              type: "enum",
              values: MEMORY_KINDS,
              default: "fact",
              aliases: ["type"],
              description: "What kind of memory this is",
            },
            tag: {
              type: "string",
              repeatable: true,
              split: ",",
              placeholder: "TAG",
              aliases: ["tags"],
              description:
                "Lowercase tag; repeat or pass a comma-separated list, at most 20",
            },
            importance: {
              type: "integer",
              min: 0,
              max: 100,
              default: 50,
              description: "Ranking weight for the injected catalog",
            },
            pinned: {
              type: "boolean",
              description: "Keep this memory at the top of the catalog",
            },
            json: {
              type: "boolean",
              description: "Emit machine-readable JSON",
            },
          },
          async run(input, ctx) {
            const selection = await cliSelection(ctx, input.options);
            if (selection.task) throw new CliError("Use memory remember for task facts with explicit provenance; --general opts into general notes");
            const memory = store.add({
              ...writeScope(input.options.scope, ctx.projectId),
              task: null,
              lineage: null,
              name: input.options.name,
              summary: input.options.summary,
              details: input.options.details,
              kind: input.options.kind,
              tags: input.options.tag,
              importance: input.options.importance,
              pinned: input.options.pinned,
              sourceThreadId: ctx.threadId ?? null,
              writeReason: input.options.reason,
            });
            return {
              exitCode: 0,
              stdout: input.options.json
                ? jsonOutput({ ok: true, memory })
                : `Saved ${memory.id} v${memory.version} (${memory.scope}/${memory.name}).`,
            };
          },
        }),
        update: cliCommand({
          summary: "Update a memory with version checking",
          positionals: [
            { name: "id", description: "Memory id", required: true },
          ],
          constraints: [
            {
              kind: "at-least-one",
              options: [
                "summary",
                "details",
                "kind",
                "tag",
                "importance",
                "pinned",
              ],
            },
          ],
          options: {
            ...taskOptions,
            "expected-version": {
              type: "integer",
              min: 1,
              max: MAX_EXPECTED_VERSION,
              required: true,
              description: "Version this update is based on",
            },
            reason: {
              type: "string",
              required: true,
              placeholder: "TEXT",
              description: "Why the memory changed, at most 500 characters",
            },
            summary: {
              type: "string",
              placeholder: "TEXT",
              description: "Replacement summary, at most 400 characters",
            },
            details: {
              type: "string",
              placeholder: "TEXT",
              aliases: ["body", "text", "content"],
              description: "Replacement details, at most 16000 characters",
            },
            kind: {
              type: "enum",
              values: MEMORY_KINDS,
              aliases: ["type"],
              description: "Replacement kind",
            },
            tag: {
              type: "string",
              repeatable: true,
              split: ",",
              placeholder: "TAG",
              aliases: ["tags"],
              description:
                "Replacement tags; repeat or pass a comma-separated list",
            },
            importance: {
              type: "integer",
              min: 0,
              max: 100,
              description: "Replacement ranking weight",
            },
            pinned: {
              type: "enum",
              values: ["true", "false"],
              description: "Pin or unpin the memory",
            },
            json: {
              type: "boolean",
              description: "Emit machine-readable JSON",
            },
          },
          async run(input, ctx) {
            const selection = await cliSelection(ctx, input.options);
            if (selection.task) throw new CliError("Task updates require memory propose or an explicit replacement through memory remember");
            const current = store.get(input.positionals.id, "all", ctx.projectId, false);
            if (!current) throw new CliError("Memory was not found in the current scope");
            const tags = input.options.tag;
            const memory = store.update(
              current.id,
              {
                expectedVersion: input.options["expected-version"],
                summary: input.options.summary,
                details: input.options.details,
                kind: input.options.kind,
                tags: tags.length > 0 ? tags : undefined,
                importance: input.options.importance,
                pinned:
                  input.options.pinned === undefined
                    ? undefined
                    : input.options.pinned === "true",
                sourceThreadId: ctx.threadId ?? null,
                writeReason: input.options.reason,
              },
              ctx.projectId,
            );
            return {
              exitCode: 0,
              stdout: input.options.json
                ? jsonOutput({ ok: true, memory })
                : `Updated ${memory.id} to v${memory.version}.`,
            };
          },
        }),
        forget: cliCommand({
          summary: "Soft-delete a memory with version checking",
          positionals: [
            { name: "id", description: "Memory id", required: true },
          ],
          options: {
            ...taskOptions,
            "expected-version": {
              type: "integer",
              min: 1,
              max: MAX_EXPECTED_VERSION,
              required: true,
              description: "Version this deletion is based on",
            },
            reason: {
              type: "string",
              required: true,
              placeholder: "TEXT",
              description: "Why the memory is gone, at most 500 characters",
            },
            json: {
              type: "boolean",
              description: "Emit machine-readable JSON",
            },
          },
          async run(input, ctx) {
            const selection = await cliSelection(ctx, input.options);
            const current = store.get(input.positionals.id, "all", ctx.projectId, false, selection.task);
            if (!current) throw new CliError("Memory was not found in the current scope");
            const memory = store.forget(
              current.id,
              input.options["expected-version"],
              input.options.reason,
              ctx.threadId ?? null,
              ctx.projectId,
              selection.task,
            );
            return {
              exitCode: 0,
              stdout: input.options.json
                ? jsonOutput({
                    ok: true,
                    forgotten: { id: memory.id, version: memory.version },
                  })
                : `Forgot ${memory.id} at v${memory.version}.`,
            };
          },
        }),
        history: cliCommand({
          summary: "Show a memory's version history",
          positionals: [
            { name: "id", description: "Memory id", required: true },
          ],
          options: {
            ...taskOptions,
            limit: {
              type: "integer",
              min: 1,
              max: MAX_RESULT_LIMIT,
              default: DEFAULT_RESULT_LIMIT,
              description: "How many versions to show, newest first",
            },
            json: {
              type: "boolean",
              description: "Emit machine-readable JSON",
            },
          },
          async run(input, ctx) {
            const selection = await cliSelection(ctx, input.options, true);
            const id = input.positionals.id;
            const history = store.history(
              id,
              ctx.projectId,
              input.options.limit,
              selection.task,
            );
            if (history.length === 0) {
              throw new CliError(`memory history for "${id}" was not found`);
            }
            return {
              exitCode: 0,
              stdout: input.options.json
                ? jsonOutput({ ok: true, id, history })
                : jsonOutput(history),
            };
          },
        }),
      },
    }),
  );
}
