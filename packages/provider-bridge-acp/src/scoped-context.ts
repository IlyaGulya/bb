import {
  executionContextSnapshotSchema,
  modelConnectionSnapshotSchema,
  type ExecutionContextSnapshot,
  type ModelConnectionSnapshot,
} from "@bb/domain";
import { isDeepStrictEqual } from "node:util";

export interface AcpScopedOptions {
  executionContext: ExecutionContextSnapshot | null;
  modelConnection: ModelConnectionSnapshot | null;
  env: Record<string, string>;
}

export function resolveAcpScopedOptions(args: {
  providerOptions: Record<string, unknown> | undefined;
  dialectId: string;
  env: Readonly<Record<string, string | undefined>>;
}): AcpScopedOptions {
  const contextValue = args.providerOptions?.executionContext;
  const connectionValue = args.providerOptions?.modelConnection;
  const context =
    contextValue === undefined
      ? null
      : executionContextSnapshotSchema.safeParse(contextValue);
  if (context !== null && !context.success) {
    throw new Error(
      "Invalid executionContext snapshot supplied to the native ACP provider.",
    );
  }
  const connection =
    connectionValue === undefined
      ? null
      : modelConnectionSnapshotSchema.safeParse(connectionValue);
  if (connection !== null && !connection.success) {
    throw new Error(
      "Invalid modelConnection snapshot supplied to the native ACP provider.",
    );
  }
  if (context !== null && context.success) {
    if (!context.data.enabled) {
      throw new Error(
        "The selected execution context is disabled. Select an enabled execution context.",
      );
    }
    if (args.dialectId !== "omp") {
      throw new Error(
        "This native ACP provider does not support isolated execution contexts. Select a provider with native context isolation support.",
      );
    }
  }
  const executionContext = context?.success ? context.data : null;
  const env: Record<string, string> = {};
  if (executionContext?.gitIdentity) {
    env.GIT_AUTHOR_NAME = executionContext.gitIdentity.name;
    env.GIT_COMMITTER_NAME = executionContext.gitIdentity.name;
    env.GIT_AUTHOR_EMAIL = executionContext.gitIdentity.email;
    env.GIT_COMMITTER_EMAIL = executionContext.gitIdentity.email;
  }
  if (connection === null || !connection.success) {
    return { executionContext, modelConnection: null, env };
  }
  const snapshot = connection.data;
  if (!snapshot.enabled || snapshot.revoked) {
    throw new Error(
      "The selected model connection is disabled or revoked. Select an available model connection.",
    );
  }
  if (args.dialectId !== "omp" || snapshot.provider !== "acp-omp") {
    throw new Error(
      "This model connection requires the shipped acp-omp native provider. Other ACP agents do not support its native account references.",
    );
  }
  if (snapshot.gateway) {
    return { executionContext, modelConnection: snapshot, env };
  }
  if (
    snapshot.nativeAuth.profile !== null ||
    (snapshot.nativeAuth.configDir !== null && executionContext === null)
  ) {
    throw new Error(
      "OMP profile selection is not auth-only. An explicit native auth configDir requires a scoped execution context; otherwise context and session storage would change too.",
    );
  }
  const refs = snapshot.nativeAuth.hostEnv;
  if (refs === null) {
    return { executionContext, modelConnection: snapshot, env };
  }
  const url = args.env[refs.brokerUrlEnv];
  const token = args.env[refs.brokerTokenEnv];
  if (!url?.trim() || !token?.trim()) {
    throw new Error(
      "The OMP model connection's declared broker host environment references are unavailable. Configure both referenced variables on the permitted host; native login fallback is disabled for this connection.",
    );
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(
      "The OMP model connection's broker URL reference must contain an HTTP or HTTPS URL.",
    );
  }
  if (
    !["https:", "http:"].includes(parsedUrl.protocol) ||
    parsedUrl.username ||
    parsedUrl.password
  ) {
    throw new Error(
      "The OMP model connection's broker URL reference must contain an HTTP or HTTPS URL without embedded credentials.",
    );
  }
  return {
    executionContext,
    modelConnection: snapshot,
    env: { ...env, OMP_AUTH_BROKER_URL: url, OMP_AUTH_BROKER_TOKEN: token },
  };
}

export function assertAcpConnectionUnchanged(
  previous: ModelConnectionSnapshot | null,
  next: ModelConnectionSnapshot | null,
): void {
  if (!isDeepStrictEqual(previous, next)) {
    throw new Error(
      "An active native ACP session cannot change its model connection. Create a new thread with the selected connection.",
    );
  }
}
