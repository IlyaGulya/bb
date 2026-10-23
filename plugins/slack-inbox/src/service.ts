import type { Configuration, Coverage, Status } from "./contract.js";
import { LIMITATIONS, prerequisites } from "./contract.js";
import { parseEvent } from "./events.js";
import { DeliveryQueue, IntakeStore, type Source } from "./store.js";
import {
  createSlackTransport,
  inspectCoverage,
  safeSlackError,
  type Envelope,
  type SlackTransport,
} from "./transport.js";

export type Settings = {
  configuration: Configuration;
  appToken: string;
  botToken: string;
};
export class SlackInboxService {
  private transport: SlackTransport | null = null;
  private settings: Settings;
  private connection: Status["connection"] = "disabled";
  private error: string | null = null;
  private coverage: Coverage[] = [];
  private transition: Promise<void> = Promise.resolve();
  private generation = 0;
  private active = false;
  private retryAt = 0;
  private checking: Promise<void> | null = null;
  readonly delivery: DeliveryQueue;
  constructor(
    readonly store: IntakeStore,
    initial: Settings,
    send: (source: Source) => Promise<void>,
    readonly factory: (
      appToken: string,
      botToken: string,
    ) => SlackTransport = createSlackTransport,
    readonly changed: () => void = () => undefined,
  ) {
    this.settings = initial;
    this.delivery = new DeliveryQueue(
      store,
      () => ({
        ...this.settings.configuration,
        enabled: this.active && this.settings.configuration.enabled,
      }),
      send,
    );
    this.resetCoverage();
    this.connection = initial.configuration.enabled
      ? "unconfigured"
      : "disabled";
  }
  private resetCoverage(): void {
    this.coverage = this.settings.configuration.conversations.map((row) => ({
      ...row,
      state: "unchecked",
      error: null,
      checkedAt: null,
      lastEventAt: null,
    }));
  }
  status(): Status {
    const { configuration, appToken, botToken } = this.settings;
    return {
      configuration,
      credentials: { appToken: !!appToken, botToken: !!botToken },
      connection: this.connection,
      error: this.error,
      lastEventAt: this.numberMeta("lastEventAt"),
      ...this.store.counts(),
      deliveryError: this.store.meta("deliveryError") || null,
      coverage: this.coverage.map((row) => ({
        ...row,
        lastEventAt: this.numberMeta(`event:${configuration.teamId}:${row.id}`),
      })),
      gaps: this.store.gaps(),
      limitations: LIMITATIONS,
    };
  }
  private numberMeta(key: string): number | null {
    const value = this.store.meta(key);
    return value === null ? null : Number(value);
  }
  async run(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    this.active = true;
    this.store.gap(
      "restart_or_initial_setup; no history backfill",
      this.numberMeta("heartbeat") ?? this.store.now(),
    );
    await this.reconfigure(this.settings);
    const timer = setInterval(() => {
      void this.tick().catch(() => this.failure("local_storage_unavailable"));
    }, 5000);
    try {
      const stopped = Promise.withResolvers<void>();
      if (signal.aborted) stopped.resolve();
      else
        signal.addEventListener("abort", () => stopped.resolve(), {
          once: true,
        });
      await stopped.promise;
    } finally {
      clearInterval(timer);
      this.active = false;
      ++this.generation;
      await this.transition;
      const transport = this.transport;
      this.transport = null;
      this.store.gap("service_stopped; no history backfill");
      if (transport) await transport.stop().catch(() => undefined);
      await this.delivery.drain();
    }
  }
  reconfigure(settings: Settings): Promise<void> {
    this.settings = settings;
    const generation = ++this.generation;
    this.resetCoverage();
    this.transition = this.transition
      .catch(() => undefined)
      .then(async () => {
        const previous = this.transport;
        this.transport = null;
        if (previous) await previous.stop().catch(() => undefined);
        if (generation !== this.generation) return;
        this.store.gap(
          "configuration_or_connection_changed; no history backfill",
        );
        const { configuration, appToken, botToken } = this.settings;
        this.error = null;
        if (!configuration.enabled) {
          this.connection = "disabled";
          this.changed();
          return;
        }
        this.error = prerequisites(configuration, appToken, botToken);
        if (this.error) {
          this.connection = "unconfigured";
          this.changed();
          return;
        }
        if (!this.active) return;
        this.connection = "connecting";
        this.changed();
        const transport = this.factory(appToken, botToken);
        this.transport = transport;
        const current = () =>
          this.active &&
          generation === this.generation &&
          this.transport === transport;
        transport.onEnvelope((envelope) => {
          if (!current()) return;
          void this.receive(envelope).catch(() =>
            this.failure(
              "durable_acceptance_failed; envelope not acknowledged",
            ),
          );
        });
        transport.onConnection((connected) => {
          if (!current()) return;
          this.connection = connected ? "connected" : "disconnected";
          this.error = null;
          if (connected) {
            this.store.connected();
            if (this.coverage.some((row) => row.state !== "accessible"))
              this.store.gap("conversation_access_gap; no history backfill");
          } else this.store.gap("socket_disconnected; no history backfill");
          this.changed();
        });
        transport.onError(() => {
          if (current()) this.failure("socket_error");
        });
        try {
          const identity = await transport.authenticate();
          if (!current()) return;
          if (identity.teamId !== configuration.teamId) {
            this.transport = null;
            this.failure("workspace_mismatch");
            await transport.stop();
            return;
          }
          this.coverage = await inspectCoverage(
            transport,
            configuration,
            this.store.now,
          );
          if (!current()) return;
          await transport.start();
        } catch (error) {
          if (current()) this.failure(safeSlackError(error));
        }
        this.changed();
      });
    return this.transition;
  }
  private failure(code: string): void {
    this.error = code;
    this.connection = "error";
    this.retryAt = this.store.now() + 30000;
    try {
      this.store.gap(code);
    } catch {}
    this.changed();
  }
  async receive(envelope: Envelope): Promise<void> {
    const configuration = this.settings.configuration;
    if (!configuration.enabled || !configuration.approved) return;
    const parsed = parseEvent(envelope.body, configuration);
    if (parsed.outcome === "message")
      this.store.accept(parsed.id, parsed.change, configuration.context);
    else if (parsed.outcome === "invalid")
      this.store.gap(
        "unsupported_or_malformed_event; inspect Slack app subscription configuration",
      );
    await envelope.ack();
    this.changed();
    await this.delivery.drain();
  }
  async checkCoverage(): Promise<Status> {
    if (!this.active || !this.transport || this.connection !== "connected")
      return this.status();
    if (!this.checking) {
      const generation = this.generation;
      const transport = this.transport;
      const configuration = this.settings.configuration;
      this.checking = inspectCoverage(transport, configuration, this.store.now)
        .then((coverage) => {
          if (generation !== this.generation) return;
          this.coverage = coverage;
          if (coverage.some((row) => row.state !== "accessible"))
            this.store.gap("conversation_access_gap; no history backfill");
          else this.store.coverageRecovered();
          this.changed();
        })
        .finally(() => {
          this.checking = null;
        });
    }
    await this.checking;
    return this.status();
  }
  async retry(): Promise<Status> {
    if (this.active && this.connection === "error")
      await this.reconfigure(this.settings);
    if (this.active) await this.delivery.drain();
    return this.status();
  }
  private async tick(): Promise<void> {
    if (!this.active) return;
    if (this.connection === "error" && this.store.now() >= this.retryAt)
      await this.reconfigure(this.settings);
    if (this.connection === "connected")
      this.store.setMeta("heartbeat", String(this.store.now()));
    await this.delivery.drain();
    this.changed();
  }
}
