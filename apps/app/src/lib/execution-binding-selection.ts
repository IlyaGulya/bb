import { isModelGatewayProviderCompatible } from "@bb/domain";
import type { ExecutionContext, ModelConnection } from "@bb/domain";

export function executionContextUnavailableReason(
  context: ExecutionContext | undefined,
  projectId: string,
): string | null {
  if (!context) return "Execution context is unavailable.";
  if (!context.enabled) return "Execution context is disabled.";
  if (!context.projectIds.includes(projectId)) {
    return "Execution context does not include this project.";
  }
  return null;
}

export function modelConnectionUnavailableReason(
  connection: ModelConnection | undefined,
  providerId: string,
  hostId: string | null,
): string | null {
  if (!connection) return "Model connection is unavailable.";
  if (connection.revoked) return "Model connection is revoked.";
  if (!connection.enabled) return "Model connection is disabled.";
  if (connection.provider !== providerId) {
    return `Requires provider ${connection.provider}.`;
  }
  if (hostId === null) return "Select a machine to use this model connection.";
  if (connection.gateway) {
    if (
      !isModelGatewayProviderCompatible(providerId, connection.gateway.protocol)
    )
      return "CPA protocol is incompatible with the selected native engine.";
    if (!connection.gateway.allowedHostIds.includes(hostId)) {
      return "This machine is not allowed to use the CPA gateway connection.";
    }
  } else if (connection.hostId !== hostId) {
    return "Model connection belongs to a different machine.";
  }
  return null;
}
