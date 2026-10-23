export const SETUP = {
  approval:
    "Corporate app installation, selected message subscriptions and work-message storage in BB must be approved. Model use requires separate authorization.",
  tokens:
    "Dedicated app xapp token: connections:write. Dedicated bot xoxb token. Set appToken and botToken in Slack Inbox secret settings or SDK plugins.updateSettings; never paste credentials into command history, logs, message text or configuration JSON.",
  settingsPath: "/settings/plugins/bb--slack-inbox",
  scope:
    'Set teamId (T...), permitted human userId (U...), context, and conversations JSON [{"id":"C…","kind":"public"}]. Kinds: public, private, im, mpim. Explicit allowlist only. Record approved=true only after authorization; enabled defaults false.',
  permissions: {
    public: {
      scopes: ["channels:history", "channels:read"],
      event: "message.channels",
    },
    private: {
      scopes: ["groups:history", "groups:read"],
      event: "message.groups",
    },
    im: { scopes: ["im:history", "im:read"], event: "message.im" },
    mpim: { scopes: ["mpim:history", "mpim:read"], event: "message.mpim" },
  },
  limits:
    "Enable Socket Mode and outbound HTTPS/WSS. Invite the bot only to approved conversations. No chat:write, reactions, users:read, user token, public endpoint, browser cookies, Claude OAuth, or polling is needed. A bot cannot see human-to-human DMs or all user mentions. Subscriptions require a real approved test mention to verify.",
  inbox:
    "bb tasks inbox list --state open --json; use existing human Inbox link/create/resolve/snooze actions. Received is not accepted or dispatched.",
};
