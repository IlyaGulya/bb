import { z } from "zod";

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
