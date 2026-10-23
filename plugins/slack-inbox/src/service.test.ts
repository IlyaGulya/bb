import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import {
  defaultConfiguration,
  statusSchema,
  type Configuration,
} from "./contract.js";
import { IntakeStore, migrations } from "./store.js";
import { SlackInboxService } from "./service.js";
import type { Envelope, SlackTransport } from "./transport.js";
import plugin from "./server.js";
import { createSlackInboxClient } from "./sdk.js";

const hosts: FakePluginHost[] = [];
const running: { abort: AbortController; done: Promise<void> }[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) {
    service.abort.abort();
    await service.done;
  }
  for (const host of hosts.splice(0)) await host.harness.dispose();
});
class LocalTransport implements SlackTransport {
  team = "TTEST";
  denied = false;
  starts = 0;
  stops = 0;
  connection: (connected: boolean) => void = () => undefined;
  receive: (envelope: Envelope) => void = () => undefined;
  error: () => void = () => undefined;
  async authenticate() {
    return { teamId: this.team, botId: "BTEST" };
  }
  async conversation() {
    if (this.denied)
      throw { data: { error: "not_in_channel", content: "must not leak" } };
    return { kind: "public" as const, member: true, archived: false };
  }
  onEnvelope(handler: (envelope: Envelope) => void) {
    this.receive = handler;
  }
  onConnection(handler: (connected: boolean) => void) {
    this.connection = handler;
  }
  onError(handler: () => void) {
    this.error = handler;
  }
  async start() {
    this.starts++;
    this.connection(true);
  }
  async stop() {
    this.stops++;
    this.connection(false);
  }
}
const configuration: Configuration = {
  ...defaultConfiguration,
  enabled: true,
  approved: true,
  teamId: "TTEST",
  userId: "UTARGET",
  conversations: [{ id: "CTEST", kind: "public" }],
};
function setup(transport = new LocalTransport(), config = configuration) {
  const host = createFakePluginHost({ pluginId: "bb--slack-inbox" });
  hosts.push(host);
  const db = host.bb.storage.database();
  host.bb.storage.migrate(db, migrations);
  const service = new SlackInboxService(
    new IntakeStore(db),
    {
      configuration: config,
      appToken: "xapp-synthetic",
      botToken: "xoxb-synthetic",
    },
    async () => undefined,
    () => transport,
  );
  const abort = new AbortController();
  const done = service.run(abort.signal);
  running.push({ abort, done });
  return { host, transport, service, abort, done };
}

