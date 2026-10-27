import type {
  AvailableModel,
  ModelConnectionSnapshot,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  experimental_gatewayChildEnv as gatewayChildEnv,
  experimental_hasGatewayReceipt as hasGatewayReceipt,
  experimental_pinGatewayReceipt as pinGatewayReceipt,
  experimental_listGatewayModelIds as listGatewayModelIds,
  experimental_requireGatewayModel as requireGatewayModel,
  experimental_resolveGatewayCredential as resolveGatewayCredential,
  type experimental_ModelGateway as ModelGateway,
} from "@get-bb/plugin-sdk/provider-bridge";

export const CLAUDE_GATEWAY_CLOUD_LIMITATION =
  "Claude Code CPA routing uses explicit client-key authentication. Native Claude.ai Cloud MCP connectors are unavailable in this mode; selected direct MCP servers and bb-bridge remain available. An explicit native MCP profile instead authorizes native account Cloud and native user/project MCP sources, subject to native OAuth and connected-connector admission. Model capabilities and token budgets are unknown until reported by the gateway/native runtime.";

export function requireClaudeGateway(
  connection: ModelConnectionSnapshot,
): ModelGateway {
  const gateway = connection.gateway;
  if (
    connection.provider !== "claude-code" ||
    !connection.enabled ||
    connection.revoked ||
    !gateway ||
    gateway.protocol !== "anthropic-messages"
  ) {
    throw new Error(
      "Native Claude Code requires an enabled anthropic-messages gateway connection. No native account or model fallback was selected.",
    );
  }
  if (
    connection.nativeAuth.configDir !== null ||
    connection.nativeAuth.profile !== null ||
    connection.nativeAuth.hostEnv !== null
  ) {
    throw new Error(
      "Claude gateway routing cannot combine client credentials with native authentication references.",
    );
  }
  return gateway;
}

export async function listClaudeGatewayModels(
  connection: ModelConnectionSnapshot,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ models: AvailableModel[]; selectedOnlyModels: AvailableModel[] }> {
  const gateway = requireClaudeGateway(connection);
  const key = resolveGatewayCredential(gateway, env);
  const ids = await listGatewayModelIds(gateway, key);
  return {
    models: ids.map((id) => ({
      id: `bb-cpa/${id}`,
      model: `bb-cpa/${id}`,
      displayName: id,
      description: CLAUDE_GATEWAY_CLOUD_LIMITATION,
      supportedReasoningEfforts: [],
      defaultReasoningEffort: "none",
      isDefault: false,
    })),
    selectedOnlyModels: [],
  };
}

export function claudeGatewayModel(
  model: string | undefined,
  connection: ModelConnectionSnapshot,
): string {
  if (!model) {
    throw new Error(
      "Claude gateway routing requires an explicit supported bb-cpa/<account>/<model> selection; native defaults are not used.",
    );
  }
  return requireGatewayModel(model, requireClaudeGateway(connection), [
    { id: model.slice("bb-cpa/".length) },
  ]);
}

