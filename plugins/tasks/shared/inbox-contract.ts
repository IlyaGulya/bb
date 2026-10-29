import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const inboxContextSchema = z.enum(["work", "personal", "unknown"]);
const text = z.string().trim().min(1).max(2000);
const sourceUrl = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), "Use an http(s) source URL");
export const inboxEntrySchema = z.object({
  id: z.string(),
  sourceKind: z.string(),
  sourceKey: z.string(),
  revision: z.string(),
  title: z.string(),
  body: z.string(),
  sourceUrl: z.string().nullable(),
  context: inboxContextSchema,
  lane: z.enum(["new", "needs_input", "review"]),
  reason: z.string(),
  state: z.enum(["open", "resolved", "snoozed"]),
  active: z.boolean(),
  snoozedUntil: z.string().nullable(),
  taskId: z.string().nullable(),
  taskKey: z.string().nullable(),
  threadId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type InboxEntry = z.infer<typeof inboxEntrySchema>;
export const inboxSourceSchema = z.object({
  sourceKind: text.refine(
    (value) =>
      ![
        "manual",
        "native_interaction",
        "native_failure",
        "task_review",
        "task_workflow",
        "task_route",
      ].includes(value),
    "Reserved native source kind",
  ),
  sourceKey: text,
  revision: text,
  title: text,
  body: z.string().max(100000),
  sourceUrl: sourceUrl.optional(),
  context: inboxContextSchema.default("unknown"),
  active: z.boolean(),
});
export const inboxRpcContract = defineRpcContract({
  listInbox: {
    input: z.object({
      state: z.enum(["open", "resolved", "snoozed", "all"]).default("open"),
      context: inboxContextSchema.optional(),
    }),
    output: z.object({
      items: z.array(inboxEntrySchema),
      warnings: z.array(z.string()),
    }),
  },
  listWorking: {
    input: z.object({}),
    output: z.object({
      items: z.array(
        z.object({
          taskId: z.string(),
          taskKey: z.string(),
          title: z.string(),
          threadId: z.string(),
          status: z.enum(["starting", "working"]),
          context: inboxContextSchema,
        }),
      ),
      warnings: z.array(z.string()),
    }),
  },
  createInbox: {
    input: z.object({
      title: text,
      body: z.string().max(100000).default(""),
      context: inboxContextSchema.default("unknown"),
      sourceUrl: sourceUrl.optional(),
    }),
    output: z.object({ item: inboxEntrySchema }),
  },
  upsertInboxSource: {
    input: inboxSourceSchema,
    output: z.object({ item: inboxEntrySchema, changed: z.boolean() }),
  },
  decideInbox: {
    input: z.object({
      id: text,
      action: z.enum(["resolve", "snooze", "unsnooze"]),
      until: z.string().datetime({ offset: true }).optional(),
    }),
    output: z.object({ item: inboxEntrySchema }),
  },
  linkInboxTask: {
    input: z.object({ id: text, taskId: text }),
    output: z.object({ item: inboxEntrySchema }),
  },
  createInboxTask: {
    input: z.object({ id: text, projectId: text }),
    output: z.object({ item: inboxEntrySchema }),
  },
  inboxHistory: {
    input: z.object({ id: text }),
    output: z.object({
      decisions: z.array(
        z.object({
          revision: z.string(),
          decision: z.string(),
          at: z.string(),
        }),
      ),
    }),
  },
});
export type InboxRpcContract = typeof inboxRpcContract;
