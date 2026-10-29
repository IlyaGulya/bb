import { z } from "zod";

export const AI_TASKS = ["thread-title", "commit-message", "voice", "task-route"] as const;
export const aiTaskSchema = z.enum(AI_TASKS);
export type AiTask = z.infer<typeof aiTaskSchema>;

export const AI_TEXT_TASKS = ["thread-title", "commit-message"] as const;
export const aiTextTaskSchema = z.enum(AI_TEXT_TASKS);
export type AiTextTask = z.infer<typeof aiTextTaskSchema>;

export const aiServiceSelectionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("automatic") }).strict(),
  z.object({ mode: z.literal("off") }).strict(),
  z
    .object({
      mode: z.literal("service"),
      pluginId: z.string().min(1),
      serviceId: z.string().min(1),
    })
    .strict(),
]);
export type AiServiceSelection = z.infer<typeof aiServiceSelectionSchema>;

export const aiServiceSelectionsSchema = z
  .object({
    "thread-title": aiServiceSelectionSchema,
    "commit-message": aiServiceSelectionSchema,
    voice: aiServiceSelectionSchema,
    "task-route": aiServiceSelectionSchema.default({ mode: "off" }),
  })
  .strict();
export type AiServiceSelections = z.infer<typeof aiServiceSelectionsSchema>;

export const defaultAiServiceSelections: AiServiceSelections = {
  "thread-title": { mode: "automatic" },
  "commit-message": { mode: "automatic" },
  voice: { mode: "automatic" },
  "task-route": { mode: "off" },
};

export const aiServiceStatusSchema = z.discriminatedUnion("ready", [
  z.object({ ready: z.literal(true) }).strict(),
  z.object({ ready: z.literal(false), message: z.string().min(1) }).strict(),
]);
export type AiServiceStatus = z.infer<typeof aiServiceStatusSchema>;
const taskRouteIdSchema = z.string().trim().min(1).max(200);
export const taskRouteRequestSchema = z.object({
  text: z.string().trim().min(1).max(16000),
  candidates: z.array(z.object({
    id: taskRouteIdSchema,
    key: taskRouteIdSchema,
    title: z.string().max(1000),
    projectId: taskRouteIdSchema,
  }).strict()).max(20),
  projects: z.array(z.object({ id: taskRouteIdSchema, name: z.string().max(1000) }).strict()).max(20),
}).strict();
export type TaskRouteRequest = z.infer<typeof taskRouteRequestSchema>;
const taskRouteReasonSchema = z.string().trim().min(1).max(2000);
export const taskRouteClassificationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), taskId: taskRouteIdSchema, reason: taskRouteReasonSchema }).strict(),
  z.object({ kind: z.literal("new"), projectId: taskRouteIdSchema, reason: taskRouteReasonSchema }).strict(),
  z.object({ kind: z.literal("clarify"), question: z.string().trim().min(12).max(2000), reason: taskRouteReasonSchema }).strict(),
  z.object({ kind: z.literal("unavailable"), reason: taskRouteReasonSchema }).strict(),
]);
export const taskRouteDecisionSchema = z.discriminatedUnion("kind", [
  ...taskRouteClassificationSchema.options,
  z.object({ kind: z.literal("existing-thread"), threadId: taskRouteIdSchema, reason: taskRouteReasonSchema }).strict(),
]);
export type TaskRouteDecision = z.infer<typeof taskRouteDecisionSchema>;
export const taskRouteResponseSchema = z.object({
  decision: taskRouteClassificationSchema,
  service: z.object({ pluginId: taskRouteIdSchema, serviceId: taskRouteIdSchema, name: z.string() }).nullable(),
  callbackInvocations: z.union([z.literal(0), z.literal(1)]),
  limitation: z.string(),
});
export type TaskRouteResponse = z.infer<typeof taskRouteResponseSchema>;
