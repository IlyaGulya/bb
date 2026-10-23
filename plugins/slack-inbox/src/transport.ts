import { SocketModeClient } from "@slack/socket-mode";
import { WebClient, LogLevel } from "@slack/web-api";
import { z } from "zod";
import type { Configuration, Coverage } from "./contract.js";

export type Envelope = { body: unknown; ack: () => Promise<void> };
export interface SlackTransport {
  authenticate(): Promise<{ teamId: string; botId: string }>;
  conversation(
    id: string,
  ): Promise<{ kind: Coverage["kind"]; member: boolean; archived: boolean }>;
  onEnvelope(handler: (envelope: Envelope) => void): void;
  onConnection(handler: (connected: boolean) => void): void;
  onError(handler: () => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}
const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  setLevel: () => undefined,
  setName: () => undefined,
  getLevel: () => LogLevel.ERROR,
};
export function createSlackTransport(
  appToken: string,
  botToken: string,
  slackApiUrl?: string,
): SlackTransport {
  const options = {
    logger: silentLogger,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    ...(slackApiUrl ? { slackApiUrl } : {}),
  };
  const web = new WebClient(botToken, options);
  const socket = new SocketModeClient({
    appToken,
    logger: silentLogger,
    clientOptions: options,
  });
  return {
    async authenticate() {
      const result = z
        .object({ team_id: z.string(), bot_id: z.string() })
        .parse(await web.auth.test());
      return { teamId: result.team_id, botId: result.bot_id };
    },
    async conversation(id) {
      const result = await web.conversations.info({ channel: id });
      const channel = z
        .object({
          is_im: z.boolean().optional(),
          is_mpim: z.boolean().optional(),
          is_private: z.boolean().optional(),
          is_member: z.boolean().optional(),
          is_archived: z.boolean().optional(),
        })
        .parse(result.channel);
      return {
        kind: channel.is_im
          ? "im"
          : channel.is_mpim
            ? "mpim"
            : channel.is_private
              ? "private"
              : "public",
        member: channel.is_im === true || channel.is_member === true,
        archived: channel.is_archived === true,
      };
    },
    onEnvelope(handler) {
      socket.on("slack_event", (event: unknown) => {
        if (
          !event ||
          typeof event !== "object" ||
          !("ack" in event) ||
          typeof event.ack !== "function" ||
          !("body" in event)
        )
          return;
        const ack = event.ack;
        handler({
          body: event.body,
          ack: async () => {
            await ack({});
          },
        });
      });
    },
    onConnection(handler) {
      socket.on("connected", () => handler(true));
      socket.on("disconnected", () => handler(false));
      socket.on("reconnecting", () => handler(false));
    },
    onError(handler) {
      socket.on("error", handler);
    },
    async start() {
      await socket.start();
    },
    async stop() {
      await socket.disconnect();
    },
  };
}
export function safeSlackError(error: unknown): string {
  const parsed = z
    .object({ data: z.object({ error: z.string() }) })
    .safeParse(error);
  const code = parsed.success ? parsed.data.data.error : "";
  return [
    "missing_scope",
    "not_in_channel",
    "channel_not_found",
    "invalid_auth",
    "token_revoked",
    "account_inactive",
    "not_authed",
    "ratelimited",
    "restricted_action",
  ].includes(code)
    ? code
    : "slack_api_unavailable";
}
export async function inspectCoverage(
  transport: SlackTransport,
  configuration: Configuration,
  now: () => number = Date.now,
): Promise<Coverage[]> {
  const results: Coverage[] = [];
  for (const row of configuration.conversations) {
    try {
      const actual = await transport.conversation(row.id);
      const error =
        actual.kind !== row.kind
          ? "conversation_type_mismatch"
          : !actual.member
            ? "not_in_channel"
            : actual.archived
              ? "channel_archived"
              : null;
      results.push({
        ...row,
        state: error ? "unavailable" : "accessible",
        error,
        checkedAt: now(),
        lastEventAt: null,
      });
    } catch (error) {
      results.push({
        ...row,
        state: "unavailable",
        error: safeSlackError(error),
        checkedAt: now(),
        lastEventAt: null,
      });
    }
  }
  return results;
}
