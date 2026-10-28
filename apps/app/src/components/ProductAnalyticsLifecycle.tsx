import { PERSONAL_PROJECT_ID } from "@bb/domain";
import { useEffect, useLayoutEffect } from "react";
import { useLocation } from "react-router-dom";
import { useRouteState } from "@/hooks/useRouteState";
import { useRootComposeProjectId } from "@/lib/root-compose-selection";
import { getAppSurface } from "@/lib/app-surface";
import { beginProductAnalyticsNavigation, completeProductAnalyticsNavigation, productAnalyticsInput, productAnalyticsOutbox, recordProductAnalytics, setProductAnalyticsView } from "@/lib/product-analytics";

function routeFeature(path: string): string | null {
  if (path === "/") return "ui.compose";
  if (/^\/projects\/[^/]+\/threads\//.test(path) || path.startsWith("/threads/")) return "ui.thread";
  if (path.startsWith("/settings")) return "ui.settings";
  if (path.startsWith("/skills") || path.startsWith("/extensions/skills")) return "ui.skills";
  if (path.includes("/archived")) return "ui.archive";
  const plugin = /^\/plugins\/([a-zA-Z][a-zA-Z0-9_-]*)\/.+/.exec(path);
  if (plugin) return `plugin.${plugin[1]}`;
  if (path.startsWith("/plugins") || path.startsWith("/extensions/plugins")) return "ui.plugins";
  return null;
}
export function ProductAnalyticsLifecycle() {
  const location = useLocation();
  const route = useRouteState();
  const [composeProjectId] = useRootComposeProjectId();
  const projectId = route.projectId ?? (route.isRootView || location.pathname.startsWith("/plugins/") ? composeProjectId : undefined);
  useLayoutEffect(() => {
    setProductAnalyticsView(projectId === undefined ? { kind: "instance" } : { kind: "project", projectId }, getAppSurface() === "web" && window.matchMedia("(max-width: 767px)").matches ? "compact" : getAppSurface());
  }, [projectId, location.pathname]);
  useEffect(() => {
    const feature = routeFeature(location.pathname);
    if (feature === null || document.visibilityState !== "visible") return;
    recordProductAnalytics(feature, "open", "exposed", { actorKind: "system" });
    completeProductAnalyticsNavigation(feature);
  }, [location.key, location.pathname, projectId]);
  useEffect(() => {
    const input = (event: Event) => productAnalyticsInput(event);
    const click = (event: MouseEvent) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      if (!(event.target instanceof Element)) return;
      const anchor = event.target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement) || anchor.origin !== window.location.origin || event.defaultPrevented || anchor.target === "_blank") return;
      const feature = routeFeature(anchor.pathname);
      if (feature === null) return;
      const targetProjectId = /^\/projects\/(proj_[a-zA-Z0-9_-]+)/.exec(anchor.pathname)?.[1] ?? (anchor.pathname.startsWith("/threads/") || anchor.pathname === "/archived" ? PERSONAL_PROJECT_ID : anchor.pathname === "/" || anchor.pathname.startsWith("/plugins/") ? composeProjectId : undefined);
      beginProductAnalyticsNavigation(feature, targetProjectId);
    };
    const flush = () => { void productAnalyticsOutbox.flush(); };
    document.addEventListener("click", input, true);
    document.addEventListener("keydown", input, true);
    document.addEventListener("submit", input, true);
    document.addEventListener("click", click, true);
    window.addEventListener("online", flush);
    const timer = setInterval(flush, 5000);
    void productAnalyticsOutbox.refreshHealth();
    flush();
    return () => {
      document.removeEventListener("click", input, true);
      document.removeEventListener("keydown", input, true);
      document.removeEventListener("submit", input, true);
      document.removeEventListener("click", click, true);
      window.removeEventListener("online", flush);
      clearInterval(timer);
    };
  }, [composeProjectId]);
  return null;
}
