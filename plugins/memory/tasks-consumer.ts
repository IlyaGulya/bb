import { z } from "zod";

export const taskIdSchema = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/, "must be a ULID");
export const executionContextIdSchema = z.string().trim().min(1).max(200);
const task = z.object({ id: taskIdSchema, projectId: taskIdSchema, key: z.string(), title: z.string(), description: z.string(), updatedAt: z.string() });
export const taskArtifactProjection = z.object({
  id: z.uuid(), taskId: taskIdSchema, bbProjectId: z.string().min(1), executionContextId: executionContextIdSchema,
  source: z.object({
    threadId: z.string().regex(/^thr_[A-Za-z0-9_-]+$/), eventSeq: z.number().int().nonnegative().safe(),
    quote: z.string().trim().min(1).max(4000), role: z.enum(["user", "assistant"]), textSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  decision: z.string().trim().min(1).max(4000), createdAt: z.iso.datetime(),
});
export const taskArtifactViewProjection = z.object({
  artifact: taskArtifactProjection,
  sourceStatus: z.enum(["available", "archived", "deleted", "changed", "unavailable"]),
  sourceUrl: z.string().nullable(),
});
export const tasksReadProjection = {
  getTask: { output: z.object({ task: task.nullable() }) },
  getTaskByKey: { output: z.object({ task: task.nullable() }) },
  listProjects: { output: z.object({ projects: z.array(z.object({ id: taskIdSchema, linkedBbProjectId: z.string().nullable() })) }) },
  listTasks: { output: z.object({ tasks: z.array(task) }) },
  listComments: { output: z.object({ comments: z.array(z.object({ id: taskIdSchema, body: z.string(), createdAt: z.string(), authorName: z.string() })) }) },
  listTaskArtifacts: { output: z.array(taskArtifactProjection) },
  getTaskArtifact: { output: taskArtifactViewProjection },
};
