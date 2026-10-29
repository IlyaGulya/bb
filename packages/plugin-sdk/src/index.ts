/**
 * `@get-bb/plugin-sdk` — the typed facade plugin authors compile against.
 *
 * The root export carries the side-effect-free app and host-contract types
 * plus the backend contract (`BbPluginApi`, the
 * `server.ts` factory argument — types only, implemented by the BB server).
 * The `./app` subpath adds the runtime bindings that `bb plugin build` shims
 * to the host's shared runtime.
 */
export * from "./app-contract.js";
export * from "./backend-contract.js";
export * from "./cli-spec.js";
export * from "./host-contract.js";
export type * from "./json-value.js";
export * from "./rpc-contract.js";
export { experimental_THREAD_ACTION_GROUPS } from "./thread-action-groups.js";
export { providerExecutionReadinessBlocker as experimental_providerExecutionReadinessBlocker } from "@bb/domain";
export type { ProviderReadiness } from "@bb/domain";
export type {
  ExperimentalDesktopBrowsersArea,
  ExperimentalDesktopBrowserScope,
  ExperimentalDesktopBrowserLease,
  ExperimentalDesktopBrowserCreateInput,
  ExperimentalDesktopBrowserAcquireInput,
} from "@bb/sdk";
export { taskRouteDecisionSchema as experimental_taskRouteDecisionSchema } from "@bb/domain";
export type { TaskRouteRequest as ExperimentalTaskRouteRequest, TaskRouteResponse as ExperimentalTaskRouteResponse } from "@bb/domain";

export type * from "./machine-bootstrap.js";
