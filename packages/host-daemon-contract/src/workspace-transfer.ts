import { z } from "zod";

export const WORKSPACE_TRANSFER_MAX_BYTES = 64 * 1024 * 1024;
export const WORKSPACE_TRANSFER_MAX_SERIALIZED_BYTES = 96 * 1024 * 1024;
export const WORKSPACE_TRANSFER_MAX_FILES = 100_000;
export const workspaceRemoteBaseSchema = z
  .object({
    url: z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .refine((value) => {
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
      }, "Approve a credential-free HTTPS or SSH Git origin; local paths, embedded credentials and URL query tokens are forbidden"),
    ref: z
      .string()
      .min(1)
      .max(1024)
      .refine(
        (value) =>
          /^refs\/(?:heads|tags)\//u.test(value) &&
          !/[\s~^:?*\[\\\u0000-\u001f\u007f]/u.test(value) &&
          !value.includes("..") &&
          !value.includes("@{") &&
          value
            .split("/")
            .every(
              (part) =>
                part !== "" &&
                !part.startsWith(".") &&
                !part.endsWith(".") &&
                !part.endsWith(".lock"),
            ),
        "Use an explicit published refs/heads/* or refs/tags/* ref",
      ),
    head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
  })
  .strict();
export type WorkspaceRemoteBase = z.infer<typeof workspaceRemoteBaseSchema>;
const base64Schema = z
  .string()
  .max(Math.ceil(WORKSPACE_TRANSFER_MAX_BYTES / 3) * 4)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/u)
  .refine(
    (value) => value.length % 4 === 0,
    "Base64 content must contain complete padded groups",
  );
export const workspaceTransferPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !/[\u0000-\u001f\u007f:]/u.test(value) &&
      value
        .split("/")
        .every(
          (part) =>
            part !== "" &&
            part !== "." &&
            part !== ".." &&
            part.toLowerCase() !== ".git",
        ),
    "Use a confined relative file path without .git, traversal, or control characters",
  );
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const permissionsSchema = z.number().int().min(0).max(0o777);
export const workspaceTransferFileSchema = z
  .object({
    path: workspaceTransferPathSchema,
    contentBase64: base64Schema,
    mode: z.enum(["100644", "100755", "120000"]),
    permissions: permissionsSchema,
    sha256: hashSchema,
  })
  .strict()
  .refine(
    (file) =>
      file.mode === "120000"
        ? file.permissions === 0o777
        : file.mode === (file.permissions & 0o100 ? "100755" : "100644"),
    "File permissions must match the Git executable mode",
  );
export type WorkspaceTransferFile = z.infer<typeof workspaceTransferFileSchema>;
export const workspaceCheckpointSchema = z
  .object({
    version: z.literal(1),
    head: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u),
    branch: z.string().min(1).nullable(),
    remoteBase: workspaceRemoteBaseSchema.optional(),
    publishedContextPaths: z
      .array(workspaceTransferPathSchema)
      .max(WORKSPACE_TRANSFER_MAX_FILES)
      .optional(),
    bundleBase64: base64Schema,
    bundleSha256: hashSchema,
    lfsPaths: z
      .array(workspaceTransferPathSchema)
      .max(WORKSPACE_TRANSFER_MAX_FILES),
    publishedLfsFiles: z
      .array(
        z
          .object({
            path: workspaceTransferPathSchema,
            oid: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
            mode: z.enum(["100644", "100755"]),
          })
          .strict(),
      )
      .max(WORKSPACE_TRANSFER_MAX_FILES)
      .optional(),
    index: z
      .array(
        z
          .object({
            path: workspaceTransferPathSchema,
            mode: z.enum(["100644", "100755", "120000"]),
            oid: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u),
            intentToAdd: z.boolean(),
            contentBase64: base64Schema.optional(),
            sha256: hashSchema.optional(),
          })
          .strict()
          .refine(
            (entry) =>
              (entry.contentBase64 === undefined) ===
              (entry.sha256 === undefined),
            "Index content and sha256 must be supplied together",
          ),
      )
      .max(WORKSPACE_TRANSFER_MAX_FILES),
    filePermissions: z
      .array(
        z
          .object({
            path: workspaceTransferPathSchema,
            permissions: permissionsSchema,
          })
          .strict(),
      )
      .max(WORKSPACE_TRANSFER_MAX_FILES),
    worktree: z
      .array(
        z
          .object({
            path: workspaceTransferPathSchema,
            file: workspaceTransferFileSchema.nullable(),
          })
          .strict(),
      )
      .max(WORKSPACE_TRANSFER_MAX_FILES),
    extraFiles: z
      .array(workspaceTransferFileSchema)
      .max(WORKSPACE_TRANSFER_MAX_FILES),
  })
  .strict();
