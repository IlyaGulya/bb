import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { idSchema } from "./contract.js";

const nonBlank = z.string().trim().min(1);
const revision = z.number().int().nonnegative();
const taskInput = z.object({ taskId: idSchema }).strict();
const revisionInput = taskInput.extend({ expectedRevision: revision });

export const jiraConnectionSchema = z
  .object({
    id: nonBlank,
    label: nonBlank,
    siteUrl: z.url(),
    projectIds: z.array(idSchema).min(1),
    ready: z.boolean(),
    error: z.string().nullable(),
  })
  .strict();

export const jiraTransitionFieldsSchema = z.record(nonBlank, z.json());

export const jiraSnapshotSchema = z
  .object({
    id: nonBlank,
    key: nonBlank,
    url: z.url(),
    summary: z.string(),
    description: z.string(),
    descriptionDocument: z.string().nullable(),
    statusId: nonBlank,
    statusName: z.string(),
    priority: z.string().nullable(),
    assignee: z.string().nullable(),
    updatedAt: nonBlank,
    fetchedAt: nonBlank,
    commentCount: z.number().int().nonnegative(),
    comments: z.array(
      z
        .object({
          id: nonBlank,
          body: z.string(),
          author: z.string().nullable(),
          updatedAt: nonBlank,
        })
        .strict(),
    ),
    commentsTruncated: z.boolean(),
    transitionFields: jiraTransitionFieldsSchema,
  })
  .strict();

export const jiraProposalSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("fields"),
      summary: z.string().trim().min(1).max(255).nullable(),
      description: z.string().nullable(),
    })
    .strict()
    .refine((value) => value.summary !== null || value.description !== null, {
      message: "Select at least one Jira field to change",
    }),
  z.object({ kind: z.literal("comment"), body: nonBlank }).strict(),
  z
    .object({
      kind: z.literal("transition"),
      transitionId: nonBlank,
      toStatusId: nonBlank,
      fields: jiraTransitionFieldsSchema,
    })
    .strict(),
]);

export const jiraTransitionFieldSchema = z
  .object({
    id: nonBlank,
    name: z.string(),
    type: z.string(),
    items: z.string().nullable(),
    operations: z.array(z.string()),
    allowedValues: z.array(
      z.object({ label: z.string(), value: z.json() }).strict(),
    ),
    defaultValue: z.json(),
    unsupportedReason: z.string().nullable(),
  })
  .strict();

export const jiraTransitionSchema = z
  .object({
    id: nonBlank,
    name: z.string(),
    toStatusId: nonBlank,
    toStatusName: z.string(),
    fields: z.array(jiraTransitionFieldSchema),
  })
  .strict();

export const jiraChangeSchema = z
  .object({
    field: nonBlank,
    base: z.string().nullable(),
    current: z.string().nullable(),
    proposed: z.string(),
    conflict: z.boolean(),
  })
  .strict();

export const jiraPreviewSchema = z
  .object({
    id: nonBlank,
    revision,
    createdAt: nonBlank,
    changes: z.array(jiraChangeSchema),
    canPush: z.boolean(),
    reason: z.string().nullable(),
  })
  .strict();

export const jiraOperationSchema = z
  .object({
    id: nonBlank,
    kind: z.enum(["fields", "comment", "transition"]),
    state: z.enum(["prepared", "sending", "applied", "uncertain", "failed"]),
    createdAt: nonBlank,
    finishedAt: z.string().nullable(),
    message: z.string().nullable(),
    externalCommentId: z.string().nullable(),
  })
  .strict();

export const jiraSourceSchema = z
  .object({
    taskId: idSchema,
    taskKey: nonBlank,
    connectionId: nonBlank,
    revision,
    baseline: jiraSnapshotSchema,
    remote: jiraSnapshotSchema,
    proposal: jiraProposalSchema.nullable(),
    preview: jiraPreviewSchema.nullable(),
    operation: jiraOperationSchema.nullable(),
    lastError: z.string().nullable(),
  })
  .strict();

