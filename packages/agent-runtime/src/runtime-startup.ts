import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { executionContextSnapshotSchema, type ProviderStartupCode, type ProviderStartupDiagnostic, type ProviderStartupPolicy, type ThreadEvent } from "@bb/domain";
import { threadStartupNotificationSchema, type ThreadStartupNotification } from "@bb/provider-bridge-protocol";

interface StartupRun {
  controller: AbortController;
  operationId: string;
  phase: ProviderStartupDiagnostic["phase"];
  failureStage: ProviderStartupDiagnostic["failureStage"];
  failureCause: Error | null;
  hookEvent: ThreadStartupNotification["hookEvent"];
  hookId: string | null;
  hookState: ThreadStartupNotification["hookState"];
  policy: ProviderStartupPolicy;
  startedAt: number;
  stop: () => Promise<void>;
  stopPromise: Promise<void> | null;
  reject: (error: Error) => void;
  ready: boolean;
  prepared: boolean;
  deadline: ReturnType<typeof setTimeout> | null;
  heartbeat: ReturnType<typeof setInterval> | null;
  stopSettled: boolean;
  failureCode: ProviderStartupCode | null;
  work: Set<Promise<unknown>>;
}

export class ProviderStartupError extends Error {
  constructor(readonly code: ProviderStartupCode, cause?: Error) {
    super({
      provider_startup_timeout: "Provider startup timed out. This attempt was stopped; change prerequisites before retrying this thread.",
      provider_startup_cancelled: "Provider startup was cancelled. This thread and its checkpoint are retained.",
      provider_startup_failed: "Provider startup failed. Inspect the safe startup diagnostic and check prerequisites before retrying this thread.",
      provider_startup_stop_unverified: "Provider startup could not confirm that its owned processes stopped. Retry is blocked; operator verification is required.",
      provider_startup_capability_unverified: "This provider cannot prove required startup capabilities. Select a supported provider or explicitly record optional MCP servers in the context policy.",
      provider_startup_auth_required: "A required native capability reports that human authentication is needed. Complete target-local setup, then retry this thread.",
    }[code], cause === undefined ? undefined : { cause });
    this.name = "ProviderStartupError";
  }
}

export function readStartupPolicy(providerOptions: Record<string, unknown> | undefined): ProviderStartupPolicy | null {
  const value = providerOptions?.executionContext;
  if (value === undefined || value === null) return null;
  const context = executionContextSnapshotSchema.parse(value);
  const policy = context.startupPolicy ?? null;
  if (policy && policy.optionalMcpServers.some((name) => !context.mcpServers.some((server) => server.name === name))) {
    throw new ProviderStartupError("provider_startup_failed");
  }
  return policy;
}

export class RuntimeStartup {
  private readonly active = new Map<string, StartupRun>();
  private readonly blocked = new Set<string>();
  private readonly nativeReady = new Set<string>();
  private readonly retainedRuns = new Map<string, StartupRun>();

  signal(threadId: string): AbortSignal | undefined {
    return this.active.get(threadId)?.controller.signal;
  }

  ready(threadId: string): void {
    const run = this.active.get(threadId);
    if (!run || run.controller.signal.aborted || run.ready) return;
    run.ready = true;
    run.phase = "ready";
    run.hookEvent = null;
    run.hookId = null;
    run.hookState = null;
    if (run.deadline) clearTimeout(run.deadline);
    if (run.heartbeat) clearInterval(run.heartbeat);
    this.retainedRuns.set(threadId, run);
    this.publish(threadId, run, "completed");
    this.releaseIfSettled(threadId, run);
  }

  prepared(threadId: string): void {
    const run = this.active.get(threadId);
    if (!run || run.controller.signal.aborted || run.prepared) return;
    run.prepared = true;
    this.retainedRuns.set(threadId, run);
    if (run.deadline) clearTimeout(run.deadline);
    if (run.heartbeat) clearInterval(run.heartbeat);
    this.releaseIfSettled(threadId, run);
  }

  constructor(private readonly emit: (event: ThreadEvent) => void) {}

  isActive(threadId: string): boolean {
    return this.active.has(threadId) || this.blocked.has(threadId);
  }

  owns(threadId: string): boolean {
    return this.isActive(threadId) || this.retainedRuns.has(threadId);
  }

  *threadIds(): IterableIterator<string> {
    yield* this.active.keys();
    yield* this.blocked;
    for (const [threadId, run] of this.retainedRuns) {
      if (run.prepared) yield threadId;
    }
  }

  assertAvailable(threadId: string): void {
    if (this.blocked.has(threadId)) throw new ProviderStartupError("provider_startup_stop_unverified");
    this.active.get(threadId)?.controller.signal.throwIfAborted();
  }

