import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import { initializeTasksSchema } from "../../tasks/db/schema.js";
import { InboxStore } from "../../tasks/inbox/store.js";
import { defaultConfiguration, type Configuration } from "./contract.js";
import { parseEvent } from "./events.js";
import {
  DeliveryQueue,
  IntakeStore,
  migrations,
  type Source,
} from "./store.js";
import { SlackInboxService } from "./service.js";

const hosts: FakePluginHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
});
const config: Configuration = {
  ...defaultConfiguration,
  enabled: true,
  approved: true,
  teamId: "TTEST",
  userId: "UTARGET",
  context: "work",
  conversations: [{ id: "CTEST", kind: "public" }],
};
function setup() {
  const host = createFakePluginHost({ pluginId: "bb--slack-inbox" });
  hosts.push(host);
  const db = host.bb.storage.database();
  host.bb.storage.migrate(db, migrations);
  initializeTasksSchema(db);
  const store = new IntakeStore(db, () => 1000);
  const inbox = new InboxStore(db);
  const send = async (source: Source) => {
    inbox.upsert({
      ...source,
      lane: "new",
      reason: "Source attention: slack_mention",
    });
  };
  return {
    host,
    store,
    inbox,
    queue: new DeliveryQueue(store, () => config, send),
    send,
  };
}
function body(id: string, event: Record<string, unknown>) {
  return {
    team_id: "TTEST",
    event_id: id,
    event: { type: "message", channel: "CTEST", ...event },
  };
}
function message(
  id: string,
  ts = "100.000001",
  text = "<@UTARGET> please review",
  thread = ts,
) {
  return body(id, { ts, thread_ts: thread, text, user: "UAUTHOR" });
}
function edit(
  id: string,
  version: string,
  text: string,
  ts = "100.000001",
  thread = ts,
) {
  return body(id, {
    subtype: "message_changed",
    event_ts: version,
    message: {
      ts,
      thread_ts: thread,
      text,
      user: "UAUTHOR",
      edited: { ts: version },
    },
  });
}
function accept(store: IntakeStore, payload: unknown, configuration = config) {
  const event = parseEvent(payload, configuration);
  expect(event.outcome).toBe("message");
  if (event.outcome === "message")
    store.accept(event.id, event.change, configuration.context);
}

