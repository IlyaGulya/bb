import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import {
  createSlackTransport,
  inspectCoverage,
  safeSlackError,
} from "./transport.js";
import { defaultConfiguration } from "./contract.js";
import { IntakeStore, migrations } from "./store.js";
import { SlackInboxService } from "./service.js";

const hosts: FakePluginHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
});

describe("official Slack clients against local protocol boundaries", () => {
  it("authenticates, inspects permission failures and ACKs Socket Mode only after SQLite acceptance", async () => {
    let port = 0;
    const calls: string[] = [];
    const server = createServer((request, response) => {
      calls.push(request.url ?? "");
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/auth.test")
        response.end(
          JSON.stringify({ ok: true, team_id: "TTEST", bot_id: "BTEST" }),
        );
      else if (request.url === "/api/conversations.info")
        response.end(
          JSON.stringify({
            ok: false,
            error: "missing_scope",
            needed: "channels:read",
          }),
        );
      else if (request.url === "/api/apps.connections.open")
        response.end(
          JSON.stringify({ ok: true, url: `ws://127.0.0.1:${port}/socket` }),
        );
      else {
        response.statusCode = 404;
        response.end("{}");
      }
    });
    const sockets = new WebSocketServer({ server, path: "/socket" });
    const acknowledged = Promise.withResolvers<void>();
    const host = createFakePluginHost({ pluginId: "bb--slack-inbox" });
    hosts.push(host);
    const db = host.bb.storage.database();
    host.bb.storage.migrate(db, migrations);
    const store = new IntakeStore(db);
    const configuration = {
      ...defaultConfiguration,
      enabled: true,
      approved: true,
      teamId: "TTEST",
      userId: "UTARGET",
      conversations: [{ id: "CTEST", kind: "public" as const }],
    };
    const intake = new SlackInboxService(
      store,
      { configuration, appToken: "xapp-synthetic", botToken: "xoxb-synthetic" },
      async () => {
        throw new Error("delivery is separate");
      },
    );
    sockets.on("connection", (socket) => {
      socket.on("message", (raw) => {
        try {
          const message = JSON.parse(raw.toString());
          if (message.envelope_id !== "env_test") return;
          expect(store.counts().pending).toBe(1);
          expect(message.payload).toEqual({});
          acknowledged.resolve();
        } catch (error) {
          acknowledged.reject(error);
        }
      });
      socket.send(JSON.stringify({ type: "hello", num_connections: 1 }));
      socket.send(
        JSON.stringify({
          type: "events_api",
          envelope_id: "env_test",
          payload: {
            team_id: "TTEST",
            event_id: "EvTEST",
            event: {
              type: "message",
              channel: "CTEST",
              ts: "100.000001",
              user: "UAUTHOR",
              text: "<@UTARGET> synthetic local test",
            },
          },
        }),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing loopback address");
    port = address.port;
    const transport = createSlackTransport(
      "xapp-synthetic",
      "xoxb-synthetic",
      `http://127.0.0.1:${port}/api/`,
    );
    transport.onEnvelope((envelope) => {
      void intake.receive(envelope).catch(acknowledged.reject);
    });
    transport.onError(() =>
      acknowledged.reject(new Error("Local Socket Mode failure")),
    );
    try {
      expect(await transport.authenticate()).toEqual({
        teamId: "TTEST",
        botId: "BTEST",
      });
      expect(await inspectCoverage(transport, configuration)).toMatchObject([
        { id: "CTEST", state: "unavailable", error: "missing_scope" },
      ]);
      await transport.start();
      await acknowledged.promise;
      expect(calls).toContain("/api/apps.connections.open");
      expect(
        calls.every((path) =>
          [
            "/api/auth.test",
            "/api/conversations.info",
            "/api/apps.connections.open",
          ].includes(path),
        ),
      ).toBe(true);
    } finally {
      await transport.stop();
      for (const client of sockets.clients) client.terminate();
      sockets.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15000);

  it("does not expose Slack error payloads or arbitrary content through diagnostics", () => {
    expect(
      safeSlackError({ data: { error: "missing_scope", token: "secret" } }),
    ).toBe("missing_scope");
    expect(safeSlackError({ data: { error: "secret private message" } })).toBe(
      "slack_api_unavailable",
    );
    expect(safeSlackError(new Error("xoxb-private"))).toBe(
      "slack_api_unavailable",
    );
  });
});
