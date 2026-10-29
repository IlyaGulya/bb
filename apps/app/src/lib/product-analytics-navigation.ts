import { PERSONAL_PROJECT_ID } from "@bb/domain";

export function productAnalyticsRouteFeature(path: string): string {
  if (path === "/") return "ui.compose";
  if (/^\/projects\/[^/]+\/threads\//.test(path) || path.startsWith("/threads/")) return "ui.thread";
  if (path.startsWith("/settings/appearance")) return "ui.appearance";
  if (path.startsWith("/settings")) return "ui.settings";
  if (path.startsWith("/skills") || path.startsWith("/extensions/skills")) return "ui.skills";
  if (path.includes("/archived")) return "ui.archive";
  const plugin = /^\/plugins\/([a-zA-Z][a-zA-Z0-9_-]*)\/.+/.exec(path);
  if (plugin) return `plugin.${plugin[1]}`;
  if (path.startsWith("/plugins") || path.startsWith("/extensions/plugins")) return "ui.plugins";
  return "ui.navigation";
}
export function productAnalyticsRouteProject(path: string, composeProjectId: string | undefined): string | undefined {
  return /^\/projects\/(proj_[a-zA-Z0-9_-]+)/.exec(path)?.[1] ?? (path.startsWith("/threads/") || path === "/archived" ? PERSONAL_PROJECT_ID : path === "/" || path.startsWith("/plugins/") ? composeProjectId : undefined);
}