describe("Slack lifecycle safety", () => {
  it("connects only with approval and explicit enabled scope", async () => {
    const { service, transport } = setup(new LocalTransport(), {
      ...configuration,
      approved: false,
    });
    await vi.waitFor(() =>
      expect(service.status()).toMatchObject({
        connection: "unconfigured",
        error: "approval_required",
      }),
    );
    expect(transport.starts).toBe(0);
    await service.reconfigure({
      configuration,
      appToken: "xapp-synthetic",
      botToken: "xoxb-synthetic",
    });
    expect(service.status().connection).toBe("connected");
    await service.reconfigure({
      configuration: { ...configuration, enabled: false },
      appToken: "xapp-synthetic",
      botToken: "xoxb-synthetic",
    });
    expect(service.status().connection).toBe("disabled");
    expect(transport.stops).toBe(1);
  });
  it("rejects a bot token for another workspace before opening Socket Mode", async () => {
    const transport = new LocalTransport();
    transport.team = "TOTHER";
    const { service } = setup(transport);
    await vi.waitFor(() =>
      expect(service.status().error).toBe("workspace_mismatch"),
    );
    expect(service.status().connection).toBe("error");
    expect(transport.starts).toBe(0);
  });
  it("keeps explicit coverage gaps through reconnect and closes them only after access recovery", async () => {
    const transport = new LocalTransport();
    transport.denied = true;
    const { service, abort, done, host } = setup(transport);
    await vi.waitFor(() =>
      expect(service.status().connection).toBe("connected"),
    );
    expect(service.status().coverage[0]).toMatchObject({
      state: "unavailable",
      error: "not_in_channel",
    });
    expect(
      service
        .status()
        .gaps.some(
          (gap) =>
            gap.reason.startsWith("conversation_access_gap") &&
            gap.endedAt === null,
        ),
    ).toBe(true);
    transport.connection(false);
    expect(service.status().connection).toBe("disconnected");
    transport.connection(true);
    expect(
      service
        .status()
        .gaps.some(
          (gap) =>
            gap.reason.startsWith("socket_disconnected") &&
            gap.endedAt !== null,
        ),
    ).toBe(true);
    expect(
      service
        .status()
        .gaps.some(
          (gap) =>
            gap.reason.startsWith("conversation_access_gap") &&
            gap.endedAt === null,
        ),
    ).toBe(true);
    transport.denied = false;
    await service.checkCoverage();
    expect(service.status().coverage[0]!.state).toBe("accessible");
    expect(
      service
        .status()
        .gaps.some(
          (gap) =>
            gap.reason.startsWith("conversation_access_gap") &&
            gap.endedAt === null,
        ),
    ).toBe(false);
    abort.abort();
    await done;
    const restarted = new IntakeStore(host.bb.storage.database());
    expect(
      restarted
        .gaps()
        .some(
          (gap) =>
            gap.reason.startsWith("service_stopped") && gap.endedAt === null,
        ),
    ).toBe(true);
  });
  it("ignores late callbacks from a replaced connection", async () => {
    const { service, transport } = setup();
    await vi.waitFor(() =>
      expect(service.status().connection).toBe("connected"),
    );
    const oldReceive = transport.receive;
    await service.reconfigure({
      configuration: { ...configuration, enabled: false },
      appToken: "xapp-synthetic",
      botToken: "xoxb-synthetic",
    });
    const ack = vi.fn(async () => undefined);
    oldReceive({
      ack,
      body: {
        team_id: "TTEST",
        event_id: "EvLATE",
        event: {
          type: "message",
          channel: "CTEST",
          ts: "100.000001",
          user: "UAUTHOR",
          text: "<@UTARGET> ignored after disable",
        },
      },
    });
    expect(ack).not.toHaveBeenCalled();
    expect(service.status().receivedDiscussions).toBe(0);
  });
});

describe("SDK, CLI and settings boundaries", () => {
  it("ships disabled, redacts secrets and applies identical validated non-secret configuration through SDK and CLI", async () => {
    const host = createFakePluginHost({ pluginId: "bb--slack-inbox" });
    hosts.push(host);
    await plugin(host.bb);
    expect(
      statusSchema.parse(await host.harness.callRpc("status", null)).connection,
    ).toBe("disabled");
    await host.harness.behavior.setSettings({
      appToken: "xapp-synthetic-private",
      botToken: "xoxb-synthetic-private",
    });
    const cli = await host.harness.runCli(["status"]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout).not.toContain("synthetic-private");
    expect(JSON.parse(cli.stdout ?? "{}").credentials).toEqual({
      appToken: true,
      botToken: true,
    });
    const client = createSlackInboxClient({
      callRpc: async (args) =>
        args.outputSchema.parse(
          await host.harness.callRpc(args.method, args.input),
        ),
    });
    const configured = { ...configuration, enabled: false };
    expect((await client.configure(configured)).configuration).toEqual(
      configured,
    );
    const rejected = await host.harness.runCli([
      "configure",
      "--data",
      JSON.stringify(configured),
    ]);
    expect(rejected.exitCode).toBe(1);
    const accepted = await host.harness.runCli([
      "configure",
      "--data",
      JSON.stringify({ ...configured, context: "personal" }),
      "--yes",
    ]);
    expect(accepted.exitCode).toBe(0);
    expect((await client.status()).configuration.context).toBe("personal");
    await expect(
      host.harness.callRpc("configure", {
        ...configured,
        botToken: "not-allowed-here",
      }),
    ).rejects.toThrow();
    expect(host.harness.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
    expect((await host.harness.runCli(["setup"])).stdout).toContain(
      "connections:write",
    );
  });
});
