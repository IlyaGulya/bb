import { useThread } from "@/hooks/queries/thread-queries";
import { createElement, useEffect, type ComponentType, type ReactNode } from "react";
import { beginProductAnalyticsAction, declareProductAnalyticsLocalActions, productAnalyticsOutbox, recordProductAnalytics, withProductAnalyticsOperation } from "./product-analytics";
import type { ProductAnalyticsLocalActions, ProductAnalyticsScope } from "@bb/server-contract";

const declarations = new Map<string, Map<string, ProductAnalyticsLocalActions["actions"][number]>>();
export function resetPluginLocalAnalytics(pluginId: string): void { declarations.delete(pluginId); }
function declare(pluginId: string, action: string, coverage: "lifecycle" | "observation") {
  let actions = declarations.get(pluginId);
  if (actions === undefined) { actions = new Map(); declarations.set(pluginId, actions); }
  actions.set(action, { action, coverage });
}
export function publishPluginLocalAnalytics(pluginId: string): void {
  const actions = [...(declarations.get(pluginId)?.values() ?? [])];
  if (actions.length === 0) return;
  void declareProductAnalyticsLocalActions({ pluginId, actions }).then((ok) => { if (!ok) productAnalyticsOutbox.noteGap(); }, () => productAnalyticsOutbox.noteGap());
}
function Consumption({ pluginId, action, children, sourceProps }: { pluginId: string; action: string; children: ReactNode; sourceProps: Record<string, unknown> }) {
  const threadId = typeof sourceProps.threadId === "string" ? sourceProps.threadId : "";
  const thread = useThread(threadId, { enabled: threadId !== "" });
  const projectId = threadId !== "" ? thread.data?.projectId : typeof sourceProps.projectId === "string" && /^proj_[a-zA-Z0-9_-]+$/.test(sourceProps.projectId) ? sourceProps.projectId : undefined;
  useEffect(() => {
    if (threadId !== "" && projectId === undefined) {
      if (thread.isError) productAnalyticsOutbox.noteGap();
      return;
    }
    recordProductAnalytics(`ui.plugin.${pluginId}`, action, "opened", { actorKind: "unknown", ...(projectId === undefined ? {} : { scope: { kind: "project", projectId } }) });
  }, [action, pluginId, projectId, thread.isError, threadId]);
  return children;
}
function instrumentObject<T extends object>(pluginId: string, prefix: string, registration: T, scope?: ProductAnalyticsScope): T {
  const wrapped = new Map<PropertyKey, unknown>();
  return new Proxy({ ...registration }, {
    get(target, property, receiver) {
      if (wrapped.has(property)) return wrapped.get(property);
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property === "component") {
        const Component = value as ComponentType<Record<string, unknown>>;
        function ObservedComponent(props: Record<string, unknown>) {
          return createElement(Consumption, { pluginId, action: `${prefix}.mount`, sourceProps: props, children: createElement(Component, props) });
        }
        wrapped.set(property, ObservedComponent);
        return ObservedComponent;
      }
      if (property !== "run" && property !== "onActivate" && property !== "item") return value;
      const callback = new Proxy(value, {
        apply(fn, thisArg, args) {
          if (property === "item") {
            const input: unknown = args[0];
            const thread = typeof input === "object" && input !== null && "thread" in input ? input.thread : null;
            const targetScope = typeof thread === "object" && thread !== null && "projectId" in thread && typeof thread.projectId === "string" && /^proj_[a-zA-Z0-9_-]+$/.test(thread.projectId) ? { kind: "project" as const, projectId: thread.projectId } : scope;
            const result: unknown = Reflect.apply(fn, thisArg, args);
            return typeof result === "object" && result !== null ? instrumentObject(pluginId, prefix, result, targetScope) : result;
          }
          const operation = beginProductAnalyticsAction(`ui.plugin.${pluginId}`, `${prefix}.run`, scope);
          try {
            const result: unknown = withProductAnalyticsOperation(operation, () => Reflect.apply(fn, thisArg, args));
            void Promise.resolve(result).then((value) => operation.complete(value === false ? "denied" : "succeeded", value === false ? "unavailable" : "none"), () => operation.complete("failed", "internal"));
            return result;
          } catch (error) {
            void operation.complete("failed", "internal");
            throw error;
          }
        },
      });
      wrapped.set(property, callback);
      return callback;
    },
  });
}
export function instrumentPluginLocalRegistration<T extends object>(pluginId: string, kind: string, registration: T): T {
  if (!("id" in registration) || typeof registration.id !== "string") return registration;
  const prefix = `slot.${kind}.${registration.id}`;
  if (("run" in registration && typeof registration.run === "function") || ("onActivate" in registration && typeof registration.onActivate === "function") || kind === "threadActions") declare(pluginId, `${prefix}.run`, "lifecycle");
  if ("component" in registration && typeof registration.component === "function") declare(pluginId, `${prefix}.mount`, "observation");
  return instrumentObject(pluginId, prefix, registration);
}
