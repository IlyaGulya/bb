import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { Command } from "commander";
import { captureCreateSchema, type CaptureCreate } from "@bb/server-contract";
import { CAPTURE_MAX_ARTIFACT_BYTES, type CaptureScope, type CaptureManifest } from "@bb/domain";
import { action, CliUsageError } from "../action.js";
import { createCliBbSdk } from "../client.js";
import { outputJson } from "./helpers.js";

interface Options {
  project: string;
  context: string;
  json?: boolean;
  thread?: string;
  host?: string;
  model?: string;
  runtime?: string;
  session?: string;
  run?: string;
  source?: CaptureManifest["source"];
  destination?: string;
  after?: string;
  operation?: string;
  limit: string;
  output?: string;
  file?: string;
  representation?: string;
  streamState?: string;
  reviewed?: boolean;
  previewBytes?: string;
}
function scope(options: Options): CaptureScope { return { projectId: options.project, executionContextId: options.context }; }
function invalid(message: string): never { throw new CliUsageError({ code: "capture_invalid", message, hint: null }); }
function limit(value: string, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) invalid(`Expected an integer from 1 through ${maximum}.`);
  return parsed;
}
async function readPrivateFile(path: string, maximum: number): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 || (process.getuid !== undefined && before.uid !== process.getuid()) || before.size < 1 || before.size > maximum) invalid("Capture input must be an owned private regular file within the source limit.");
    const bytes = Buffer.allocUnsafe(before.size);
    for (let offset = 0; offset < bytes.length;) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) invalid("Capture input changed while reading.");
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) invalid("Capture input changed while reading.");
    return bytes;
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    return invalid("Private capture input is unavailable or unsafe.");
  } finally {
    try { await handle?.close(); } catch { invalid("Private capture input could not be closed safely."); }
  }
}
function scoped(command: Command): Command {
  return command.requiredOption("--project <id>", "Actual Core project, never a tracker project or payer account")
    .requiredOption("--context <id>", "Exact execution-context permission scope");
}
function output(options: { json?: boolean }, value: unknown): void { if (!outputJson(options, value)) console.log(JSON.stringify(value, null, 2)); }
export function registerPrivateCapturesCommands(program: Command, getUrl: () => string): void {
  const captures = program.command("captures").description("Opt-in private capture data, scoped persistence, deterministic ACK and explicit source gaps");
  captures.command("create").description("Create one explicit full-content capture from a reviewed JSON subject/policy file; does not enable provider logging")
    .requiredOption("--file <path>", "CaptureCreate JSON; preserve its UUID when retrying")
    .option("--json", "Print the capture receipt as JSON")
    .action(action(async (options: { file: string; json?: boolean }) => {
      const bytes = await readPrivateFile(options.file, 65536);
      let input: CaptureCreate;
      try { const value: unknown = JSON.parse(bytes.toString("utf8")); input = captureCreateSchema.parse(value); }
      catch { invalid("Invalid private capture subject or policy JSON."); }
      const value = await createCliBbSdk(getUrl()).experimental_privateCaptures.create(input);
      output(options, value);
    }));
  scoped(captures.command("list").description("List only explicitly selected project/context capture data"))
    .option("--thread <id>", "Exact thread") .option("--host <id>", "Actual execution machine")
    .option("--model <id>", "Frozen configured model") .option("--runtime <id>", "Native runtime")
    .option("--session <id>", "Explicit native session") .option("--after <id>", "Capture UUID cursor")
    .option("--limit <count>", "Page size, 1–100", "25") .option("--json", "Print JSON")
    .action(action(async (options: Options) => output(options, await createCliBbSdk(getUrl()).experimental_privateCaptures.list({ ...scope(options), threadId: options.thread, hostId: options.host, model: options.model, runtimeId: options.runtime, nativeSessionId: options.session, after: options.after, limit: limit(options.limit, 100) }))));
  for (const operation of ["show", "stop", "sync"] as const) {
    scoped(captures.command(`${operation} <captureId>`).description(operation === "sync" ? "Flush one bounded batch now; committed ACKs allow safe replay" : operation === "stop" ? "Stop new Core intake; disconnected host collection stops by its explicit lease deadline" : "Show exact scope, last-sync/ACK, pending data and source gaps"))
      .option("--json", "Print JSON")
      .action(action(async (captureId: string, options: Options) => {
        const api = createCliBbSdk(getUrl()).experimental_privateCaptures;
        output(options, await api[operation === "show" ? "get" : operation]({ ...scope(options), captureId }));
      }));
  }
  scoped(captures.command("link <captureId>").description("Associate owned standalone evidence with a same-context Core thread/run without rewriting its origin"))
    .requiredOption("--thread <id>", "Existing Core thread in the exact project/context")
    .requiredOption("--operation <uuid>", "Opaque logical association UUID; reuse on retry")
    .option("--run <id>", "Existing turn/run in that thread") .option("--json", "Print association metadata")
    .action(action(async (captureId: string, options: Options) => output(options, await createCliBbSdk(getUrl()).experimental_privateCaptures.link({ ...scope(options), captureId, threadId: options.thread!, runId: options.run ?? null, operationId: options.operation! }))));
  scoped(captures.command("artifacts <captureId>").description("Index raw, normalized and supplied evidence separately; no payloads printed"))
    .option("--source <kind>", "cpa-request-log, bridge-recorder, native-events, native-transcript or owner-import")
    .option("--destination <url>", "Exact source-reported destination, not an inferred provider")
    .option("--host <id>", "Known source machine, not the capture's selected machine")
    .option("--run <id>", "Actual source-reported Core turn/run")
    .option("--session <id>", "Actual source-reported native session")
    .option("--model <id>", "Source-reported model label, not payer/upstream certification")
    .option("--after <digest>", "Artifact cursor") .option("--limit <count>", "Page size, 1–100", "25")
    .option("--json", "Print JSON")
    .action(action(async (captureId: string, options: Options) => output(options, await createCliBbSdk(getUrl()).experimental_privateCaptures.artifacts({ ...scope(options), captureId, source: options.source, destination: options.destination, hostId: options.host, runId: options.run, nativeSessionId: options.session, model: options.model, after: options.after, limit: limit(options.limit, 100) }))));
  scoped(captures.command("inspect <captureId> <artifactId>").description("Inspect metadata/checksums, with an explicit bounded payload preview only on request"))
    .option("--preview-bytes <count>", "Read private payload preview, 1–262144; binary is base64")
    .option("--json", "Print JSON")
    .action(action(async (captureId: string, artifactId: string, options: Options) => {
      const api = createCliBbSdk(getUrl()).experimental_privateCaptures;
      const input = { ...scope(options), captureId, artifactId };
      output(options, options.previewBytes === undefined ? await api.artifact(input) : await api.preview({ ...input, previewBytes: limit(options.previewBytes, 262144) }));
    }));
  scoped(captures.command("download <captureId> <artifactId>").description("Verify full stored SHA-256 and save to a new private file; never dump raw bodies to stdout"))
    .requiredOption("--output <path>", "New mode-0600 file on this invoking machine") .option("--json", "Print save metadata")
    .action(action(async (captureId: string, artifactId: string, options: Options) => {
      const blob = await createCliBbSdk(getUrl()).experimental_privateCaptures.download({ ...scope(options), captureId, artifactId });
      try { await writeFile(options.output!, new Uint8Array(await blob.arrayBuffer()), { flag: "wx", mode: 0o600 }); }
      catch { invalid("Private output could not be created; choose a new writable file."); }
      output(options, { captureId, artifactId, sizeBytes: blob.size, integrity: "verified-stored-sha256" });
    }));
  scoped(captures.command("import <captureId>").description("Upload reviewed local native/standalone evidence through the shared redaction/chunk/ACK SDK path; retry the same file to resume"))
    .requiredOption("--file <path>", "Exact owned evidence file, not an auth home or credential export")
    .requiredOption("--operation <uuid>", "Opaque logical import UUID; reuse on retry, never derive it from payload hashes")
    .requiredOption("--representation <kind>", "raw, transcript or binary")
    .requiredOption("--stream-state <state>", "complete, interrupted or unknown; report only what the source establishes")
    .requiredOption("--reviewed", "Owner confirms private scope/export permission and no auth material") .option("--json", "Print manifest metadata, never payloads")
    .action(action(async (captureId: string, options: Options) => {
      if (!options.reviewed || !["raw", "transcript", "binary"].includes(options.representation ?? "") || !["complete", "interrupted", "unknown"].includes(options.streamState ?? "")) invalid("Review, representation and stream state are required.");
      const bytes = await readPrivateFile(options.file!, CAPTURE_MAX_ARTIFACT_BYTES);
      const representation = options.representation === "binary" ? "binary" : options.representation === "transcript" ? "transcript" : "raw";
      const streamState = options.streamState === "complete" ? "complete" : options.streamState === "interrupted" ? "interrupted" : "unknown";
      const value = await createCliBbSdk(getUrl()).experimental_privateCaptures.upload({ ...scope(options), captureId, operationId: options.operation!, sourceId: basename(options.file!), file: new Blob([new Uint8Array(bytes)]), representation, streamState, binaryReview: "owner-reviewed-no-auth-material" });
      output(options, value);
    }));
}
