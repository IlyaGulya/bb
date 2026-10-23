import { z } from "zod";
import type { Configuration } from "./contract.js";

const timestamp = z.string().regex(/^\d{1,16}\.\d{1,6}$/);
const messageSchema = z.object({
  ts: timestamp,
  thread_ts: timestamp.optional(),
  text: z.string().max(1000000).default(""),
  user: z.string().optional(),
  bot_id: z.string().optional(),
  subtype: z.string().optional(),
  edited: z.object({ ts: timestamp }).optional(),
});
const eventSchema = z.looseObject({
  type: z.string(),
  channel: z.string().optional(),
  subtype: z.string().optional(),
  event_ts: timestamp.optional(),
  ts: timestamp.optional(),
  deleted_ts: timestamp.optional(),
  message: messageSchema.optional(),
  previous_message: messageSchema.optional(),
});
const bodySchema = z.object({
  team_id: z.string(),
  event_id: z.string().min(1),
  event: eventSchema,
});
export type MessageChange = {
  team: string;
  recipient: string;
  channel: string;
  ts: string;
  thread: string | null;
  version: string;
  text: string;
  deleted: boolean;
  mentioned: boolean;
};
export type ParsedEvent =
  | { outcome: "ignored" }
  | { outcome: "invalid" }
  | { outcome: "message"; id: string; change: MessageChange };
export function orderTimestamp(value: string): string {
  const [seconds, micros = ""] = value.split(".");
  return `${seconds!.padStart(16, "0")}.${micros.padEnd(6, "0")}`;
}
const humanSubtypes: Record<string, true | undefined> = {
  file_share: true,
  thread_broadcast: true,
  me_message: true,
};
export function parseEvent(body: unknown, config: Configuration): ParsedEvent {
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return { outcome: "invalid" };
  const { team_id: team, event_id: id, event } = parsed.data;
  if (
    team !== config.teamId ||
    event.type !== "message" ||
    !event.channel ||
    !config.conversations.some((row) => row.id === event.channel)
  )
    return { outcome: "ignored" };
  const channel = event.channel;
  if (event.subtype === "message_deleted") {
    if (!event.deleted_ts || !event.event_ts) return { outcome: "invalid" };
    return {
      outcome: "message",
      id,
      change: {
        team,
        recipient: config.userId,
        channel,
        ts: event.deleted_ts,
        thread: event.previous_message?.thread_ts ?? null,
        version: orderTimestamp(event.event_ts),
        text: "",
        deleted: true,
        mentioned: false,
      },
    };
  }
  if (
    event.subtype &&
    event.subtype !== "message_changed" &&
    humanSubtypes[event.subtype] !== true
  )
    return { outcome: "ignored" };
  const candidate =
    event.subtype === "message_changed"
      ? messageSchema.safeParse(event.message)
      : messageSchema.safeParse(event);
  if (!candidate.success) return { outcome: "invalid" };
  const message = candidate.data;
  const human =
    !!message.user &&
    message.user !== config.userId &&
    !message.bot_id &&
    (!message.subtype || humanSubtypes[message.subtype] === true);
  const mentioned = human && message.text.includes(`<@${config.userId}>`);
  const version =
    event.subtype === "message_changed"
      ? (message.edited?.ts ?? event.event_ts)
      : message.ts;
  if (!version) return { outcome: "invalid" };
  return {
    outcome: "message",
    id,
    change: {
      team,
      recipient: config.userId,
      channel,
      ts: message.ts,
      thread: message.thread_ts ?? message.ts,
      version: orderTimestamp(version),
      text: mentioned ? message.text : "",
      deleted: false,
      mentioned,
    },
  };
}
