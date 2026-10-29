import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import type { ManagedProcess } from "@bb/process-utils";
import { trackChildProcessFixtureExit } from "@bb/test-helpers";
import { vi } from "vitest";
import { z } from "zod";

const requestSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.object({
    threadId: z.string().optional(),
    providerThreadId: z.string().optional(),
    clientRequestId: z.string().optional(),
    options: z.object({ permissionMode: z.string().optional() }).passthrough().optional(),
  }).passthrough().optional(),
});
type FixtureRequest = z.infer<typeof requestSchema>;

export class MemoryBridge extends ChildProcess {
  override stdin = new PassThrough();
  override stdout = new PassThrough();
  override stderr = new PassThrough();
  readonly requests: FixtureRequest[] = [];
  readyOnConstruction = true;
  startupReadiness: "native-init" | "session-created" = "native-init";
  deferConstruction = false;
  rateLimitedTurns = 0;
  deferTurn = false;
  replaceOnFullSteer = false;
  stopped = false;
  stopRequested = false;
  stopGate: Promise<void> | null = null;
  treeTermination: "confirmed" | "unverified" = "confirmed";
  private buffered = "";
  private turn = 0;
  private readonly activeTurns = new Map<string, string>();

  readonly stop: ManagedProcess["stop"] = async () => {
    this.stopRequested = true;
    await this.stopGate;
    this.stopped = this.treeTermination === "confirmed";
    this.finish();
    return { treeTermination: this.treeTermination };
  };

  constructor() {
    super();
    trackChildProcessFixtureExit(this);
    const child: ChildProcess = this;
    vi.spyOn(child, "kill").mockImplementation(() => {
      throw new Error("An in-memory bridge must never signal a process");
    });
    this.stdin.on("data", (chunk: Buffer) => {
      this.buffered += chunk.toString("utf8");
      let newline: number;
      while ((newline = this.buffered.indexOf("\n")) !== -1) {
        const request = requestSchema.parse(JSON.parse(this.buffered.slice(0, newline)));
        this.buffered = this.buffered.slice(newline + 1);
        this.requests.push(request);
        void Promise.resolve().then(() => this.receive(request));
      }
    });
  }

  private writeRpcMessage(value: object): void {
    if (!this.stdout.destroyed) this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
  }

  reply(request: FixtureRequest, result: object = {}): void {
    if (request.id === undefined) throw new Error("Fixture reply requires a request id");
    this.writeRpcMessage({ id: request.id, result });
  }

  phase(threadId: string, phase: "hook" | "ready"): void {
    this.writeRpcMessage({ method: "thread/startup", params: {
      threadId, phase,
      hookEvent: phase === "hook" ? "SessionStart" : null,
      hookId: phase === "hook" ? "0123456789abcdef" : null,
      hookState: phase === "hook" ? "started" : null,
    } });
  }

  acceptTurn(request: FixtureRequest): void {
    const threadId = request.params?.threadId;
    if (!threadId) throw new Error("Fixture turn requires a thread id");
    const providerTurnId = `turn-${++this.turn}`;
    this.activeTurns.set(threadId, providerTurnId);
    this.phase(threadId, "ready");
    this.writeRpcMessage({ method: "thread/delta", params: { threadId, deltas: [
      { kind: "input.accepted", clientRequestId: request.params?.clientRequestId, providerTurnId },
      { kind: "turn.open", providerTurnId },
    ] } });
    this.reply(request);
  }


  completeTurn(threadId: string): void {
    const providerTurnId = this.activeTurns.get(threadId);
    if (!providerTurnId) throw new Error("Fixture has no active turn to complete");
    this.writeRpcMessage({ method: "thread/delta", params: { threadId, deltas: [
      { kind: "turn.boundary", providerTurnId, status: "completed", providerCheckpointId: `checkpoint-${providerTurnId}` },
    ] } });
    this.activeTurns.delete(threadId);
  }

  recommendRestart(threadId: string): void {
    this.writeRpcMessage({ method: "provider/recovery", params: {
      threadId, kind: "restartRecommended", retryable: true, message: "Synthetic bridge refresh",
    } });
  }
  private receive(request: FixtureRequest): void {
    if (request.id === undefined) return;
    if (request.method === "initialize") {
      this.reply(request, { protocolVersion: 2, capabilities: {
        sessionRestore: true, startupReadiness: this.startupReadiness, fork: "checkpoint", grammarVersions: [2, 3],
      } });
      return;
    }
    const threadId = request.params?.threadId;
    if (["thread/start", "thread/resume", "thread/fork"].includes(request.method)) {
      if (!threadId) throw new Error("Fixture construction requires a thread id");
      if (this.deferConstruction) {
        this.phase(threadId, "hook");
        return;
      }
      if (this.readyOnConstruction) this.phase(threadId, "ready");
      this.reply(request, { providerThreadId: request.params?.providerThreadId ?? `native-${threadId}`, sessionRestorable: true });
      return;
    }
    if (request.method === "turn/start") {
      if (!threadId) throw new Error("Fixture turn requires a thread id");
      if (this.rateLimitedTurns > 0) {
        this.rateLimitedTurns -= 1;
        this.writeRpcMessage({ id: request.id, error: { code: -32000, message: "Synthetic rate limit", data: {
          recovery: { kind: "rateLimited", retryable: true, message: "Synthetic rate limit" },
        } } });
        return;
      }
      if (this.deferTurn) {
        this.phase(threadId, "hook");
        return;
      }
      this.acceptTurn(request);
      return;
    }
    if (request.method === "turn/steer" && this.replaceOnFullSteer && request.params?.options?.permissionMode === "full") {
      if (!threadId) throw new Error("Fixture replacement requires a thread id");
      this.phase(threadId, "hook");
      return;
    }
    this.reply(request);
  }

  finish(): void {
    if (this.exitCode !== null) return;
    this.emit("exit", 0, null);
    this.stdout.end();
    this.stderr.end();
    this.emit("close", 0, null);
  }
}