  hasOwnedWork(): boolean {
    if (this.active.size > 0 || this.blocked.size > 0) return true;
    for (const run of this.retainedRuns.values()) {
      if (run.prepared) return true;
    }
    return false;
  }

  observe(threadId: string, value: unknown): void {
    const run = this.active.get(threadId);
    if (run?.controller.signal.aborted) return;
    const parsed = threadStartupNotificationSchema.safeParse(value);
    if (!parsed.success || parsed.data.threadId !== threadId) return;
    if (parsed.data.phase === "ready") {
      this.nativeReady.add(threadId);
      this.ready(threadId);
      return;
    }
    this.nativeReady.delete(threadId);
    if (!run || run.ready) return;
    run.phase = parsed.data.phase;
    run.hookEvent = parsed.data.hookEvent;
    run.hookId = parsed.data.hookId;
    run.hookState = parsed.data.hookState;
    this.publish(threadId, run, "running");
  }

  forgetReadiness(threadId: string): void {
    this.nativeReady.delete(threadId);
    this.retainedRuns.delete(threadId);
  }

  requireCleanup(threadId: string, code: "provider_startup_failed" | "provider_startup_cancelled" = "provider_startup_failed", work: "drain" | "replacement" = "drain"): void {
    const run = this.active.get(threadId) ?? this.retainedRuns.get(threadId);
    if (!run) return;
    this.forgetReadiness(threadId);
    if (run.ready || run.prepared) {
      run.operationId = randomUUID();
      run.startedAt = performance.now();
    }
    run.ready = false;
    run.prepared = false;
    this.active.set(threadId, run);
    void this.interrupt(threadId, run, code, work);
  }

