import type { ThreadExecutionBinding } from "@bb/domain";
import type { GatewayLogCoverage } from "@bb/server-contract";

export function gatewayLogCoverage(args: {
  threadId: string;
  binding: ThreadExecutionBinding | null;
  gatewayCompatible: boolean;
  logRootMapped: boolean;
}): GatewayLogCoverage {
  return {
    threadId: args.threadId,
    evidence: "source-contract-only",
    executionContextId: args.binding?.executionContext?.id ?? null,
    modelConnectionId: args.binding?.modelConnection?.id ?? null,
    providerId: args.binding?.modelConnection?.provider ?? null,
    sources: [
      {
        source: "cpa-request-log",
        state: args.gatewayCompatible ? "uninstrumented" : "unsupported",
        representation: "raw",
        reason: args.gatewayCompatible
          ? args.logRootMapped
            ? "A read-only root is mapped to the frozen endpoint. Configuration is not proof of retained payloads, stream completeness, redaction or delivery. Inspect individual native files and their manifests."
            : "No read-only log root is mapped to the frozen endpoint. No alternative endpoint or payer is used."
          : "No compatible persisted CPA binding. Direct-provider traffic is not covered by CPA logs.",
      },
      {
        source: "bridge-recorder",
        state: "uninstrumented",
        representation: "raw",
        reason: "The existing opt-in host-local NDJSON recorder is a separate source. This API has no enrolled recording root, permission or delivery receipt. Recorder lines are not model HTTP bytes; partial, oversized or failed writes are not lossless evidence.",
      },
      {
        source: "native-events",
        state: "metadata-only",
        representation: "normalized",
        reason: "The existing thread timeline exposes provider-normalized events. Event admission ACKs do not acknowledge raw bodies, local recorder files or native transcripts; availability of a particular event must be established from the timeline.",
      },
      {
        source: "native-transcript",
        state: "uninstrumented",
        representation: "transcript",
        reason: "Provider-owned session transcripts require an explicitly selected native source. No auth home or transcript is discovered or read by this endpoint. A transcript is not a network capture.",
      },
      {
        source: "bypass-network",
        state: "uninstrumented",
        representation: "unknown",
        reason: "This endpoint qualifies no traffic population beyond files admitted by the existing CPA endpoint/thread guard. Inspect the actual CPA transport and correlation contract before declaring any other traffic captured or missing; no additional network path is installed.",
      },
      {
        source: "standalone",
        state: "uninstrumented",
        representation: "unknown",
        reason: "The current reader requires an exact inbound BB thread header and frozen endpoint. A standalone CPA correlation must be evidenced by that existing owner; this inspection neither discovers processes nor infers a CPA capability gap.",
      },
      {
        source: "stdio-mcp",
        state: "uninstrumented",
        representation: "unknown",
        reason: "Review actual CPA request/response artifacts for tool schemas, calls and results before identifying an omission. This endpoint adds no independent MCP observer and makes no global claim that CPA lacks a channel.",
      },
      {
        source: "local-tools",
        state: "metadata-only",
        representation: "normalized",
        reason: "Provider-reported tool items may be present in the existing timeline. This is not raw tool I/O, every filesystem syscall or proof that a tool was invoked merely because its schema appears in a model request.",
      },
    ],
    delivery: {
      state: "uninstrumented",
      lastSyncAt: null,
      lastAckAt: null,
      backlogBytes: null,
      backlogEvents: null,
      reason: "No raw-source offline sync/ACK ledger is connected to this API. Unknown backlog is not zero. A retained-file checksum is not a server delivery ACK. The daemon event sink is an in-memory normalized-event queue, not a durable raw-file outbox.",
    },
    privacy: {
      scope: "execution-context",
      redaction: "unverified",
      retention: "source-owned",
      authorization: "existing-owner-api",
    },
  };
}
