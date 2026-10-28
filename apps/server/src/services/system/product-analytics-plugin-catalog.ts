import { createHash } from "node:crypto";
import type { ProductAnalyticsFeature } from "@bb/server-contract";
import type { PluginService } from "../plugins/plugin-service.js";
import { pluginAnalyticsFeature } from "./product-analytics-catalog.js";

export function pluginAnalyticsAction(kind: string, declaredName: string): string {
  const safe = /^[a-zA-Z][a-zA-Z0-9_.-]{0,89}$/.test(declaredName) ? declaredName : `registered-${createHash("sha256").update(declaredName).digest("hex").slice(0, 20)}`;
  return `${kind}.${safe}`;
}
export function livePluginAnalyticsCatalog(plugins: PluginService): ProductAnalyticsFeature[] {
  const catalog: ProductAnalyticsFeature[] = [];
  for (const plugin of plugins.list()) {
    const available = plugin.enabled && plugin.status === "running";
    catalog.push({ ...pluginAnalyticsFeature(plugin.id, "open", ["web", "compact", "mobile", "desktop"], plugin.app.hasApp ? "lifecycle" : "gap"), availability: available && plugin.app.hasApp ? "available" : "unavailable", limitation: plugin.app.hasApp ? "Plugin page entry; individual local controls require a declared semantic action." : "No app surface is currently available." });
    for (const capability of plugin.capabilities) {
      catalog.push({ ...pluginAnalyticsFeature(plugin.id, pluginAnalyticsAction(capability.kind, capability.id), ["agent", "sdk", "web", "compact"], capability.kind === "agent-tool" ? "admission" : "gap"), availability: available ? "available" : "unavailable", limitation: capability.kind === "agent-tool" ? "Native agent tool result is observed; external downstream effects are not assumed." : "Declared capability; semantic local completion coverage is not yet declared." });
    }
  }
  catalog.push(...plugins.listAnalyticsFeatures());
  for (const cli of plugins.listCliContributions()) {
    catalog.push(pluginAnalyticsFeature(cli.pluginId, "cli.root", ["cli"]));
    catalog.push(pluginAnalyticsFeature(cli.pluginId, "cli.help", ["cli", "mcp"]));
    for (const command of cli.commands) catalog.push(pluginAnalyticsFeature(cli.pluginId, pluginAnalyticsAction("cli", command.name), ["cli"]));
  }
  return catalog;
}

export function pluginCliAnalyticsAction(registration: { name: string; commands: readonly { name: string; usage: string }[] } | null | undefined, argv: readonly string[]): string {
  if (!registration) return "cli.root";
  const terminator = argv.indexOf("--");
  const scanned = terminator === -1 ? argv : argv.slice(0, terminator);
  if (argv[0] === "help" || scanned.includes("--help") || scanned.includes("-h")) return "cli.help";
  let action = "cli.root";
  let longest = 0;
  for (const command of registration.commands) {
    const tokens = command.usage.trim().split(/\s+/);
    const path = tokens[0] === "bb" && tokens[1] === registration.name ? tokens.slice(2) : [command.name];
    const words: string[] = [];
    for (const word of path) {
      if (!/^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*$/.test(word)) break;
      words.push(word);
    }
    if (words.length > longest && words.every((word, index) => argv[index] === word)) {
      longest = words.length;
      action = pluginAnalyticsAction("cli", command.name);
    }
  }
  return action;
}
