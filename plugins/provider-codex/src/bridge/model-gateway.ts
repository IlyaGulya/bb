import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AvailableModel, ModelConnectionSnapshot } from "@get-bb/plugin-sdk/provider-bridge";
import {
  gatewayChildEnv,
  hasGatewayReceipt,
  listGatewayModelIds,
  pinGatewayReceipt,
  requireGatewayModel,
  resolveGatewayCredential,
  type ModelGateway,
} from "@bb/provider-bridge-protocol/model-gateway";
import type { JsonValue } from "../generated/codex-app-server/schema/serde_json/JsonValue.js";

const CREDENTIAL_ENV = "BB_CODEX_CPA_CLIENT_KEY";

function gatewayFor(connection?: ModelConnectionSnapshot | null): ModelGateway | null {
  const gateway = connection?.gateway;
  if (!gateway) return null;
  if (connection.provider !== "codex" || gateway.protocol !== "openai-responses")
    throw new Error("Native Codex CPA requires an openai-responses Codex connection.");
  return gateway;
}

function credential(gateway: ModelGateway): string {
  try {
    return resolveGatewayCredential(gateway, gatewayChildEnv(gateway, process.env, {}));
  } catch {
    throw new Error("CPA worker credential is unavailable; native login fallback is disabled.");
  }
}

export async function listCodexGatewayModels(connection?: ModelConnectionSnapshot | null): Promise<AvailableModel[] | null> {
  const gateway = gatewayFor(connection);
  if (!gateway) return null;
  const ids = await listGatewayModelIds(gateway, credential(gateway));
  return ids.map((id) => ({
    id: `bb-cpa/${id}`,
    model: `bb-cpa/${id}`,
    displayName: id,
    description: `CPA ${gateway.accountPrefix}; native Codex Responses`,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: "medium",
    supportedServiceTiers: [],
    isDefault: false,
  }));
}

export interface CodexGatewaySession {
  connection: ModelConnectionSnapshot;
  selection: string;
  model: string;
  providerId: string;
  env: NodeJS.ProcessEnv;
  config: Record<string, JsonValue>;
  redact(text: string): string;
  verify(connection: ModelConnectionSnapshot | null | undefined, model: string | undefined): void;
  pinNativeSession(providerThreadId: string): void;
  verifyCredential(): void;
}

export async function prepareCodexGateway(args: {
  connection?: ModelConnectionSnapshot | null;
  model?: string;
  threadId: string;
  dataDir: string | null;
  sourceProviderThreadId?: string;
}): Promise<CodexGatewaySession | null> {
  const gateway = gatewayFor(args.connection);
  if (!gateway) {
    if (args.dataDir && (
      hasGatewayReceipt(args.dataDir, args.threadId, "codex-gateway") ||
      (args.sourceProviderThreadId !== undefined &&
        hasGatewayReceipt(args.dataDir, args.sourceProviderThreadId, "codex-gateway-sessions"))
    ))
      throw new Error("This thread is pinned to CPA; create a new thread to change its connection.");
    return null;
  }
  if (!args.dataDir)
    throw new Error("CPA requires the provider worker data directory to pin its model binding.");
  if (!args.model?.startsWith(`bb-cpa/${gateway.accountPrefix}/`))
    throw new Error("Select an exact supported model from this CPA connection; native/default fallback is disabled.");
  const selection = args.model;
  if (args.sourceProviderThreadId !== undefined) {
    pinGatewayReceipt(args.dataDir, args.sourceProviderThreadId, gateway, selection, true, "codex-gateway-sessions");
  }
  const key = credential(gateway);
  const models = await listGatewayModelIds(gateway, key);
  const model = requireGatewayModel(args.model, gateway, models.map((id) => ({ id })));
  const connection = structuredClone(args.connection!);
  const receipt = pinGatewayReceipt(args.dataDir, args.threadId, gateway, selection, false, "codex-gateway");
  let nativeSessionReceipt: { verify(): void } | null = null;
  const providerId = `bb-cpa-${createHash("sha256").update(JSON.stringify({ gateway, threadId: args.threadId })).digest("hex")}`;
  const config: Record<string, JsonValue> = {
    model_provider: providerId,
    model,
    review_model: model,
    disable_response_storage: true,
    "shell_environment_policy.exclude": [
      CREDENTIAL_ENV,
      ...(gateway.credential.kind === "env" ? [gateway.credential.name] : []),
    ],
    model_providers: {
      [providerId]: {
        name: "BB CPA",
        base_url: gateway.baseUrl,
        wire_api: "responses",
        env_key: CREDENTIAL_ENV,
        requires_openai_auth: false,
        supports_websockets: false,
        http_headers: { "X-BB-Thread-Id": args.threadId },
      },
    },
  };
  return {
    connection,
    selection,
    model,
    providerId,
    config,
    env: {
      ...(gateway.credential.kind === "env" ? { [gateway.credential.name]: undefined } : {}),
      [CREDENTIAL_ENV]: key,
    },
    redact: (text) => text.replaceAll(key, "[redacted CPA credential]"),
    verify(nextConnection, nextModel) {
      receipt.verify();
      if (!isDeepStrictEqual(connection, nextConnection) || nextModel !== selection)
        throw new Error("CPA connection and model are pinned; create a new thread to change its binding.");
      nativeSessionReceipt?.verify();
    },
    pinNativeSession(providerThreadId) {
      nativeSessionReceipt = pinGatewayReceipt(args.dataDir!, providerThreadId, gateway, selection, false, "codex-gateway-sessions");
    },
    verifyCredential() {
      receipt.verify();
      nativeSessionReceipt?.verify();
      if (credential(gateway) !== key)
        throw new Error("CPA worker credential changed; reopen this thread to use the provisioned credential.");
    },
  };
}
