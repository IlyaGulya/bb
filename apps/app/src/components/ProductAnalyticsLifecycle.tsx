import { productAnalyticsRouteFeature as routeFeature, productAnalyticsRouteProject } from "@/lib/product-analytics-navigation";
import { useEffect, useLayoutEffect } from "react";
import { useLocation } from "react-router-dom";
import { useRouteState } from "@/hooks/useRouteState";
import { useRootComposeProjectId } from "@/lib/root-compose-selection";
import { getAppSurface } from "@/lib/app-surface";
import { beginProductAnalyticsNavigation, completeProductAnalyticsNavigation, productAnalyticsInput, productAnalyticsOutbox, recordProductAnalytics, setProductAnalyticsView } from "@/lib/product-analytics";

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
      const targetProjectId = productAnalyticsRouteProject(anchor.pathname, composeProjectId);
      beginProductAnalyticsNavigation(feature, targetProjectId);
    };
    const flush = () => { void productAnalyticsOutbox.flush(); };
    const inputEvents = ["click", "keydown", "submit", "input", "change", "pointerdown", "pointerup"];
    for (const type of inputEvents) document.addEventListener(type, input, true);
    document.addEventListener("click", click);
    window.addEventListener("online", flush);
    const timer = setInterval(flush, 5000);
    void productAnalyticsOutbox.refreshHealth();
    flush();
    return () => {
      for (const type of inputEvents) document.removeEventListener(type, input, true);
      document.removeEventListener("click", click);
      window.removeEventListener("online", flush);
      clearInterval(timer);
    };
  }, [composeProjectId]);
  return null;
}