export const jiraSearchInputSchema = z
  .object({
    connectionId: nonBlank,
    jql: nonBlank.max(10_000),
    nextPageToken: z.string().min(1).max(4096).nullable(),
    limit: z.number().int().min(1).max(100),
  })
  .strict();

export const jiraSearchIssueSchema = z
  .object({
    id: z.string().regex(/^[0-9]+$/),
    key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*-[0-9]+$/),
    url: z.url(),
    summary: z.string(),
    statusId: nonBlank,
    statusName: z.string(),
    statusCategory: nonBlank,
    priority: z.string().nullable(),
    assignee: z.string().nullable(),
    updatedAt: nonBlank,
  })
  .strict();

export const jiraSearchResultSchema = z
  .object({
    issues: z.array(jiraSearchIssueSchema).max(100),
    nextPageToken: z.string().min(1).max(4096).nullable(),
  })
  .strict();

export const jiraLinkSchema = z
  .object({
    issueId: z.string().regex(/^[0-9]+$/),
    taskId: idSchema,
    taskKey: nonBlank,
    projectId: idSchema,
  })
  .strict();

const sourceResult = z.object({ source: jiraSourceSchema }).strict();
const operationResult = sourceResult.extend({ operation: jiraOperationSchema });

export const jiraRpcContract = defineRpcContract({
  jiraConnections: {
    input: z.object({}).strict(),
    output: z.object({ connections: z.array(jiraConnectionSchema) }).strict(),
  },
  jiraSearch: {
    input: jiraSearchInputSchema,
    output: jiraSearchResultSchema,
  },
  jiraLinks: {
    input: z
      .object({
        connectionId: nonBlank,
        issueIds: z.array(z.string().regex(/^[0-9]+$/)).max(100),
      })
      .strict(),
    output: z.object({ links: z.array(jiraLinkSchema).max(100) }).strict(),
  },
  jiraSource: {
    input: taskInput,
    output: z.object({ source: jiraSourceSchema.nullable() }).strict(),
  },
  jiraImport: {
    input: z
      .object({
        connectionId: nonBlank,
        issue: nonBlank,
        projectId: idSchema,
        taskId: idSchema.nullable(),
      })
      .strict(),
    output: sourceResult.extend({ created: z.boolean() }),
  },
  jiraPull: { input: revisionInput, output: sourceResult },
  jiraDraft: {
    input: revisionInput.extend({ proposal: jiraProposalSchema.nullable() }),
    output: sourceResult,
  },
  jiraTransitions: {
    input: taskInput,
    output: z.object({ transitions: z.array(jiraTransitionSchema) }).strict(),
  },
  jiraPreview: {
    input: revisionInput,
    output: sourceResult.extend({ preview: jiraPreviewSchema }),
  },
  jiraPush: {
    input: taskInput.extend({ previewId: nonBlank }),
    output: operationResult,
  },
  jiraReconcile: {
    input: taskInput.extend({ operationId: nonBlank }),
    output: operationResult,
  },
});

export type JiraRpcContract = typeof jiraRpcContract;
export type JiraConnection = z.infer<typeof jiraConnectionSchema>;
export type JiraSnapshot = z.infer<typeof jiraSnapshotSchema>;
export type JiraProposal = z.infer<typeof jiraProposalSchema>;
export type JiraTransition = z.infer<typeof jiraTransitionSchema>;
export type JiraTransitionField = z.infer<typeof jiraTransitionFieldSchema>;
export type JiraChange = z.infer<typeof jiraChangeSchema>;
export type JiraPreview = z.infer<typeof jiraPreviewSchema>;
export type JiraOperation = z.infer<typeof jiraOperationSchema>;
export type JiraSource = z.infer<typeof jiraSourceSchema>;
export type JiraSearchInput = z.infer<typeof jiraSearchInputSchema>;
export type JiraSearchResult = z.infer<typeof jiraSearchResultSchema>;
export type JiraLink = z.infer<typeof jiraLinkSchema>;
