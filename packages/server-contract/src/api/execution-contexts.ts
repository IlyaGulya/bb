import { z } from "zod";
import { executionContextFieldsSchema, modelConnectionFieldsSchema, projectContextDefaultsSchema } from "@bb/domain";

export const contextIdRequestSchema = z.object({ id: z.string().min(1) }).strict();
export const projectContextRequestSchema = z.object({ projectId: z.string().min(1) }).strict();
export const threadBindingRequestSchema = z.object({ threadId: z.string().min(1) }).strict();
export const createExecutionContextRequestSchema = executionContextFieldsSchema;
export type CreateExecutionContextRequest = z.input<typeof createExecutionContextRequestSchema>;
export type ParsedCreateExecutionContextRequest = z.output<typeof createExecutionContextRequestSchema>;
export const updateExecutionContextRequestSchema = z.object({
  id: z.string().min(1),
  name: executionContextFieldsSchema.shape.name.optional(),
  enabled: executionContextFieldsSchema.shape.enabled.removeDefault().optional(),
  projectIds: executionContextFieldsSchema.shape.projectIds.removeDefault().optional(),
  instructions: executionContextFieldsSchema.shape.instructions.removeDefault().optional(),
  skillRoots: executionContextFieldsSchema.shape.skillRoots.removeDefault().optional(),
  commandRoots: executionContextFieldsSchema.shape.commandRoots.removeDefault().optional(),
  pluginRoots: executionContextFieldsSchema.shape.pluginRoots.removeDefault().optional(),
  settingsPaths: executionContextFieldsSchema.shape.settingsPaths.removeDefault().optional(),
  mcpServers: executionContextFieldsSchema.shape.mcpServers.removeDefault().optional(),
  hooksPath: executionContextFieldsSchema.shape.hooksPath.removeDefault().optional(),
  autoMemory: executionContextFieldsSchema.shape.autoMemory.removeDefault().optional(),
  gitIdentity: executionContextFieldsSchema.shape.gitIdentity.removeDefault().optional(),
  defaultModelConnectionId: executionContextFieldsSchema.shape.defaultModelConnectionId.removeDefault().optional(),
}).strict();
export type UpdateExecutionContextRequest = z.infer<typeof updateExecutionContextRequestSchema>;
export const createModelConnectionRequestSchema = modelConnectionFieldsSchema;
export type CreateModelConnectionRequest = z.input<typeof createModelConnectionRequestSchema>;
export type ParsedCreateModelConnectionRequest = z.output<typeof createModelConnectionRequestSchema>;
export const updateModelConnectionRequestSchema = z.object({
  id: z.string().min(1),
  name: modelConnectionFieldsSchema.shape.name.optional(),
  provider: modelConnectionFieldsSchema.shape.provider.optional(),
  hostId: modelConnectionFieldsSchema.shape.hostId.optional(),
  enabled: modelConnectionFieldsSchema.shape.enabled.removeDefault().optional(),
  revoked: modelConnectionFieldsSchema.shape.revoked.removeDefault().optional(),
  nativeAuth: modelConnectionFieldsSchema.shape.nativeAuth.removeDefault().optional(),
}).strict();
export type UpdateModelConnectionRequest = z.infer<typeof updateModelConnectionRequestSchema>;
export const setProjectContextDefaultsRequestSchema = projectContextDefaultsSchema;
export type SetProjectContextDefaultsRequest = z.infer<typeof setProjectContextDefaultsRequestSchema>;
export { executionContextSchema, modelConnectionSchema, projectContextDefaultsSchema, threadExecutionBindingSchema } from "@bb/domain";
export type { ExecutionContext, ModelConnection, ProjectContextDefaults, ThreadExecutionBinding } from "@bb/domain";
