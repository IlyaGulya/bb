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
  ...[
    { name: "compose", actions: ["open"], entrypoint: "apps/app/src/components/ProductAnalyticsLifecycle.tsx" },
    { name: "thread", actions: ["open"], entrypoint: "apps/app/src/components/ProductAnalyticsLifecycle.tsx" },
    { name: "settings", actions: ["open"], entrypoint: "apps/app/src/components/ProductAnalyticsLifecycle.tsx" },
    { name: "skills", actions: ["open"], entrypoint: "apps/app/src/components/ProductAnalyticsLifecycle.tsx" },
    { name: "plugins", actions: ["open"], entrypoint: "apps/app/src/components/ProductAnalyticsLifecycle.tsx" },
    { name: "archive", actions: ["open"], entrypoint: "apps/app/src/components/ProductAnalyticsLifecycle.tsx" },
    { name: "workspace", actions: ["open"], entrypoint: "apps/app/src/hooks/useWorkspaceOpenTargets.ts" },
    { name: "commands", actions: ["open", "select"], entrypoint: "apps/app/src/components/commands/CommandPalette.tsx" },
    { name: "search", actions: ["open", "query", "select"], entrypoint: "apps/app/src/components/commands/ThreadSearchPaletteMode.tsx" },
    { name: "appearance", actions: ["open", "theme.select", "mode.select"], entrypoint: "apps/app/src/views/SettingsView.tsx" },
    { name: "onboarding", actions: ["open", "step.select", "finish", "skip"], entrypoint: "apps/app/src/components/onboarding/OnboardingFlow.tsx" },
    { name: "timeline", actions: ["expand", "collapse"], entrypoint: "apps/app/src/components/thread/timeline/ExpandableTimelineRow.tsx" },
    { name: "interactions", actions: ["resolve"], entrypoint: "apps/app/src/hooks/mutations/thread-interaction-mutations.ts" },
    { name: "execution", actions: ["provider.select", "model.select", "reasoning.select", "service-tier.select", "agent-option.select"], entrypoint: "apps/app/src/components/promptbox/ExecutionControls.tsx" },
    { name: "attachments", actions: ["attach"], entrypoint: "apps/app/src/components/thread/embedded-chat/useComposerAttachmentUploads.ts" },
    { name: "voice", actions: ["record", "transcribe"], entrypoint: "apps/app/src/hooks/useVoiceInput.ts" },
    { name: "splits", actions: ["open", "close", "focus", "layout.change", "maximize"], entrypoint: "apps/app/src/lib/split-layout/atoms.ts" },
    { name: "navigation", actions: ["open"], entrypoint: "apps/app/src/components/ui/app-route-anchor.tsx" },
  ].flatMap(({ name, actions, entrypoint }) => actions.map((action): ProductAnalyticsFeature => ({
    featureId: `ui.${name}`, action, version: 1, label: `${name} · ${action}`, entrypoints: [entrypoint], surfaces: ["web", "compact", "mobile", "desktop"],
    coverage: name === "workspace" || name === "interactions" || action === "select" || action === "agent-option.select" ? "admission" : name === "onboarding" && action === "open" ? "observation" : "lifecycle",
    availability: "unknown", limitation: "Actual UI producer. Committed local state, settled results and returned admission are distinct; a host launch acknowledgement or handler dispatch does not prove downstream completion. Platform support is not inferred from the catalog.",
  }))),
  ...["guide", "help", "plugin.new", "plugin.types", "plugin.build", "plugin.dev", "diagnostics.cli-errors", "diagnostics.product-analytics"].map((action): ProductAnalyticsFeature => ({ featureId: "cli.local", action, version: 1, label: `Local CLI · ${action}`, entrypoints: ["apps/cli/src/action.ts", "apps/cli/src/index.ts", `bb ${action.replaceAll(".", " ")}`], surfaces: ["cli", "mcp"], coverage: "lifecycle", availability: "unknown", limitation: "Local command execution and exit, delivered by the shared acknowledged outbox. No command arguments, paths, output or raw errors are collected. Long-running watches are not successful builds merely because they started." })),
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
