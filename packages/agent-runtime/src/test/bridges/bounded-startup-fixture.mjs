import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

let child;
let settings = {};
let turn = 0;
let readiness = "native-init";
const timers = new Set();
const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
const respond = (id, result) => send({ id, result });
const phase = (threadId, value) => send({ method: "thread/startup", params: {
  threadId, phase: value, hookEvent: value === "hook" ? "SessionStart" : null,
  hookId: value === "hook" ? "0123456789abcdef" : null, hookState: value === "hook" ? "started" : null,
} });

function stop() {
  for (const timer of timers) clearTimeout(timer);
  if (!child || child.exitCode !== null || child.signalCode !== null) process.exit(0);
  child.once("exit", () => process.exit(0));
  child.kill("SIGTERM");
}

export const experimental_providerBridge = {
  experimental_apiVersion: 1,
  start({ dataDir }) {
    if (existsSync(join(dataDir, "generic-readiness"))) readiness = "session-created";
  },
  onSigterm: stop,
  onClose: stop,
  handleLine(line) {
    const request = JSON.parse(line);
    const { id, method, params = {} } = request;
    if (method === "initialize") {
      respond(id, { protocolVersion: 2, capabilities: {
        sessionRestore: true, startupReadiness: readiness, fork: "checkpoint", grammarVersions: [2, 3],
      } });
      return;
    }
    if (method === "thread/start" || method === "thread/resume" || method === "thread/fork") {
      settings = params.options?.providerOptions?.startupFixture ?? {};
      if (settings.startsFile) appendFileSync(settings.startsFile, `${process.pid}\n`);
      if (settings.mode === "missing-auth") {
        send({ id, error: { code: -32000, message: "Fixture required capability needs human authentication.", data: {
          recovery: { kind: "authRequired", message: "Fixture required capability needs human authentication.", retryable: false },
        } } });
        return;
      }
      if (settings.mode === "failure") {
        send({ id, error: { code: -32000, message: "SENSITIVE_NATIVE_OUTPUT_MUST_NOT_ESCAPE" } });
        return;
      }
      if (settings.mode === "slow-hook") {
        child = spawn(process.execPath, ["-e", "const fs = require('node:fs'); const file = process.argv[1]; fs.writeFileSync(file, String(process.pid)); setInterval(() => fs.appendFileSync(file, '.'), 25);", settings.childFile], { stdio: "ignore" });
        child.once("spawn", () => phase(params.threadId, "hook"));
        return;
      }
      const providerThreadId = params.providerThreadId ?? `native-${params.threadId}`;
      send({ method: "thread/identity", params: { threadId: params.threadId, providerThreadId, sessionRestorable: true } });
      respond(id, { providerThreadId, sessionRestorable: true });
      return;
    }
    if (method === "turn/start") {
      const providerTurnId = `fixture-turn-${++turn}`;
      phase(params.threadId, "ready");
      send({ method: "thread/delta", params: { threadId: params.threadId, deltas: [
        { kind: "input.accepted", clientRequestId: params.clientRequestId, providerTurnId },
        { kind: "turn.open", providerTurnId },
      ] } });
      respond(id, {});
      const timer = setTimeout(() => {
        timers.delete(timer);
        send({ method: "thread/delta", params: { threadId: params.threadId, deltas: [
          { kind: "turn.boundary", providerTurnId, status: "completed", providerCheckpointId: "fixture-checkpoint" },
        ] } });
      }, settings.modelDelayMs ?? 1);
      timers.add(timer);
      return;
    }
    if (method === "thread/stop" || method === "thread/discard") {
      respond(id, { providerCheckpointId: "fixture-checkpoint" });
      return;
    }
    respond(id, {});
  },
};
