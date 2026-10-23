import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const conversationSchema = z
  .object({
    id: z.string().regex(/^[CDG][A-Z0-9]+$/),
    kind: z.enum(["public", "private", "im", "mpim"]),
  })
  .strict();
export const configurationSchema = z
  .object({
    enabled: z.boolean(),
    approved: z.boolean(),
    teamId: z
      .string()
      .regex(/^T[A-Z0-9]+$/)
      .or(z.literal("")),
    userId: z
      .string()
      .regex(/^[UW][A-Z0-9]+$/)
      .or(z.literal("")),
    context: z.enum(["work", "personal", "unknown"]),
    conversations: z
      .array(conversationSchema)
      .max(100)
      .refine(
        (rows) => new Set(rows.map((row) => row.id)).size === rows.length,
        "Conversation IDs must be unique",
      ),
  })
  .strict();
export type Configuration = z.infer<typeof configurationSchema>;
export const defaultConfiguration: Configuration = {
  enabled: false,
  approved: false,
  teamId: "",
  userId: "",
  context: "unknown",
  conversations: [],
};
export const coverageSchema = conversationSchema.extend({
  state: z.enum(["unchecked", "accessible", "unavailable"]),
  error: z.string().nullable(),
  checkedAt: z.number().nullable(),
  lastEventAt: z.number().nullable(),
});
export type Coverage = z.infer<typeof coverageSchema>;
export const gapSchema = z.object({
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  reason: z.string(),
});
export const statusSchema = z.object({
  configuration: configurationSchema,
  credentials: z.object({ appToken: z.boolean(), botToken: z.boolean() }),
  connection: z.enum([
    "disabled",
    "unconfigured",
    "connecting",
    "connected",
    "disconnected",
    "error",
  ]),
  error: z.string().nullable(),
  lastEventAt: z.number().nullable(),
  pending: z.number(),
  receivedDiscussions: z.number(),
  deliveryError: z.string().nullable(),
  coverage: z.array(coverageSchema),
  gaps: z.array(gapSchema),
  limitations: z.array(z.string()),
});
export type Status = z.infer<typeof statusSchema>;
export const slackInboxRpc = defineRpcContract({
  status: { input: z.null(), output: statusSchema },
  configure: { input: configurationSchema, output: statusSchema },
  checkCoverage: { input: z.null(), output: statusSchema },
  retry: { input: z.null(), output: statusSchema },
});
export const LIMITATIONS = [
  "Only explicitly selected conversations visible to this dedicated bot are covered. A bot cannot read your other human-to-human DMs.",
  "Subscribe to the selected message.channels, message.groups, message.im and/or message.mpim events, not app_mention. Event subscriptions cannot be verified through the bot API; accessible does not prove event delivery.",
  "No history backfill: disconnected periods, initial setup, permission changes and Slack delivery loss can leave gaps. Slack retries are finite. Never assume all mentions were received.",
  "Received source is not accepted work. Review, resolve, snooze, link or create a task through the existing Inbox human actions. Intake never dispatches a task or executes message text.",
  "Only explicit human mentions are retained; removed mentions and deleted messages withdraw their source attention, not linked tasks. Message excerpts are bounded; open Slack for the full discussion.",
];
export function prerequisites(
  configuration: Configuration,
  appToken: string,
  botToken: string,
): string | null {
  if (!configuration.approved) return "approval_required";
  if (
    !configuration.teamId ||
    !configuration.userId ||
    configuration.conversations.length === 0
  )
    return "scope_required";
  if (!appToken.startsWith("xapp-") || !botToken.startsWith("xoxb-"))
    return "dedicated_tokens_required";
  return null;
}