describe("Socket intake to real Tasks Inbox storage", () => {
  it("commits before ACK, retains failed delivery across a database reopen, and deduplicates after human resolve", async () => {
    const { host, store, inbox, send } = setup();
    const service = new SlackInboxService(
      store,
      { configuration: config, appToken: "xapp-test", botToken: "xoxb-test" },
      send,
    );
    const ack = vi.fn(async () => {
      expect(store.counts().pending).toBe(1);
    });
    await service.receive({ body: message("Ev1"), ack });
    expect(ack).toHaveBeenCalledTimes(1);
    const failure = new DeliveryQueue(
      store,
      () => config,
      async () => {
        throw new Error("Tasks unavailable");
      },
    );
    await failure.drain();
    expect(store.counts().pending).toBe(1);
    store.db.close();
    const reopened = new IntakeStore(host.bb.storage.database());
    const reopenedInbox = new InboxStore(reopened.db);
    const deliver = new DeliveryQueue(
      reopened,
      () => config,
      async (source) => {
        reopenedInbox.upsert({
          ...source,
          lane: "new",
          reason: "Source attention: slack_mention",
        });
      },
    );
    await deliver.drain();
    const item = reopenedInbox.list("all")[0]!;
    reopenedInbox.decide(item.id, "resolve");
    accept(reopened, message("Ev1"));
    accept(reopened, message("EvRetryDifferentId"));
    await deliver.drain();
    expect(reopenedInbox.list("all")).toHaveLength(1);
    expect(reopenedInbox.get(item.id).state).toBe("resolved");
    expect(reopened.counts().pending).toBe(0);
    expect(inbox.db).toBe(store.db);
  });

  it("does not ACK a failed SQLite transaction", async () => {
    const { store, send } = setup();
    store.db.exec(
      "CREATE TRIGGER reject_receipt BEFORE INSERT ON slack_receipts BEGIN SELECT RAISE(ABORT, 'disk fault'); END",
    );
    const service = new SlackInboxService(
      store,
      { configuration: config, appToken: "xapp-test", botToken: "xoxb-test" },
      send,
    );
    const ack = vi.fn(async () => undefined);
    await expect(
      service.receive({ body: message("Ev1"), ack }),
    ).rejects.toThrow("disk fault");
    expect(ack).not.toHaveBeenCalled();
    expect(store.counts()).toEqual({ pending: 0, receivedDiscussions: 0 });
  });

  it("keeps newer edits and human decisions through stale creations, edits and repeated delivery", async () => {
    const { store, inbox, queue } = setup();
    accept(store, edit("EvNew", "300.000001", "<@UTARGET> newest"));
    await queue.drain();
    const item = inbox.list("all")[0]!;
    inbox.decide(item.id, "resolve");
    accept(store, message("EvOld"));
    accept(store, edit("EvStale", "200.000001", "<@UTARGET> stale"));
    accept(
      store,
      message(
        "EvOldReply",
        "90.000001",
        "<@UTARGET> stale reply",
        "100.000001",
      ),
    );
    await queue.drain();
    expect(inbox.get(item.id)).toMatchObject({
      state: "resolved",
      body: expect.stringContaining("newest"),
    });
    expect(inbox.get(item.id).body).not.toContain("stale");
  });

  it("groups mentions and handles removed mentions, deletions, and deletion arriving before creation", async () => {
    const { store, inbox, queue } = setup();
    accept(store, message("Ev1"));
    accept(
      store,
      message("Ev2", "101.000001", "<@UTARGET> another", "100.000001"),
    );
    await queue.drain();
    const item = inbox.list("all")[0]!;
    expect(inbox.list("all")).toHaveLength(1);
    accept(store, edit("Ev3", "103.000001", "mention removed"));
    await queue.drain();
    expect(inbox.get(item.id)).toMatchObject({
      active: true,
      body: expect.stringContaining("another"),
    });
    expect(inbox.get(item.id).body).not.toContain("please review");
    accept(
      store,
      body("Ev4", {
        subtype: "message_deleted",
        deleted_ts: "101.000001",
        event_ts: "104.000001",
      }),
    );
    await queue.drain();
    expect(inbox.get(item.id)).toMatchObject({
      active: false,
      state: "resolved",
    });
    accept(
      store,
      edit(
        "EvReplay",
        "105.000001",
        "<@UTARGET> cannot resurrect",
        "101.000001",
        "100.000001",
      ),
    );
    accept(
      store,
      body("EvDeleteFirst", {
        subtype: "message_deleted",
        deleted_ts: "200.000001",
        event_ts: "201.000001",
      }),
    );
    accept(store, message("EvLateCreate", "200.000001"));
    await queue.drain();
    expect(inbox.list("all")).toHaveLength(1);
    expect(inbox.get(item.id).active).toBe(false);
  });

  it("serializes an in-flight delivery with a newer edit and safely replays a committed RPC after lost response", async () => {
    const { store, inbox } = setup();
    accept(store, message("Ev1"));
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const queue = new DeliveryQueue(
      store,
      () => config,
      async (source) => {
        calls++;
        if (calls === 1) await gate;
        inbox.upsert({
          ...source,
          lane: "new",
          reason: "Source attention: slack_mention",
        });
      },
    );
    const running = queue.drain();
    accept(store, edit("Ev2", "200.000001", "<@UTARGET> final"));
    expect(queue.drain()).toBe(running);
    release!();
    await running;
    expect(calls).toBe(2);
    expect(inbox.list("all")[0]!.body).toContain("final");
    accept(store, edit("Ev3", "300.000001", "<@UTARGET> committed"));
    const lostResponse = new DeliveryQueue(
      store,
      () => config,
      async (source) => {
        const result = inbox.upsert({
          ...source,
          lane: "new",
          reason: "Source attention: slack_mention",
        });
        inbox.decide(result.item.id, "resolve");
        throw new Error("response lost after commit");
      },
    );
    await lostResponse.drain();
    await queue.drain();
    expect(inbox.list("all")[0]!.state).toBe("resolved");
    expect(store.counts().pending).toBe(0);
  });

  it("does not import bot mentions, bots, self mentions or out-of-scope workspaces/conversations", () => {
    const { store } = setup();
    const events = [
      body("EvApp", {
        type: "app_mention",
        ts: "100.000001",
        text: "<@UTARGET>",
      }),
      message("EvOther", "101.000001", "<@UOTHER> not you"),
      body("EvBot", {
        ts: "102.000001",
        text: "<@UTARGET>",
        user: "UAUTHOR",
        bot_id: "BTEST",
      }),
      body("EvSelf", { ts: "103.000001", text: "<@UTARGET>", user: "UTARGET" }),
      body("EvOtherChannel", {
        ts: "104.000001",
        text: "<@UTARGET>",
        user: "UAUTHOR",
        channel: "COTHER",
      }),
      { ...message("EvOtherTeam"), team_id: "TOTHER" },
    ];
    for (const payload of events) {
      const parsed = parseEvent(payload, config);
      if (parsed.outcome === "message")
        store.accept(parsed.id, parsed.change, config.context);
    }
    expect(store.counts()).toEqual({ pending: 0, receivedDiscussions: 0 });
  });

  it("isolates changed human scope and pauses pending sources removed from the allowlist", async () => {
    const { store, inbox } = setup();
    accept(store, message("Ev1"));
    const other = { ...config, userId: "UOTHER" };
    expect(store.pending(other)).toBeNull();
    expect(store.pending({ ...config, conversations: [] })).toBeNull();
    const disabled = new DeliveryQueue(
      store,
      () => ({ ...config, enabled: false }),
      async () => {
        throw new Error("must not send");
      },
    );
    await disabled.drain();
    expect(inbox.list("all")).toHaveLength(0);
    expect(store.counts().pending).toBe(1);
  });
});
