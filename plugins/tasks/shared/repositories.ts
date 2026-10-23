import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { idSchema } from "./contract";

const text = z.string().trim().min(1);
const absolutePath = text.max(4096).refine(
  (value) =>
    value.startsWith("/") &&
    !/[\u0000-\u001f\u007f\\]/u.test(value) &&
    value
      .slice(1)
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== ".."),
  "Use a canonical absolute path, without traversal or trailing slash",
);
const relativePath = text
  .max(4096)
  .refine(
    (value) =>
      !/[\u0000-\u001f\u007f:\\]/u.test(value) &&
      value
        .split("/")
        .every(
          (part) =>
            part !== "" &&
            part !== "." &&
            part !== ".." &&
            part.toLowerCase() !== ".git",
        ),
    "Use a confined repository-relative path",
  );
const branch = text.refine(
  (value) =>
    !/[\s~^:?*\[\\\u0000-\u001f\u007f]/u.test(value) &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.startsWith("-") &&
    value !== "@" &&
    value
      .split("/")
      .every(
        (part) =>
          part !== "" &&
          !part.startsWith(".") &&
          !part.endsWith(".") &&
          !part.endsWith(".lock"),
      ),
  "Use a valid isolated Git branch",
);
const repositoryRemoteBaseSchema = z
  .object({
    url: text.max(4096).refine((value) => {
      if (/[\s\u0000-\u001f\u007f\\]/u.test(value)) return false;
      if (!value.includes("://"))
        return (
          !value.startsWith("file:") &&
          /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9.-]*:[A-Za-z0-9_./-]+$/u.test(
            value,
          )
        );
      try {
        const url = new URL(value);
        return (
          (url.protocol === "https:" || url.protocol === "ssh:") &&
          !!url.hostname &&
          url.pathname !== "/" &&
          !url.password &&
          !url.search &&
          !url.hash &&
          (url.protocol === "ssh:"
            ? /^[A-Za-z0-9._-]*$/u.test(url.username)
            : !url.username)
        );
      } catch {
        return false;
      }
    }, "Approve a credential-free HTTPS or SSH Git origin; credentials must remain target-local"),
    ref: branch.refine(
      (value) => /^refs\/(?:heads|tags)\//u.test(value),
      "Use an explicit published refs/heads/* or refs/tags/* ref",
    ),
    head: text.regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
  })
  .strict();
export const repositoryBindingSchema = z
  .object({
    id: text.regex(/^[a-zA-Z0-9_-]+$/u),
    bbProjectId: text.startsWith("proj_"),
    role: text,
    owner: text,
    required: z.boolean(),
    sourceEnvironmentId: text,
    sourceHostId: text,
    sourcePath: absolutePath,
    sourceBranch: text.nullable(),
    sourceHead: text.regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
    targetHostId: text,
    targetPath: absolutePath,
    branch,
    presetId: idSchema,
    instructions: text,
    instructionPaths: z.array(relativePath).min(1).max(100),
    includePaths: z.array(relativePath).max(10000),
    remoteBase: repositoryRemoteBaseSchema.optional(),
  })
  .strict()
  .refine(
    (binding) => binding.branch !== binding.sourceBranch,
    "Choose an isolated branch, not the source branch",
  );
export type RepositoryBinding = z.infer<typeof repositoryBindingSchema>;
export const repositoryBindingsSchema = z
  .array(repositoryBindingSchema)
  .min(2)
  .max(32)
  .superRefine((bindings, ctx) => {
    if (!bindings[0]?.required)
      ctx.addIssue({
        code: "custom",
        message:
          "The first repository is the primary workspace and must be required",
      });
    if (
      bindings.some(
        (binding) =>
          binding.targetHostId !== bindings[0]?.targetHostId ||
          binding.presetId !== bindings[0]?.presetId,
      )
    )
      ctx.addIssue({
        code: "custom",
        message:
          "One coherent executor requires all target repositories on the same host and using the same execution profile",
      });
    const seen = new Set<string>();
    for (const binding of bindings) {
      if (seen.has(binding.id))
        ctx.addIssue({
          code: "custom",
          message: `Duplicate repository id: ${binding.id}`,
        });
      seen.add(binding.id);
    }
    const roots = bindings.flatMap((binding) => [
      { host: binding.sourceHostId, path: binding.sourcePath },
      { host: binding.targetHostId, path: binding.targetPath },
    ]);
    for (let i = 0; i < roots.length; i++)
      for (let j = i + 1; j < roots.length; j++) {
        const a = roots[i]!;
        const b = roots[j]!;
        if (
          a.host === b.host &&
          (a.path === b.path ||
            a.path.startsWith(`${b.path}/`) ||
            b.path.startsWith(`${a.path}/`))
        )
          ctx.addIssue({
            code: "custom",
            message: `Repository roots overlap on ${a.host}: ${a.path} and ${b.path}`,
          });
      }
  });
export const repositoryReceiptSchema = z
  .object({
    binding: repositoryBindingSchema,
    state: z.enum([
      "pending",
      "preparing",
      "ready",
      "failed",
      "interrupted",
      "spawning",
      "started",
    ]),
    transferOperationId: text.nullable(),
    environmentId: text.nullable(),
    threadId: text.nullable(),
    head: text.nullable(),
    handoff: z.string(),
    error: z.string().nullable(),
    attempts: z.array(
      z
        .object({
          targetHostId: text,
          targetPath: absolutePath,
          transferOperationId: text.nullable(),
          environmentId: text.nullable(),
          error: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type RepositoryReceipt = z.infer<typeof repositoryReceiptSchema>;
export const repositoryCheckpointSchema = z
  .object({
    id: text,
    taskId: idSchema,
    state: z.enum(["preparing", "partial", "ready", "starting", "started"]),
    createdAt: text,
    updatedAt: text,
    roots: z.array(repositoryReceiptSchema),
  })
  .strict();
export type RepositoryCheckpoint = z.infer<typeof repositoryCheckpointSchema>;
export const repositoryRpcContract = defineRpcContract({
  inspectTaskRepository: {
    input: z
      .object({
        taskId: idSchema,
        bbProjectId: text.startsWith("proj_"),
        sourceEnvironmentId: text,
        targetHostId: text,
      })
      .strict(),
    output: z
      .object({
        sourceHostId: text,
        sourcePath: absolutePath,
        sourceBranch: text.nullable(),
        sourceHead: text,
        activeThreadIds: z.array(text),
        remoteBaseCandidates: z
          .array(repositoryRemoteBaseSchema)
          .max(8)
          .optional(),
        files: z.array(
          z
            .object({
              path: text,
              kind: text,
              tracked: z.boolean(),
              selectedByDefault: z.boolean(),
              excludedReason: z.string().nullable(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  prepareTaskRepositories: {
    input: z
      .object({
        taskId: idSchema,
        bindings: repositoryBindingsSchema,
        checkpointId: text.optional(),
      })
      .strict(),
    output: repositoryCheckpointSchema,
  },
  getTaskRepositories: {
    input: z.object({ taskId: idSchema }).strict(),
    output: z
      .object({ checkpoints: z.array(repositoryCheckpointSchema) })
      .strict(),
  },
  continueTaskRepositories: {
    input: z.object({ taskId: idSchema, checkpointId: text }).strict(),
    output: repositoryCheckpointSchema,
  },
});
export type RepositoryRpcContract = typeof repositoryRpcContract;
