import { open, readFile } from "node:fs/promises";
import { Command } from "commander";
import { z } from "zod";
import { nativeEngineSchema, nativeSessionSourceSchema } from "@bb/host-daemon-contract";
import { nativeImportContinueSchema, type NativeImportManifest, type NativeImportBatch } from "@bb/server-contract";
import { action } from "../../action.js";
import { createCliBbSdk } from "../../client.js";
import { outputJson } from "../helpers.js";

async function sources(path: string) {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  const list = z.array(nativeSessionSourceSchema).safeParse(value);
  if (list.success) return list.data;
  return z.object({ sessions: z.array(nativeSessionSourceSchema) }).parse(value).sessions;
}
function namedId<T extends { id: string; name: string }>(values: T[], token: string, label: string): string {
  const matches = values.filter((entry) => entry.id === token || entry.name === token);
  if (matches.length !== 1) throw new Error(`${label} '${token}' is ${matches.length ? "ambiguous; use its exact ID" : "not available"}.`);
  return matches[0]!.id;
}
function printManifest(manifest: NativeImportManifest) {
  console.log(`${manifest.source.title} · ${manifest.status} · ${manifest.mode}`);
  console.log(`Import: ${manifest.id}\nThread: ${manifest.threadId ?? "not yet registered"}\nProgress: ${manifest.bytes}/${manifest.source.sizeBytes} bytes; ${manifest.records} native records`);
  console.log(manifest.reason);
  if (manifest.error) console.error(manifest.error);
  for (const artifact of manifest.artifacts.filter((entry) => entry.status === "unavailable")) console.error(`Artifact unavailable: ${artifact.reference}: ${artifact.reason}`);
}
export function registerNativeImportCommands(parent: Command, getUrl: () => string): void {
  const command = parent.command("import").description("Discover and archive native OMP, Claude and Codex sessions without starting agents; admit or hand off separately");
  command.command("discover")
    .requiredOption("--host <name-or-id>", "Source machine")
    .requiredOption("--engine <engine>", "omp, claude, or codex")
    .requiredOption("--root <absolute-path>", "Explicit native history directory, not an auth directory")
    .requiredOption("--profile <label>", "Source profile provenance; not an inferred payer")
    .option("--artifact-root <paths...>", "Explicit directories containing referenced blobs/artifacts")
    .option("--cursor <number>", "Discovery cursor", "0")
    .option("--json", "Print source descriptors suitable for --sources")
    .action(action(async (opts: { host: string; engine: string; root: string; profile: string; artifactRoot?: string[]; cursor: string; json?: boolean }) => {
      const sdk = createCliBbSdk(getUrl());
      const hostId = namedId(await sdk.hosts.list(), opts.host, "Machine");
      const result = await sdk.experimental_nativeSessionImports.discover({ hostId, roots: [{ engine: nativeEngineSchema.parse(opts.engine), path: opts.root, profile: opts.profile, artifactRoots: opts.artifactRoot ?? [] }], cursor: z.coerce.number().int().nonnegative().parse(opts.cursor), limit: 100 });
      if (outputJson(opts, result)) return;
      for (const source of result.sessions) console.log(`${source.title}\n  ${source.engine} · ${source.profile} · ${source.cwd ?? "workspace not recorded"}\n  ${source.path} (${source.sizeBytes} bytes)\n  Native ID: ${source.sessionId}`);
      for (const warning of result.warnings) console.error(warning);
      if (result.nextCursor !== null) console.log(`More sources: --cursor ${result.nextCursor}`);
      if (result.incomplete) console.error("Discovery reached its safety boundary. Select a narrower explicit source root.");
    }));
  command.command("preview").requiredOption("--host <name-or-id>", "Source machine").requiredOption("--sources <file>", "Discovery JSON or selected source array")
    .option("--index <number>", "Selected source index", "0").option("--offset <bytes>", "Source byte offset", "0").option("--json", "Print exact bounded source bytes as base64")
    .action(action(async (opts: { host: string; sources: string; index: string; offset: string; json?: boolean }) => {
      const sdk = createCliBbSdk(getUrl());
      const list = await sources(opts.sources);
      const source = list[z.coerce.number().int().nonnegative().parse(opts.index)];
      if (!source) throw new Error("Selected source index is unavailable");
      const result = await sdk.experimental_nativeSessionImports.preview({ hostId: namedId(await sdk.hosts.list(), opts.host, "Machine"), source, offset: z.coerce.number().int().nonnegative().parse(opts.offset), length: 65536 });
      if (!outputJson(opts, result)) { console.log(Buffer.from(result.content, "base64").toString("utf8")); console.log(`Byte window ${result.offset}–${result.offset + Buffer.from(result.content, "base64").length} of ${result.sizeBytes}; no import or model turn started.`); }
    }));
  command.command("start").requiredOption("--host <name-or-id>", "Source machine").requiredOption("--project <name-or-id>", "Destination execution project")
    .requiredOption("--sources <file>", "Selected source descriptors; all entries are archived, never started as agents")
    .option("--json", "Print import handles and per-source failures")
    .action(action(async (opts: { host: string; project: string; sources: string; json?: boolean }) => {
      const sdk = createCliBbSdk(getUrl());
      const hostId = namedId(await sdk.hosts.list(), opts.host, "Machine");
      const projectId = namedId(await sdk.projects.list(), opts.project, "Project");
      const selected = await sources(opts.sources);
      const result: NativeImportBatch = { imports: [], failures: [] };
      for (let offset = 0; offset < selected.length; offset += 100) {
        const batch = await sdk.experimental_nativeSessionImports.start({ selections: selected.slice(offset, offset + 100).map((source) => ({ source, hostId, projectId })) });
        result.imports.push(...batch.imports);
        result.failures.push(...batch.failures.map((failure) => ({ ...failure, index: offset + failure.index })));
      }
      if (!outputJson(opts, result)) { result.imports.forEach(printManifest); result.failures.forEach((failure) => console.error(`Selection ${failure.index}: ${failure.message}`)); }
      if (result.failures.length) process.exitCode = 1;
    }));
  for (const method of ["get", "resume", "cancel"] as const) command.command(`${method} <import-id>`).description(method === "resume" ? "Resume committed import processing, not a model session" : `${method} an import`)
    .option("--json", "Print machine-readable import state").action(action(async (importId: string, opts: { json?: boolean }) => {
      const result = await createCliBbSdk(getUrl()).experimental_nativeSessionImports[method]({ importId });
      if (!outputJson(opts, result)) printManifest(result);
    }));
  command.command("records <import-id>").option("--after <ordinal>", "Last seen record ordinal", "0").option("--query <text>", "Search full retained native content, including tool results", "").option("--json", "Print source mappings and next cursor")
    .action(action(async (importId: string, opts: { after: string; query: string; json?: boolean }) => {
      const result = await createCliBbSdk(getUrl()).experimental_nativeSessionImports.records({ importId, after: z.coerce.number().int().nonnegative().parse(opts.after), limit: 50, query: opts.query });
      if (outputJson(opts, result)) return;
      for (const record of result.records) console.log(`${record.ordinal} · ${record.type} · ${record.timestamp === null ? "timestamp not recorded" : new Date(record.timestamp).toISOString()}\n${record.preview}\n  Original bytes ${record.offset}–${record.offset + record.length}; native ID ${record.nativeId ?? "not recorded"}`);
      if (result.nextAfter !== null) console.log(`Continue: --after ${result.nextAfter}`);
    }));
  command.command("download <import-id>").requiredOption("--output <file>", "New local file; never overwrites an existing source").option("--file <name>", "native, or an artifact file key from the manifest", "native")
    .action(action(async (importId: string, opts: { output: string; file: string }) => {
      const response = await createCliBbSdk(getUrl()).experimental_nativeSessionImports.download({ importId, file: opts.file });
      if (!response.body) throw new Error("Archive download has no response stream");
      const destination = await open(opts.output, "wx", 0o600);
      const reader = response.body.getReader();
      try {
        for (;;) { const result = await reader.read(); if (result.done) break; let offset = 0; while (offset < result.value.length) { const written = await destination.write(result.value, offset, result.value.length - offset); if (!written.bytesWritten) throw new Error("Archive download made no write progress"); offset += written.bytesWritten; } }
        await destination.sync();
      } finally { try { await reader.cancel(); } finally { await destination.close(); } }
      console.log(`Private archive saved to ${opts.output}`);
    }));
  for (const method of ["admit", "handoff"] as const) {
    const continuation = command.command(`${method} <import-id>`)
      .description(method === "admit" ? "Request exclusive native admission without submitting a model turn; unsupported/uncertain ownership refuses" : "Explicitly start a NEW dialogue linked to the archive")
      .requiredOption("--environment <id>", "Existing destination workspace")
      .requiredOption("--model-connection <id>", "Explicit payer/account connection; never inferred from source profile")
      .requiredOption("--execution-context <id-or-none>", "Explicit context selection independent of payer")
      .requiredOption("--model <id>", "Explicit model")
      .requiredOption("--permission-mode <mode>", "accept-edits, auto, or full");
    if (method === "handoff") continuation.requiredOption("--input-file <file>", "Explicit next-turn context, not the whole native JSONL");
    continuation.option("--json", "Print resulting archive/admission/handoff state")
      .action(action(async (importId: string, opts: { environment: string; modelConnection: string; executionContext: string; model: string; permissionMode: string; inputFile?: string; json?: boolean }) => {
        const sdk = createCliBbSdk(getUrl());
        const input = nativeImportContinueSchema.parse({ importId, environmentId: opts.environment, modelConnectionId: opts.modelConnection, executionContextId: opts.executionContext === "none" ? null : opts.executionContext, model: opts.model, permissionMode: opts.permissionMode });
        if (method === "handoff" && !opts.inputFile) throw new Error("Handoff requires --input-file containing explicitly selected next-turn context");
        const result = method === "admit" ? await sdk.experimental_nativeSessionImports.admit(input) : await sdk.experimental_nativeSessionImports.handoff({ ...input, input: await readFile(opts.inputFile!, "utf8") });
        if (!outputJson(opts, result)) printManifest(result);
        if (method === "admit" && result.mode !== "native-admitted") process.exitCode = 1;
      }));
  }
}
