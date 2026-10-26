import { z } from "zod";

const stringMap = z.record(z.string(), z.string());
const claudeOptions = {
  timeout: z.number().positive().optional(),
  alwaysLoad: z.boolean().optional(),
};
const stdioFields = {
  type: z.literal("stdio").optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: stringMap.optional(),
};
export const claudeSelectedMcpSchema = z.union([
  z.object({ ...stdioFields, ...claudeOptions }).strict(),
  z
    .object({
      type: z.enum(["http", "sse"]),
      url: z.url(),
      headers: stringMap.optional(),
      ...claudeOptions,
    })
    .strict(),
]);
export const claudeMcpConfigSchema = z
  .object({
    mcpServers: z.record(z.string(), z.unknown()),
  })
  .strict();
export const ompSelectedMcpSchema = z.union([
  z.object(stdioFields).strict(),
  z
    .object({
      type: z.enum(["http", "sse"]),
      url: z.url().refine((url) => {
        const parsed = new URL(url);
        return (
          ["http:", "https:"].includes(parsed.protocol) &&
          !parsed.username &&
          !parsed.password
        );
      }),
      headers: stringMap.optional(),
    })
    .strict(),
]);
export const ompMcpConfigSchema = z
  .object({
    $schema: z.string().optional(),
    mcpServers: z.record(z.string(), z.unknown()),
  })
  .strict();
