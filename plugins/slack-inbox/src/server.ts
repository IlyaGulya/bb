import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  configurationSchema,
  conversationSchema,
  slackInboxRpc,
  type Configuration,
} from "./contract.js";
import { registerCli } from "./cli.js";
import { migrations, IntakeStore } from "./store.js";
import { SlackInboxService, type Settings } from "./service.js";

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define({
    enabled: {
      type: "boolean",
      label: "Enable approved Slack intake",
      default: false,
    },
    approved: {
      type: "boolean",
      label: "Corporate app and BB message storage approved",
      default: false,
    },
    appToken: {
      type: "string",
      label: "Dedicated Socket Mode app token",
      description:
        "xapp token with connections:write. Never reuse another integration's token.",
      secret: true,
    },
    botToken: {
      type: "string",
      label: "Dedicated Slack bot token",
      description:
        "xoxb token; selected history/read scopes only. No write scopes.",
      secret: true,
    },
    teamId: {
      type: "string",
      label: "Approved workspace ID",
      default: "",
      experimental_schema: configurationSchema.shape.teamId,
    },
    userId: {
      type: "string",
      label: "Permitted human user ID",
      description:
        "Explicit <@U…> mentions in message events, not app_mention.",
      default: "",
      experimental_schema: configurationSchema.shape.userId,
    },
    context: {
      type: "select",
      label: "Source context",
      options: ["unknown", "work", "personal"],
      default: "unknown",
    },
    conversations: {
      type: "string",
      label: "Approved conversations JSON",
      default: "[]",
      experimental_multiline: true,
      description:
        'Explicit allowlist: [{"id":"C…","kind":"public"}]. Kinds: public, private, im, mpim. Bot must have access; human-to-human DMs are not covered.',
      experimental_schema: z.string().refine((value) => {
        try {
          return configurationSchema.shape.conversations.safeParse(
            JSON.parse(value),
          ).success;
        } catch {
          return false;
        }
      }, "Use a JSON array of unique conversation IDs and kinds"),
    },
  });
  function normalize(
    values: Awaited<ReturnType<typeof settings.get>>,
  ): Settings {
    return {
      configuration: configurationSchema.parse({
        enabled: values.enabled,
        approved: values.approved,
        teamId: values.teamId,
        userId: values.userId,
        context: values.context,
        conversations: z
          .array(conversationSchema)
          .parse(JSON.parse(values.conversations)),
      }),
      appToken: values.appToken ?? "",
      botToken: values.botToken ?? "",
    };
  }
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);
  const service = new SlackInboxService(
    new IntakeStore(db),
    normalize(await settings.get()),
    async (source) => {
      await bb.sdk.plugins.callRpc({
        pluginId: "tasks",
        method: "upsertInboxSource",
        input: source,
        outputSchema: z.object({
          item: z.object({ id: z.string() }),
          changed: z.boolean(),
        }),
      });
    },
    undefined,
    () => bb.realtime.publish("status-changed", null),
  );
  settings.onChange((next) => {
    void service
      .reconfigure(normalize(next))
      .catch(() =>
        bb.log.warn(
          "Slack Inbox configuration transition failed; inspect status.",
        ),
      );
  });
  const actions = {
    status: () => service.status(),
    async configure(input: Configuration) {
      const parsed = configurationSchema.parse(input);
      const next = await settings.experimental_set({
        ...parsed,
        conversations: JSON.stringify(parsed.conversations),
      });
      await service.reconfigure(normalize(next));
      return service.status();
    },
    checkCoverage: () => service.checkCoverage(),
    retry: () => service.retry(),
  };
  bb.rpc.register(slackInboxRpc, actions);
  registerCli(bb, actions);
  bb.background.service("slack-socket-mode", {
    start: (signal) => service.run(signal),
  });
}
