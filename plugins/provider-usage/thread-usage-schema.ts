import { z } from "zod/mini";
import { providerUsageSchema } from "./usage-schema.js";

const nameSchema = z.string().check(z.minLength(1));
export const threadUsageInputSchema = z.strictObject({
  threadId: nameSchema,
  force: z.boolean(),
});
export const threadUsageSchema = z.strictObject({
  threadId: nameSchema,
  bindingCreatedAt: z.nullable(z.number().check(z.int(), z.nonnegative())),
  connection: z.nullable(z.strictObject({
    id: nameSchema,
    name: nameSchema,
    providerId: nameSchema,
    providerName: nameSchema,
    kind: z.enum(["native", "gateway"]),
    definition: z.enum(["active", "changed", "missing", "unknown", "revoked", "disabled"]),
  })),
  host: z.nullable(z.strictObject({ id: nameSchema, name: nameSchema })),
  state: z.enum(["available", "exhausted", "unknown", "unsupported", "stale", "unauthenticated", "expired", "not_installed", "revoked", "disabled", "missing"]),
  reason: nameSchema,
  source: z.nullable(z.strictObject({
    pluginId: nameSchema,
    name: nameSchema,
    resourceId: nameSchema,
  })),
  observedAt: z.nullable(z.number().check(z.int(), z.nonnegative())),
  usage: z.nullable(providerUsageSchema),
});
export type ThreadUsage = z.infer<typeof threadUsageSchema>;
export type ThreadUsageInput = z.infer<typeof threadUsageInputSchema>;
