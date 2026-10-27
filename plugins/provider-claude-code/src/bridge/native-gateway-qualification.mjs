import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

const executable = process.argv[2];
assert(executable && isAbsolute(executable), "Pass an absolute installed native Claude executable path.");
const directory = await mkdtemp(join(tmpdir(), "bb-claude-header-qualification-"));
const nativeToken = "fake-native-oauth-never-forward";
const clientKey = "fake-cpa-client-qualification-only";
let requests = 0;
const abortController = new AbortController();
const deadline = setTimeout(() => abortController.abort(), 30_000);
let violation = false;
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  requests += 1;
  if (
    JSON.stringify(request.headers).includes(nativeToken) ||
    body.includes(nativeToken) ||
    request.headers.authorization !== `Bearer ${clientKey}` ||
    request.headers["x-api-key"] !== undefined
  ) violation = true;
  if (request.url?.endsWith("/count_tokens")) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ input_tokens: 1 }));
    return;
  }
  const model = JSON.parse(body).model;
  const message = {
    id: "msg_qualification", type: "message", role: "assistant", model,
    content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 0 },
  };
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const [event, data] of [
    ["message_start", { type: "message_start", message }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ]) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  response.end();
});
let session;
try {
  await writeFile(join(directory, ".credentials.json"), JSON.stringify({
    claudeAiOauth: {
      accessToken: nativeToken, expiresAt: Date.now() + 3_600_000,
      scopes: ["user:inference", "user:mcp_servers", "user:profile"],
      subscriptionType: "team",
    },
  }), { mode: 0o600 });
  await writeFile(join(directory, ".claude.json"), JSON.stringify({
    hasCompletedOnboarding: true,
    oauthAccount: { accountUuid: "00000000-0000-4000-8000-000000000001", organizationUuid: "00000000-0000-4000-8000-000000000002" },
  }), { mode: 0o600 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  session = query({ prompt: "Reply OK without using tools.", options: {
    pathToClaudeCodeExecutable: executable,
    cwd: directory,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CLAUDE_CONFIG_DIR: directory,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      ANTHROPIC_CUSTOM_HEADERS: `Authorization: Bearer ${clientKey}`,
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
    },
    model: "claude-sonnet-4-6",
    settingSources: [], strictMcpConfig: true, mcpServers: {},
    settings: { autoMemoryEnabled: false },
    persistSession: false, maxTurns: 1, tools: [],
    abortController,
  } });
  const initialized = await session.initializationResult();
  assert.equal(initialized.account.tokenSource, "claude.ai", "Native OAuth predicate was not retained.");
  for await (const message of session) {
    if (message.type === "result") assert.equal(message.is_error, false, "Native loopback request failed.");
  }
  assert(requests > 0, "Native CLI did not reach the isolated model ingress.");
  assert.equal(violation, false, "Model ingress received wrong auth or native OAuth material.");
  console.log(JSON.stringify({ nativeOAuthRetained: true, customAuthorizationOverridesOAuth: true, nativeOAuthForwarded: false, cloudNetworkExercised: false, requests }));
} finally {
  clearTimeout(deadline);
  session?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
