import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import { action, CliUsageError } from "../action.js";
import { createCliBbSdk } from "../client.js";
import { columnWidths, printBorderlessTable } from "../table.js";
import { outputJson } from "./helpers.js";

interface GatewayLogListOptions {
  thread: string;
  json?: boolean;
}

interface GatewayLogReadOptions extends GatewayLogListOptions {
  previewBytes?: string;
  output?: string;
}

export function registerGatewayLogsCommands(
  program: Command,
  getUrl: () => string,
): void {
  const logs = program
    .command("gateway-logs")
    .description("Inspect private gateway request logs bound to a thread");

  logs
    .command("list")
    .description("List available logs without printing their contents")
    .requiredOption("--thread <id>", "Thread whose persisted gateway binding owns the logs")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: GatewayLogListOptions) => {
        const result = await createCliBbSdk(getUrl()).experimental_gatewayLogs.list({
          threadId: opts.thread,
        });
        if (outputJson(opts, result)) return;
        const rows = result.entries.map((entry) => [
          entry.id,
          String(entry.createdAt),
          String(entry.sizeBytes),
        ]);
        if (rows.length === 0) {
          console.log("No gateway logs found");
        } else {
          printBorderlessTable(
            {
              head: ["Log", "Created", "Bytes"],
              colWidths: columnWidths(rows, [3, 7, 5]),
              trimTrailingWhitespace: true,
            },
            rows,
          );
        }
        if (result.scanTruncated) console.error("Log scan truncated; this list may be incomplete.");
        if (result.unavailableFiles > 0) {
          console.error(`${result.unavailableFiles} log file(s) unavailable during the scan.`);
        }
      }),
    );

  logs
    .command("read <logId>")
    .description("Print a bounded raw preview, or download the full private log to --output")
    .requiredOption("--thread <id>", "Thread whose persisted gateway binding owns the log")
    .option("--preview-bytes <bytes>", "Preview byte limit (1–262144; default 65536)")
    .option("--output <path>", "Download the full log to a new private file instead of stdout")
    .option("--json", "Print preview and explicit truncation metadata as JSON")
    .action(
      action(async (logId: string, opts: GatewayLogReadOptions) => {
        if (opts.output !== undefined && opts.previewBytes !== undefined) {
          throw new CliUsageError({
            code: "invalid_options",
            hint: null,
            message: "--output and --preview-bytes cannot be combined.",
          });
        }
        const sdk = createCliBbSdk(getUrl());
        if (opts.output !== undefined) {
          const blob = await sdk.experimental_gatewayLogs.download({
            threadId: opts.thread,
            logId,
          });
          await writeFile(opts.output, new Uint8Array(await blob.arrayBuffer()), {
            flag: "wx",
            mode: 0o600,
          });
          if (!outputJson(opts, { logId, output: opts.output, sizeBytes: blob.size })) {
            console.log(`Saved ${blob.size} bytes to ${opts.output}`);
          }
          return;
        }
        const previewBytes = opts.previewBytes === undefined ? 65536 : Number(opts.previewBytes);
        if (!Number.isInteger(previewBytes) || previewBytes < 1 || previewBytes > 262144) {
          throw new CliUsageError({
            code: "invalid_preview_bytes",
            hint: null,
            message: "--preview-bytes must be an integer from 1 to 262144.",
          });
        }
        const result = await sdk.experimental_gatewayLogs.read({
          threadId: opts.thread,
          logId,
          previewBytes,
        });
        if (outputJson(opts, result)) return;
        console.error(
          `Gateway log preview: ${result.previewBytes} byte limit, ${result.sizeBytes} total bytes; truncated: ${result.truncated ? "yes (use --output <path> for the full log)" : "no"}.`,
        );
        process.stdout.write(result.raw);
      }),
    );
}
