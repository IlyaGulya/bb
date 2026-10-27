import { createServer, type Server } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelConnectionSnapshot } from "@get-bb/plugin-sdk/provider-bridge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildClaudeGatewayEnvironment,
  claudeGatewayModel,
  listClaudeGatewayModels,
  prepareGatewayBinding,
} from "../model-gateway.js";

let directory: string;
let server: Server;
let connection: ModelConnectionSnapshot;
let ids: string[];
let status: number;
let requests: { authorization: string | undefined; threadId: string | string[] | undefined }[];

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "bb-claude-gateway-test-"));
  const credentialPath = join(directory, "client-key");
  writeFileSync(credentialPath, "private-cpa-test-client\n", { mode: 0o600 });
  ids = ["work/claude-example", "work/claude-example"];
  status = 200;
  requests = [];
  server = createServer((request, response) => {
    requests.push({ authorization: request.headers.authorization, threadId: request.headers["x-bb-thread-id"] });
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener address");
  connection = {
    id: "claude-cpa-work", name: "Claude CPA work", provider: "claude-code",
    hostId: null, enabled: true, revoked: false, createdAt: 1, updatedAt: 1,
    nativeAuth: { configDir: null, profile: null, hostEnv: null },
    gateway: {
      baseUrl: `http://127.0.0.1:${address.port}/v1`, protocol: "anthropic-messages",
      accountPrefix: "work", modelProvider: "bb-cpa", allowedHostIds: ["host"],
      credential: { kind: "file", path: credentialPath },
    },
  };
});

afterEach(async () => {
  server.closeAllConnections();
  const closed = Promise.withResolvers<void>();
  server.close((error) => error ? closed.reject(error) : closed.resolve());
  await closed.promise;
  rmSync(directory, { recursive: true, force: true });
});

describe("native Claude CPA boundary", () => {
  it("discovers only exact CPA model identities without thread routing or invented capabilities", async () => {
    const result = await listClaudeGatewayModels(connection);
    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject({
      id: "bb-cpa/work/claude-example", model: "bb-cpa/work/claude-example",
      supportedReasoningEfforts: [], isDefault: false,
    });
    expect(result.models[0]).not.toHaveProperty("contextWindow");
    expect(result.models[0]).not.toHaveProperty("maxTokens");
    expect(result.models[0]?.description).toContain("Cloud MCP connectors are unavailable");
    expect(requests).toEqual([{ authorization: "Bearer private-cpa-test-client", threadId: undefined }]);
    expect(claudeGatewayModel(result.models[0]!.model, connection)).toBe("work/claude-example");
    for (const model of [undefined, "default", "claude-example", "bb-cpa/personal/claude-example"]) {
      expect(() => claudeGatewayModel(model, connection)).toThrow();
    }
    ids = ["personal/claude-example"];
    await expect(listClaudeGatewayModels(connection)).rejects.toThrow();
    status = 401;
    await expect(listClaudeGatewayModels(connection)).rejects.toThrow();
  });

  it("routes only the new native child and defeats ambient auth, model aliases, and provider contributions", () => {
    const launchEnv = {
      HOME: "/unchanged-home", ANTHROPIC_API_KEY: "ambient-native-key",
      ANTHROPIC_AUTH_TOKEN: "ambient-native-token", CLAUDE_CODE_OAUTH_TOKEN: "native-oauth",
      ANTHROPIC_BASE_URL: "https://wrong.invalid", ANTHROPIC_UNIX_SOCKET: "/wrong/socket",
      ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer native-oauth\nX-Api-Key: ambient",
      ANTHROPIC_MODEL: "native-default", ANTHROPIC_DEFAULT_HAIKU_MODEL: "native-haiku",
      CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: "8",
    };
    const env = buildClaudeGatewayEnvironment({ connection, env: launchEnv, threadId: "thread-work", model: "bb-cpa/work/claude-example" });
    expect(env.HOME).toBe(launchEnv.HOME);
    expect(env.ANTHROPIC_BASE_URL).toBe(connection.gateway!.baseUrl.replace(/\/v1$/, ""));
    expect(env.ANTHROPIC_API_KEY).toBe("private-cpa-test-client");
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe("X-BB-Thread-Id: thread-work");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("work/claude-example");
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("work/claude-example");
    for (const name of ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_UNIX_SOCKET", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR"]) {
      expect(env[name]).toBeUndefined();
    }
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
    expect(launchEnv.ANTHROPIC_API_KEY).toBe("ambient-native-key");
    expect(() => buildClaudeGatewayEnvironment({ connection, env: { ENABLE_CLAUDEAI_MCP_SERVERS: "true" }, model: "bb-cpa/work/claude-example" })).toThrow("Cloud MCP");
    const credential = connection.gateway!.credential;
    if (credential.kind !== "file") throw new Error("Expected a private file reference");
    chmodSync(credential.path, 0o644);
    expect(() => buildClaudeGatewayEnvironment({ connection, env: {}, model: "bb-cpa/work/claude-example" })).toThrow("owner-only");
  });

  it("uses only custom model Authorization in the explicitly selected native MCP profile", () => {
    const source = {
      HOME: "/unchanged-home", CLAUDE_CONFIG_DIR: directory,
      ANTHROPIC_API_KEY: "ambient-api", ANTHROPIC_AUTH_TOKEN: "ambient-token",
      ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer wrong\\nX-Api-Key: wrong",
    };
    const env = buildClaudeGatewayEnvironment({
      connection, env: source, threadId: "cloud-thread",
      model: "bb-cpa/work/claude-example", nativeMcp: true,
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe(
      "Authorization: Bearer private-cpa-test-client\nX-BB-Thread-Id: cloud-thread",
    );
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("true");
    expect(env.CLAUDE_CONFIG_DIR).toBe(directory);
    expect(env.HOME).toBe(source.HOME);
    expect(source.ANTHROPIC_API_KEY).toBe("ambient-api");
  });

  it("pins follow-up, reopen, and native checkpoint-fork receipts without permitting native fallback", async () => {
    const state = join(directory, "state");
    const params = { threadId: "original", modelConnection: connection, model: "bb-cpa/work/claude-example" };
    const verify = await prepareGatewayBinding(state, params, "native-original", false);
    verify!();
    const reopened = await prepareGatewayBinding(state, params, "native-original", true);
    reopened!();
    const forked = await prepareGatewayBinding(state, { ...params, threadId: "fork", sourceProviderThreadId: "native-original" }, "native-fork", false);
    forked!();
    await expect(prepareGatewayBinding(state, { threadId: "native-downgrade", sourceProviderThreadId: "native-original" }, "new-native", false)).rejects.toThrow("original gateway");
    await expect(prepareGatewayBinding(state, { threadId: "original" }, "native-original", true)).rejects.toThrow("original gateway");
    ids = ["work/claude-other"];
    await expect(prepareGatewayBinding(state, { ...params, model: "bb-cpa/work/claude-other" }, "native-original", true)).rejects.toThrow("receipt");
    const receipts = join(state, "claude-gateway");
    const receiptPath = join(receipts, readdirSync(receipts)[0]!);
    expect(readFileSync(receiptPath, "utf8")).not.toContain("private-cpa-test-client");
    writeFileSync(receiptPath, "{}");
    expect(() => verify!()).toThrow("receipt");
  });
});
