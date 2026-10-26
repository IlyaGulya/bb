import { eq } from "drizzle-orm";
import {
  executionContextSchema,
  modelConnectionSchema,
  threadExecutionBindingSchema,
  type ExecutionContext,
  type ModelConnection,
  type ProjectContextDefaults,
  type ResolvedThreadExecutionBinding,
  type ThreadExecutionBinding,
} from "@bb/domain";
import type { DbConnection, DbQueryConnection } from "../connection.js";
import { executionContextProjects, executionContexts, modelConnections, projectContextDefaults, threadExecutionBindings } from "../schema.js";

export function getExecutionContext(db: DbQueryConnection, id: string): ExecutionContext | null {
  const row = db.select().from(executionContexts).where(eq(executionContexts.id, id)).get();
  if (!row) return null;
  const projectIds = db.select({ id: executionContextProjects.projectId }).from(executionContextProjects).where(eq(executionContextProjects.executionContextId, id)).all().map((project) => project.id);
  return executionContextSchema.parse({ ...row.definition, projectIds, defaultModelConnectionId: row.defaultModelConnectionId });
}

export function listExecutionContexts(db: DbQueryConnection): ExecutionContext[] {
  return db.select({ id: executionContexts.id }).from(executionContexts).all().map(({ id }) => getExecutionContext(db, id)!).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function saveExecutionContext(db: DbConnection, value: ExecutionContext): ExecutionContext {
  const definition = executionContextSchema.parse(value);
  db.transaction((tx) => {
    tx.insert(executionContexts).values({ id: definition.id, definition, defaultModelConnectionId: definition.defaultModelConnectionId }).onConflictDoUpdate({ target: executionContexts.id, set: { definition, defaultModelConnectionId: definition.defaultModelConnectionId } }).run();
    tx.delete(executionContextProjects).where(eq(executionContextProjects.executionContextId, definition.id)).run();
    for (const projectId of new Set(definition.projectIds)) {
      tx.insert(executionContextProjects).values({ executionContextId: definition.id, projectId }).run();
    }
  });
  return getExecutionContext(db, definition.id)!;
}

export function deleteExecutionContext(db: DbConnection, id: string): boolean {
  return db.delete(executionContexts).where(eq(executionContexts.id, id)).returning({ id: executionContexts.id }).all().length > 0;
}

export function getModelConnection(db: DbQueryConnection, id: string): ModelConnection | null {
  const row = db.select().from(modelConnections).where(eq(modelConnections.id, id)).get();
  return row ? modelConnectionSchema.parse(row.definition) : null;
}

export function listModelConnections(db: DbQueryConnection): ModelConnection[] {
  return db.select().from(modelConnections).all().map((row) => modelConnectionSchema.parse(row.definition)).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function saveModelConnection(db: DbConnection, value: ModelConnection): ModelConnection {
  const definition = modelConnectionSchema.parse(value);
  db.insert(modelConnections).values({ id: definition.id, hostId: definition.hostId, definition }).onConflictDoUpdate({ target: modelConnections.id, set: { hostId: definition.hostId, definition } }).run();
  return definition;
}

export function deleteModelConnection(db: DbConnection, id: string): boolean {
  return db.delete(modelConnections).where(eq(modelConnections.id, id)).returning({ id: modelConnections.id }).all().length > 0;
}

export function getProjectContextDefaults(db: DbQueryConnection, projectId: string): ProjectContextDefaults {
  return db.select().from(projectContextDefaults).where(eq(projectContextDefaults.projectId, projectId)).get() ?? { projectId, executionContextId: null, modelConnectionId: null };
}

export function setProjectContextDefaults(db: DbConnection, value: ProjectContextDefaults): ProjectContextDefaults {
  if (value.executionContextId === null && value.modelConnectionId === null) {
    db.delete(projectContextDefaults).where(eq(projectContextDefaults.projectId, value.projectId)).run();
  } else {
    db.insert(projectContextDefaults).values(value).onConflictDoUpdate({ target: projectContextDefaults.projectId, set: value }).run();
  }
  return value;
}

export function persistThreadExecutionBinding(db: DbQueryConnection, threadId: string, resolved: ResolvedThreadExecutionBinding | null): ThreadExecutionBinding | null {
  if (resolved === null) return null;
  const snapshot = threadExecutionBindingSchema.parse({ ...resolved, threadId });
  db.insert(threadExecutionBindings).values({ threadId, snapshot }).run();
  return snapshot;
}

export function getThreadExecutionBinding(db: DbQueryConnection, threadId: string): ThreadExecutionBinding | null {
  const row = db.select().from(threadExecutionBindings).where(eq(threadExecutionBindings.threadId, threadId)).get();
  return row ? threadExecutionBindingSchema.parse(row.snapshot) : null;
}
