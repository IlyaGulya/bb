import { z } from "zod";
import { gitBranchNameSchema, projectSourceSchema } from "@bb/domain";

const relativeFilePathSchema = z
  .string()
  .min(1)
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
    "Choose a confined relative file path, without .git or symlinks",
  );
const targetPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      value.startsWith("/") &&
      !/[\u0000-\u001f\u007f\\]/u.test(value) &&
      value
        .slice(1)
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
    "A canonical absolute path on a Mac or Linux machine is required (no trailing slash, traversal or ~/ abbreviation)",
  );
export const prepareMachineRequestSchema = z
  .object({
    hostId: z.string().min(1),
    targetPath: targetPathSchema,
    sourceHostId: z.string().min(1).optional(),
    copyPaths: z.array(relativeFilePathSchema).max(10000).default([]),
  })
  .strict();
export type PrepareMachineRequest = z.input<typeof prepareMachineRequestSchema>;
export const prepareMachineResponseSchema = z.object({
  source: projectSourceSchema,
  copiedFiles: z.array(z.object({ path: z.string(), sha256: z.string() })),
  readiness: z.object({
    ready: z.boolean(),
    checks: z.array(
      z.object({ name: z.string(), ok: z.boolean(), detail: z.string() }),
    ),
  }),
});
export type PrepareMachineResponse = z.infer<
  typeof prepareMachineResponseSchema
>;
export const previewWorkspaceTransferRequestSchema = z
  .object({
    sourceEnvironmentId: z.string().min(1),
    targetHostId: z.string().min(1),
  })
  .strict();
export type PreviewWorkspaceTransferRequest = z.infer<
  typeof previewWorkspaceTransferRequestSchema
>;
export const previewWorkspaceTransferResponseSchema = z.object({
  sourceEnvironmentId: z.string(),
  sourceHostId: z.string(),
  head: z.string(),
  branch: z.string().nullable(),
  files: z.array(
    z.object({
      path: z.string(),
      kind: z.string(),
      tracked: z.boolean(),
      selectedByDefault: z.boolean(),
      excludedReason: z.string().optional(),
    }),
  ),
  activeThreadIds: z.array(z.string()),
});
export type PreviewWorkspaceTransferResponse = z.infer<
  typeof previewWorkspaceTransferResponseSchema
>;
export const transferWorkspaceRequestSchema =
  previewWorkspaceTransferRequestSchema
    .extend({
      targetPath: targetPathSchema,
      branch: gitBranchNameSchema.optional(),
      includePaths: z.array(relativeFilePathSchema).max(10000),
    })
    .strict();
export type TransferWorkspaceRequest = z.infer<
  typeof transferWorkspaceRequestSchema
>;
const workspaceTransferOperationFields = {
  operationId: z.string(),
  projectId: z.string(),
  sourceEnvironmentId: z.string(),
  sourceHostId: z.string(),
  targetHostId: z.string(),
  targetPath: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
};
export const transferWorkspaceResponseSchema = z.object({
  ...workspaceTransferOperationFields,
  status: z.literal("ready"),
  environmentId: z.string(),
  hostId: z.string(),
  rootPath: z.string(),
  head: z.string(),
  branch: z.string().nullable(),
  handoff: z.string(),
  continuationThreadId: z.string().optional(),
});
export type TransferWorkspaceResponse = z.infer<
  typeof transferWorkspaceResponseSchema
>;
export const workspaceTransferOperationSchema = z.discriminatedUnion("status", [
  transferWorkspaceResponseSchema,
  z.object({
    ...workspaceTransferOperationFields,
    status: z.enum([
      "pending",
      "capturing",
      "transferring",
      "verifying",
      "failed",
      "interrupted",
    ]),
    error: z.string().optional(),
  }),
]);
export type WorkspaceTransferOperation = z.infer<
  typeof workspaceTransferOperationSchema
>;
