import { Command } from "commander";
import { productAnalyticsReportQuerySchema } from "@bb/server-contract";
import { action } from "../action.js";
import { createCliBbSdk } from "../client.js";
import { columnWidths, printBorderlessTable } from "../table.js";
import { outputJson } from "./helpers.js";

export function registerAnalyticsCommands(program: Command, getUrl: () => string): void {
  program.command("analytics")
    .description("Inspect owner-local feature usage, outcomes, coverage and delivery health")
    .option("--project <id>", "One logical project scope; omission selects instance-only activity, never all projects")
    .option("--days <days>", "Window in days (1–30)", "7")
    .option("--mode <mode>", "production, preview, smoke or test", "production")
    .option("--actor <actor>", "human, agent, system or unknown")
    .option("--surface <surface>", "Filter a declared entry surface")
    .option("--release <version>", "Filter one server release")
    .option("--json", "Print report including catalog and delivery diagnostics")
    .action(action(async (options: { project?: string; days: string; mode: string; actor?: string; surface?: string; release?: string; json?: boolean }) => {
      const query = productAnalyticsReportQuerySchema.parse({ projectId: options.project, days: options.days, mode: options.mode, actorKind: options.actor, surface: options.surface, release: options.release });
      const report = await createCliBbSdk(getUrl()).experimental_productAnalytics.report(query);
      if (outputJson(options, report)) return;
      console.log(`Private feature analytics · ${report.scope.kind === "project" ? report.scope.projectId : "instance only"} · ${report.mode} · ${query.days} days`);
      console.log(`Delivery: ${report.diagnostics.pending} pending · ${report.diagnostics.failed} failed · ${report.diagnostics.gaps} scope gaps · ${report.diagnostics.instanceGaps} instance diagnostic gaps · storage ${report.diagnostics.storage}`);
      const rows = report.rows.map((row) => [row.label, row.coverage, row.availability, String(row.attempts), String(row.successes), String(row.failures + row.denied), String(row.human), String(row.agent), row.averageDurationMs === null ? "—" : `${Math.round(row.averageDurationMs)}ms`]);
      printBorderlessTable({ head: ["Feature / action", "Coverage", "Available", "Tried", "Succeeded", "Failed/denied", "Human", "Agent", "Duration"], colWidths: columnWidths(rows, [16, 8, 9, 5, 9, 13, 5, 5, 8]), trimTrailingWhitespace: true }, rows);
      console.log("A gap or unknown availability is not zero popularity. Accepted asynchronous actions are not completed results. No feature is removed automatically.");
    }));
}
