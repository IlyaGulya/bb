import { APP_COMMAND_IDS } from "@bb/domain";
import { publicApiRoutes, type ProductAnalyticsFeature } from "@bb/server-contract";
import { LEGACY_ANALYTICS_ROUTES } from "./product-analytics-legacy-routes.js";

export interface AnalyticsRoute extends ProductAnalyticsFeature {
  method: string;
  path: string;
  pattern: RegExp;
  parameters: string[];
}

function isRoute(value: unknown): value is { path: string; method: string } {
  return typeof value === "object" && value !== null && "path" in value && typeof value.path === "string" && "method" in value && typeof value.method === "string";
}

export function analyticsRoutes(): AnalyticsRoute[] {
  const result: AnalyticsRoute[] = [];
  function visit(value: unknown, keys: string[], entrypoint: string): void {
    if (typeof value === "object" && value !== null && "entrypoint" in value && typeof value.entrypoint === "string") entrypoint = value.entrypoint;
    if (isRoute(value)) {
      if (value.path.startsWith("/system/product-analytics") || value.path.startsWith("/system/telemetry")) return;
      const parameters: string[] = [];
      const pattern = value.path.split("/").map((segment) => {
        if (segment.startsWith(":")) {
          parameters.push(segment.slice(1).replace(/\{.*$/, ""));
          return segment.includes("{.+}") ? "(.+)" : "([^/]+)";
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }).join("/");
      result.push({
        featureId: `core.${keys[0]}`,
        action: keys.slice(1).join("."),
        version: 1,
        label: `${keys[0]} · ${keys.slice(1).join(" · ")}`,
        entrypoints: [`${value.method.toUpperCase()} ${value.path}`, entrypoint],
        surfaces: ["web", "compact", "mobile", "desktop", "cli", "sdk", "agent", "mcp", "api"],
        coverage: value.method === "get" ? "observation" : "admission",
        availability: "available",
        limitation: value.method === "get" ? "Reads and refreshes are observations, not intentional use without an explicit intent." : "Measures the action's server admission result, not completion of asynchronous downstream work.",
        method: value.method.toUpperCase(),
        path: value.path,
        pattern: new RegExp(`^${pattern}/?$`),
        parameters,
      });
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, child] of Object.entries(value)) visit(child, [...keys, key], entrypoint);
  }
  visit(publicApiRoutes, [], "packages/server-contract/src/public-api.ts");
  visit(LEGACY_ANALYTICS_ROUTES, [], "apps/server/src/services/system/product-analytics-legacy-routes.ts");
  return result;
}

export const CORE_ANALYTICS_ROUTES = analyticsRoutes();
export const CLIENT_ANALYTICS_FEATURES: ProductAnalyticsFeature[] = [
  { featureId: "core.execution", action: "turn", version: 1, label: "Agent turn execution", entrypoints: ["apps/server/src/internal/events.ts", "turn/started", "turn/completed"], surfaces: ["system"], coverage: "lifecycle", availability: "unknown", limitation: "Runtime result, not user intent; root turns only. System attribution is not counted as human feature selection." },
  ...APP_COMMAND_IDS.map((command): ProductAnalyticsFeature => ({ featureId: "ui.commands", action: command, version: 1, label: `Command · ${command}`, entrypoints: ["apps/app/src/components/commands/AppCommandProvider.tsx"], surfaces: ["web", "compact", "mobile", "desktop"], coverage: "admission", availability: "unknown", limitation: "Actual command dispatch result; accepted handler invocation is not downstream asynchronous completion." })),
  ...["compose", "thread", "settings", "skills", "plugins", "archive", "workspace", "search", "commands", "appearance", "onboarding", "timeline", "interactions", "execution", "attachments", "voice", "splits", "navigation"].map((name): ProductAnalyticsFeature => ({
    featureId: `ui.${name}`, action: "open", version: 1, label: name[0]!.toUpperCase() + name.slice(1),
    entrypoints: ["apps/app/src", ".bb/skills/verify-bb/INVENTORY.md"],
    surfaces: ["web", "compact", "mobile", "desktop"],
    coverage: ["compose", "thread", "settings", "skills", "plugins", "archive"].includes(name) ? "lifecycle" : "gap",
    availability: "unknown",
    limitation: "Open/visibility is separate from server action results. Local controls without a declared semantic event remain a visible coverage gap.",
  })),
  ...[
    { action: "guide", label: "Local CLI guide", entrypoints: ["bb guide"] },
    { action: "help", label: "Local CLI help", entrypoints: ["bb --help", "bb <command> --help"] },
    { action: "plugin.authoring", label: "Local plugin authoring CLI", entrypoints: ["bb plugin new", "bb plugin types", "bb plugin build", "bb plugin dev", "bb plugin run"] },
    { action: "diagnostics.cli-errors", label: "Local CLI error diagnostics", entrypoints: ["bb diagnostics cli-errors"] },
  ].map((feature): ProductAnalyticsFeature => ({ ...feature, featureId: "cli.local", version: 1, surfaces: ["cli"], coverage: "gap", availability: "unknown", limitation: "Local-only execution has no server action receipt; it is not inferred from SDK traffic or reported as zero popularity." })),
  ...["demo.player", "demo.pipeline"].map((name): ProductAnalyticsFeature => ({
    featureId: name, action: "run", version: 1, label: name === "demo.player" ? "Video player / acceptance gate (BBDEV-39)" : "Demo pipeline (BBDEV-42)",
    entrypoints: [name === "demo.player" ? "BBDEV-39" : "BBDEV-42"], surfaces: ["web", "compact", "cli", "sdk", "agent"],
    coverage: "gap", availability: "unavailable", limitation: "Separate capability; pending integration by its owning task.",
  })),
];

export function pluginAnalyticsFeature(pluginId: string, action: string, surfaces: ProductAnalyticsFeature["surfaces"], coverage: ProductAnalyticsFeature["coverage"] = "admission"): ProductAnalyticsFeature {
  return {
    featureId: `plugin.${pluginId}`, action, version: 1, label: `${pluginId} · ${action}`,
    entrypoints: ["apps/server/src/services/plugins/plugin-service.ts", `plugin:${pluginId}:${action}`],
    surfaces, coverage, availability: "available",
    limitation: coverage === "lifecycle" ? null : "Handler outcome; asynchronous external work requires its own declared completion event. No payloads are collected.",
  };
}