  async track<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const run = this.active.get(threadId);
    if (!run) return work();
    run.controller.signal.throwIfAborted();
    const task = Promise.resolve().then(() => {
      run.controller.signal.throwIfAborted();
      return work();
    });
    run.work.add(task);
    try {
      return await task;
    } catch (error) {
      if (!run.ready) void this.fail(threadId, run, error);
      throw error;
    } finally {
      run.work.delete(task);
      this.releaseIfSettled(threadId, run);
    }
  }

  async run<T>(args: {
    threadId: string;
    policy: ProviderStartupPolicy;
    stop: () => Promise<void>;
    work: (signal: AbortSignal) => Promise<T>;
  }): Promise<T> {
    if (this.blocked.has(args.threadId)) throw new ProviderStartupError("provider_startup_stop_unverified");
    if (this.active.has(args.threadId)) throw new Error("Provider startup is already owned by another attempt on this thread.");
    let reject!: (error: Error) => void;
    const interrupted = new Promise<never>((_, rejectPromise) => { reject = rejectPromise; });
    const run: StartupRun = {
      controller: new AbortController(), operationId: randomUUID(), phase: "initializing",
      hookEvent: null, hookId: null, hookState: null, policy: args.policy,
      startedAt: performance.now(), stop: args.stop, stopPromise: null, reject, ready: false, prepared: false, deadline: null,
      stopSettled: false, failureCode: null, failureStage: null, failureCause: null,
      heartbeat: null,
      work: new Set(),
    };
    this.active.set(args.threadId, run);
    this.publish(args.threadId, run, "running");
    const timer = setTimeout(() => {
      void this.interrupt(args.threadId, run, "provider_startup_timeout");
    }, args.policy.deadlineMs);
    run.deadline = timer;
    const heartbeat = setInterval(() => {
      if (!run.ready && !run.stopSettled) this.publish(args.threadId, run, "running");
    }, 1_000);
    run.heartbeat = heartbeat;
    timer.unref?.();
    heartbeat.unref?.();
    try {
      const value = await Promise.race([
        this.track(args.threadId, () => args.work(run.controller.signal)),
        interrupted,
      ]);
      run.controller.signal.throwIfAborted();
      if (this.nativeReady.has(args.threadId)) this.ready(args.threadId);
      return value;
    } catch (error) {
      if (!run.ready) {
        await this.fail(args.threadId, run, error);
        if (this.blocked.has(args.threadId)) throw new ProviderStartupError("provider_startup_stop_unverified", run.failureCause ?? undefined);
        if (error instanceof Error && "code" in error && error.code === "auth_required" && run.failureCode === "provider_startup_auth_required") throw error;
        run.controller.signal.throwIfAborted();
      }
      throw error;
    } finally {
      this.releaseIfSettled(args.threadId, run);
    }
  }

  async cancel(threadId: string): Promise<boolean> {
    if (this.blocked.has(threadId)) throw new ProviderStartupError("provider_startup_stop_unverified");
    const run = this.active.get(threadId);
    if (!run) return false;
    if (run?.ready) return false;
    await this.interrupt(threadId, run, "provider_startup_cancelled");
    if (this.blocked.has(threadId)) throw new ProviderStartupError("provider_startup_stop_unverified", run.failureCause ?? undefined);
    return true;
  }

  async shutdown(): Promise<void> {
    for (const threadId of [...this.retainedRuns.keys()]) this.requireCleanup(threadId, "provider_startup_cancelled");
    const results = await Promise.allSettled([...this.active.keys()].map((threadId) => this.cancel(threadId)));
    if (this.blocked.size > 0) throw new ProviderStartupError("provider_startup_stop_unverified");
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
  }

  private releaseIfSettled(threadId: string, run: StartupRun): void {
    if (!run.stopSettled && ((!run.ready && !run.prepared) || run.work.size > 0)) return;
    if (run.deadline) clearTimeout(run.deadline);
    if (run.heartbeat) clearInterval(run.heartbeat);
    if (this.active.get(threadId) === run) this.active.delete(threadId);
  }

  private fail(threadId: string, run: StartupRun, error: unknown): Promise<void> {
    if (!run.stopPromise && error instanceof Error) run.failureCause = error;
    const authRequired = error instanceof Error && "code" in error && error.code === "auth_required";
    const code = error instanceof ProviderStartupError ? error.code : authRequired ? "provider_startup_auth_required" : "provider_startup_failed";
    return this.interrupt(threadId, run, code);
  }

  private async interrupt(threadId: string, run: StartupRun, code: ProviderStartupError["code"], work: "drain" | "replacement" = "drain"): Promise<void> {
    if (run.ready) return;
    if (run.stopPromise) return run.stopPromise;
    run.prepared = false;
    const failure = new ProviderStartupError(code, run.failureCause ?? undefined);
    run.failureStage = run.phase === "stopping" || run.phase === "stopped" ? null : run.phase;
    run.phase = "stopping";
    run.failureCode = code;
    run.stopPromise = Promise.resolve().then(async () => {
      try {
        await run.stop();
        if (work === "drain") await Promise.allSettled([...run.work]);
      } catch {
        this.blocked.add(threadId);
      }
      run.stopSettled = true;
      run.phase = "stopped";
      const settled = this.blocked.has(threadId)
        ? new ProviderStartupError("provider_startup_stop_unverified", run.failureCause ?? undefined) : failure;
      this.publish(threadId, run, "failed", settled.code);
      run.reject(settled);
      this.releaseIfSettled(threadId, run);
    });
    run.controller.abort(failure);
    this.publish(threadId, run, "running", code);
    return run.stopPromise;
  }

  private publish(threadId: string, run: StartupRun, status: "running" | "completed" | "failed", code: ProviderStartupError["code"] | null = run.failureCode): void {
    const elapsedMs = Math.max(0, Math.round(performance.now() - run.startedAt));
    const phase = run.phase === "hook" && run.hookEvent
      ? `${run.hookEvent} hook${run.hookId ? ` ${run.hookId}` : ""}${run.hookState ? ` · ${run.hookState}` : ""}`
      : run.phase === "capabilities" ? "Checking required capabilities"
      : run.phase === "stopping" ? "Stopping provider startup"
      : run.phase === "stopped" ? "Provider startup stopped" : "Provider initialization";
    const result = status === "running" && run.controller.signal.aborted
      ? "Stopping only this run’s owned processes; retry waits for confirmed cleanup."
      : code ? new ProviderStartupError(code).message : status === "completed"
        ? "Provider startup ready. Model execution has no startup deadline." : "Native hook details are shown only when reported by the provider.";
    this.emit({
      type: "system/operation", threadId, scope: { kind: "thread" },
      operation: "provider_startup", operationId: run.operationId, status,
      message: `${phase} · ${Math.floor(elapsedMs / 1000)}s elapsed · ${run.policy.deadlineMs / 1000}s startup deadline. ${result}`,
      metadata: {
        phase: run.phase, failureStage: run.failureStage, elapsedMs, deadlineMs: run.policy.deadlineMs,
        hookEvent: run.hookEvent, hookId: run.hookId, hookState: run.hookState,
        code, retryBlocked: this.blocked.has(threadId) || (!run.ready && !run.stopSettled),
        optionalMcpServerCount: run.policy.optionalMcpServers.length,
        feature: "provider-startup", action: "startup", intent: "execute", scope: "thread",
      },
    });
  }
}