export type WorkspaceCheckpoint = z.infer<typeof workspaceCheckpointSchema>;
export const workspaceTransferPreviewResultSchema = z
  .object({
    head: z.string(),
    branch: z.string().nullable(),
    files: z
      .array(
        z
          .object({
            path: workspaceTransferPathSchema,
            kind: z.enum([
              "tracked",
              "sensitive-tracked",
              "untracked",
              "ignored",
            ]),
            tracked: z.boolean(),
            selectedByDefault: z.boolean(),
            excludedReason: z.string().optional(),
          })
          .strict(),
      )
      .max(WORKSPACE_TRANSFER_MAX_FILES),
    activeThreadIds: z.array(z.string()),
    remoteBaseCandidates: z.array(workspaceRemoteBaseSchema).max(8).optional(),
    maxPayloadBytes: z.literal(WORKSPACE_TRANSFER_MAX_BYTES),
  })
  .strict();
export type WorkspaceTransferPreviewResult = z.infer<
  typeof workspaceTransferPreviewResultSchema
>;
const rootPath = z.string().min(1);
export const workspaceTransferCommandSchemas = {
  "workspace.transferPreview": z
    .object({ type: z.literal("workspace.transferPreview"), rootPath })
    .strict(),
  "workspace.capture": z
    .object({
      type: z.literal("workspace.capture"),
      rootPath,
      remoteBase: workspaceRemoteBaseSchema.optional(),
      includePaths: z
        .array(workspaceTransferPathSchema)
        .max(WORKSPACE_TRANSFER_MAX_FILES),
    })
    .strict(),
  "workspace.restore": z
    .object({
      type: z.literal("workspace.restore"),
      targetPath: rootPath,
      checkpoint: workspaceCheckpointSchema,
      branch: z.string().min(1).optional(),
    })
    .strict(),
  "workspace.copyRead": z
    .object({
      type: z.literal("workspace.copyRead"),
      rootPath,
      paths: z
        .array(workspaceTransferPathSchema)
        .max(WORKSPACE_TRANSFER_MAX_FILES),
    })
    .strict(),
  "workspace.copyWrite": z
    .object({
      type: z.literal("workspace.copyWrite"),
      rootPath,
      files: z
        .array(workspaceTransferFileSchema)
        .max(WORKSPACE_TRANSFER_MAX_FILES),
    })
    .strict(),
};
export const workspaceTransferResultSchemas = {
  "workspace.transferPreview": workspaceTransferPreviewResultSchema,
  "workspace.capture": z
    .object({ checkpoint: workspaceCheckpointSchema })
    .strict(),
  "workspace.restore": z
    .object({ rootPath, head: z.string(), branch: z.string().nullable() })
    .strict(),
  "workspace.copyRead": z
    .object({
      files: z
        .array(workspaceTransferFileSchema)
        .max(WORKSPACE_TRANSFER_MAX_FILES),
    })
    .strict(),
  "workspace.copyWrite": z
    .object({
      files: z
        .array(
          z
            .object({ path: workspaceTransferPathSchema, sha256: hashSchema })
            .strict(),
        )
        .max(WORKSPACE_TRANSFER_MAX_FILES),
    })
    .strict(),
};
