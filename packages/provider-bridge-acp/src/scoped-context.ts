import {
  executionContextSnapshotSchema,
  modelConnectionSnapshotSchema,
  type ModelConnectionSnapshot,
} from "@bb/domain";
import { isDeepStrictEqual } from "node:util";

export interface AcpScopedOptions {
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
    throw new Error(
      args.dialectId === "omp"
        ? "Native OMP ACP cannot isolate this execution context: its CLI loads ambient global/project settings and instructions before ACP session creation. --config is an overlay, not an isolation boundary; --profile also changes context and session storage. A native OMP explicit-context discovery capability is required. No scoped launch or prompt was permitted."
        : "This native ACP provider does not support isolated execution contexts. Select a provider with native context isolation support.",
    );
  }
  if (connection === null || !connection.success) {
    return { modelConnection: null, env: {} };
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
  if (
    snapshot.nativeAuth.configDir !== null ||
    snapshot.nativeAuth.profile !== null
  ) {
    throw new Error(
      "OMP configDir/profile cannot select only authentication: they also change instructions, settings, skills and native session storage. Use the host's existing native OMP source or declared broker host environment references instead.",
    );
  }
  const refs = snapshot.nativeAuth.hostEnv;
  if (refs === null) {
    return { modelConnection: snapshot, env: {} };
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
    modelConnection: snapshot,
    env: { OMP_AUTH_BROKER_URL: url, OMP_AUTH_BROKER_TOKEN: token },
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
