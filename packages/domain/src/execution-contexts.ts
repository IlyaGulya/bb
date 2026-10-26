import { z } from "zod";
import { isAbsoluteHostPath } from "./host-path.js";

const referencePathSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !value.includes("\0"), "Native paths cannot contain NUL");
const idSchema = z.string().trim().min(1);

export const executionContextFieldsSchema = z
  .object({
    name: z.string().trim().min(1),
    enabled: z.boolean().default(true),
    projectIds: z.array(idSchema).default([]),
    instructions: z.string().default(""),
    skillRoots: z.array(referencePathSchema).default([]),
    commandRoots: z.array(referencePathSchema).default([]),
    pluginRoots: z.array(referencePathSchema).default([]),
    settingsPaths: z.array(referencePathSchema).default([]),
    mcpServers: z
      .array(
        z.object({ name: idSchema, configPath: referencePathSchema }).strict(),
      )
      .default([]),
    hooksPath: referencePathSchema.nullable().default(null),
    autoMemory: z.boolean().default(false),
    gitIdentity: z
      .object({ name: z.string().trim().min(1), email: z.email() })
      .strict()
      .nullable()
      .default(null),
    defaultModelConnectionId: idSchema.nullable().default(null),
  })
  .strict();
export const executionContextSchema = executionContextFieldsSchema
  .extend({
    id: idSchema,
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export const executionContextSnapshotSchema = executionContextSchema;
export type ExecutionContext = z.infer<typeof executionContextSchema>;
export type ExecutionContextSnapshot = z.infer<
  typeof executionContextSnapshotSchema
>;

export const modelConnectionFieldsSchema = z
  .object({
    name: z.string().trim().min(1),
    provider: idSchema,
    hostId: idSchema,
    enabled: z.boolean().default(true),
    revoked: z.boolean().default(false),
    nativeAuth: z
      .object({
        configDir: referencePathSchema.nullable().default(null),
        profile: idSchema.nullable().default(null),
        hostEnv: z
          .object({
            brokerUrlEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
            brokerTokenEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
          })
          .strict()
          .nullable()
          .default(null),
      })
      .strict()
      .default({ configDir: null, profile: null, hostEnv: null }),
  })
  .strict();
export const modelConnectionSchema = modelConnectionFieldsSchema
  .extend({
    id: idSchema,
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export const modelConnectionSnapshotSchema = modelConnectionSchema;
export type ModelConnection = z.infer<typeof modelConnectionSchema>;
export type ModelConnectionSnapshot = z.infer<
  typeof modelConnectionSnapshotSchema
>;

export const projectContextDefaultsSchema = z
  .object({
    projectId: idSchema,
    executionContextId: idSchema.nullable(),
    modelConnectionId: idSchema.nullable(),
  })
  .strict();
export type ProjectContextDefaults = z.infer<
  typeof projectContextDefaultsSchema
>;
export const resolvedThreadExecutionBindingSchema = z
  .object({
    executionContext: executionContextSnapshotSchema.nullable(),
    modelConnection: modelConnectionSnapshotSchema.nullable(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type ResolvedThreadExecutionBinding = z.infer<
  typeof resolvedThreadExecutionBindingSchema
>;
export const threadExecutionBindingSchema = resolvedThreadExecutionBindingSchema
  .extend({ threadId: idSchema })
  .strict();
export type ThreadExecutionBinding = z.infer<
  typeof threadExecutionBindingSchema
>;

export const MCP_INSPECTION_MAX_FILES = 16;
export const MCP_INSPECTION_MAX_FILE_BYTES = 1024 * 1024;
export const MCP_INSPECTION_MAX_SERVERS = 250;
export const mcpConfigPathSchema = z.string().min(1)
  .refine((path) => !path.includes("\0") && isAbsoluteHostPath(path), "MCP configuration paths must be absolute and contain no NUL");
export const inspectMcpRequestSchema = z.object({
  hostId: idSchema,
  providerId: idSchema,
  configPaths: z.array(mcpConfigPathSchema).max(MCP_INSPECTION_MAX_FILES),
}).strict();
export type InspectMcpRequest = z.infer<typeof inspectMcpRequestSchema>;
export const mcpInspectionIssueSchema = z.enum([
  "Unsupported provider",
  "Configuration unavailable",
  "Configuration must be a regular file",
  "Configuration exceeds size limit",
  "Invalid JSON configuration",
  "Unsupported configuration structure",
  "Configuration exceeds server limit",
  "Unsupported server descriptor",
  "Reserved server name",
]);
export const mcpServerInspectionSchema = z.object({
  name: z.string(),
  transport: z.enum(["stdio", "http", "sse", "unsupported"]),
  supported: z.boolean(),
  issue: mcpInspectionIssueSchema.nullable(),
  authStatus: z.literal("not_checked"),
}).strict();
export const mcpConfigurationFileInspectionSchema = z.object({
  configPath: mcpConfigPathSchema,
  status: z.enum(["ok", "invalid", "unavailable"]),
  issue: mcpInspectionIssueSchema.nullable(),
  servers: z.array(mcpServerInspectionSchema).max(MCP_INSPECTION_MAX_SERVERS),
}).strict();
export const mcpConfigurationFilesInspectionSchema = z.array(mcpConfigurationFileInspectionSchema).max(MCP_INSPECTION_MAX_FILES);
export const mcpConfigurationInspectionSchema = z.object({
  hostId: idSchema,
  providerId: idSchema,
  files: mcpConfigurationFilesInspectionSchema,
}).strict();
export type McpServerInspection = z.infer<typeof mcpServerInspectionSchema>;
export type McpConfigurationFileInspection = z.infer<typeof mcpConfigurationFileInspectionSchema>;
export type McpConfigurationInspection = z.infer<typeof mcpConfigurationInspectionSchema>;

export function validateSelectedMcpServers(
  refs: readonly { name: string; configPath: string }[],
  inspection: McpConfigurationInspection,
): string | null {
  if (refs.length === 0) return null;
  if (!["claude-code", "acp-omp"].includes(inspection.providerId))
    return "Selected MCP provider is unsupported";
  const names = new Set<string>();
  for (const ref of refs) {
    if (ref.name === "bb-bridge") return "Selected MCP server name is reserved";
    if (names.has(ref.name)) return "Selected MCP server names must be unique";
    names.add(ref.name);
    if (!mcpConfigPathSchema.safeParse(ref.configPath).success)
      return "Selected MCP configuration path must be absolute";
    const files = inspection.files.filter((file) => file.configPath === ref.configPath);
    if (files.length !== 1 || files[0]?.status !== "ok")
      return "Selected MCP configuration is invalid or unavailable";
    const servers = files[0].servers.filter((server) => server.name === ref.name);
    if (servers.length !== 1) return "Selected MCP server is missing";
    if (!servers[0]?.supported || servers[0].transport === "unsupported" || servers[0].issue !== null)
      return "Selected MCP server descriptor is unsupported";
  }
  return null;
}
