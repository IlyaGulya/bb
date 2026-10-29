import type { BridgeProtocolAdapter } from "./bridge-protocol-adapter.js";
import type { AgentRuntimeExecutionOptions } from "./types.js";
import type { ProviderExecutionContext } from "./provider-adapter.js";
import type { RuntimePermissionPolicy } from "@bb/domain";
import { executionContextSnapshotSchema } from "@bb/domain";
import { ProviderStartupError } from "./runtime-startup.js";

interface AssertProviderSupportsExecutionOptionsArgs {
  adapter: BridgeProtocolAdapter;
  options: AgentRuntimeExecutionOptions;
  providerId: string;
}

interface ToProviderExecutionContextArgs {
  envVars: Record<string, string>;
  execOpts: AgentRuntimeExecutionOptions;
  instructions: string | undefined;
}

export function assertProviderSupportsExecutionOptions(
  args: AssertProviderSupportsExecutionOptionsArgs,
): void {
  const contextValue = args.options.providerOptions?.executionContext;
  if (contextValue !== undefined && contextValue !== null) {
    const context = executionContextSnapshotSchema.parse(contextValue);
    const policy = context.startupPolicy;
    if (policy && args.adapter.startupReadiness !== "native-init" && context.mcpServers.some((server) => !policy.optionalMcpServers.includes(server.name))) {
      throw new ProviderStartupError("provider_startup_capability_unverified");
    }
  }
  if (
    args.options.serviceTier !== undefined &&
    args.options.serviceTier !== "default" &&
    !args.adapter.capabilities.supportsServiceTier
  ) {
    throw new Error(
      `Provider "${args.providerId}" does not support service tiers.`,
    );
  }

  if (
    !args.adapter.capabilities.permissionModes.includes(
      args.options.permissionMode,
    )
  ) {
    throw new Error(
      `Provider "${args.providerId}" does not support permission mode "${args.options.permissionMode}".`,
    );
  }
}

export function toProviderExecutionContext(
  args: ToProviderExecutionContextArgs,
): ProviderExecutionContext {
  const permissionPolicy: RuntimePermissionPolicy = args.execOpts;
  return {
    model: args.execOpts.model,
    serviceTier: args.execOpts.serviceTier,
    reasoningLevel: args.execOpts.reasoningLevel,
    ...(args.execOpts.promptMode !== undefined
      ? { promptMode: args.execOpts.promptMode }
      : {}),
    ...(args.execOpts.sessionOptions !== undefined
      ? { sessionOptions: args.execOpts.sessionOptions }
      : {}),
    providerOptions: args.execOpts.providerOptions,
    ...permissionPolicy,
    instructions: args.instructions,
    envVars: args.envVars,
  };
}