export function buildClaudeGatewayEnvironment(args: {
  connection: ModelConnectionSnapshot;
  env: NodeJS.ProcessEnv;
  threadId?: string;
  model?: string;
  nativeMcp?: boolean;
}): NodeJS.ProcessEnv {
  const gateway = requireClaudeGateway(args.connection);
  if (
    !args.nativeMcp &&
    /^(true|1|yes|on)$/i.test(args.env.ENABLE_CLAUDEAI_MCP_SERVERS ?? "")
  ) {
    throw new Error(CLAUDE_GATEWAY_CLOUD_LIMITATION);
  }
  const env = gatewayChildEnv(gateway, process.env, args.env);
  for (const name of Object.keys(env)) {
    if (
      name.startsWith("ANTHROPIC_") ||
      name.startsWith("CLAUDE_CODE_USE_") ||
      name.startsWith("CLAUDE_CODE_SKIP_") ||
      name.startsWith("ANTHROPIC_DEFAULT_") ||
      name === "CLAUDE_CODE_OAUTH_TOKEN" ||
      name === "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR" ||
      name === "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR" ||
      name === "CLAUDE_CODE_API_KEY_HELPER_FD" ||
      name === "CCR_OAUTH_TOKEN_FILE" ||
      name === "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL"
    )
      delete env[name];
  }
  env.ANTHROPIC_BASE_URL = gateway.baseUrl
    .replace(/\/+$/, "")
    .replace(/\/v1$/, "");
  const clientKey = resolveGatewayCredential(gateway, process.env);
  if (args.nativeMcp) {
    env.ANTHROPIC_CUSTOM_HEADERS = `Authorization: Bearer ${clientKey}`;
  } else {
    env.ANTHROPIC_API_KEY = clientKey;
  }
  env.ENABLE_CLAUDEAI_MCP_SERVERS = args.nativeMcp ? "true" : "false";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  if (args.threadId) {
    if (/[\r\n]/.test(args.threadId)) {
      throw new Error(
        "Claude gateway thread identity cannot contain header delimiters.",
      );
    }
    env.ANTHROPIC_CUSTOM_HEADERS = [
      env.ANTHROPIC_CUSTOM_HEADERS,
      `X-BB-Thread-Id: ${args.threadId}`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  const model = claudeGatewayModel(args.model, args.connection);
  env.ANTHROPIC_MODEL = model;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
  env.ANTHROPIC_SMALL_FAST_MODEL = model;
  env.CLAUDE_CODE_SUBAGENT_MODEL = model;
  return env;
}

export async function prepareGatewayBinding(
  gatewayDataDir: string | null,
  params: {
    threadId: string;
    model?: string;
    modelConnection?: ModelConnectionSnapshot;
    sourceProviderThreadId?: string;
  },
  providerThreadId: string,
  resume: boolean,
): Promise<(() => void) | undefined> {
  const connection = params.modelConnection;
  if (!connection?.gateway) {
    if (
      gatewayDataDir &&
      (hasGatewayReceipt(gatewayDataDir, params.threadId, "claude-gateway") ||
        (resume &&
          hasGatewayReceipt(
            gatewayDataDir,
            providerThreadId,
            "claude-gateway-sessions",
          )) ||
        (params.sourceProviderThreadId !== undefined &&
          hasGatewayReceipt(
            gatewayDataDir,
            params.sourceProviderThreadId,
            "claude-gateway-sessions",
          )))
    ) {
      throw new Error(
        "This Claude native session is bound to its original gateway. Restore that connection and model; gateway removal or a native account fallback requires a new unrelated thread.",
      );
    }
    return undefined;
  }
  const gateway = requireClaudeGateway(connection);
  const model = params.model;
  claudeGatewayModel(model, connection);
  const catalog = await listClaudeGatewayModels(connection);
  requireGatewayModel(
    model!,
    gateway,
    catalog.models.map(({ id }) => ({
      id: id.slice("bb-cpa/".length),
    })),
  );
  if (!gatewayDataDir) {
    throw new Error(
      "Claude gateway routing requires the provider host data directory.",
    );
  }
  if (params.sourceProviderThreadId !== undefined) {
    pinGatewayReceipt(
      gatewayDataDir,
      params.sourceProviderThreadId,
      gateway,
      model!,
      true,
      "claude-gateway-sessions",
    ).verify();
  }
  const threadReceipt = pinGatewayReceipt(
    gatewayDataDir,
    params.threadId,
    gateway,
    model!,
    resume,
    "claude-gateway",
  );
  const sessionReceipt = pinGatewayReceipt(
    gatewayDataDir,
    providerThreadId,
    gateway,
    model!,
    resume,
    "claude-gateway-sessions",
  );
  return () => {
    threadReceipt.verify();
    sessionReceipt.verify();
  };
}
