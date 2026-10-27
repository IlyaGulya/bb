import type {
  SystemExecutionOptionsQuery,
  SystemExecutionOptionsResponse,
} from "@bb/server-contract";
import type { BbSdkTransport } from "../transport.js";
import type { RequestTimeoutInit } from "../response.js";

export interface CreateSdkAreaArgs {
  transport: BbSdkTransport;
}

type SignalRequestOptions = { init: RequestTimeoutInit };

export function signalRequestArgs(
  signal: AbortSignal | undefined,
  timeoutMs?: number,
): [] | [SignalRequestOptions] {
  return signal === undefined && timeoutMs === undefined
    ? []
    : [
        {
          init: {
            ...(signal === undefined ? {} : { signal }),
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
          },
        },
      ];
}

export async function readExecutionOptions(
  transport: BbSdkTransport,
  input: SystemExecutionOptionsQuery & { signal?: AbortSignal },
): Promise<SystemExecutionOptionsResponse> {
  return transport.readJson(
    transport.api.v1.system["execution-options"].$get(
      {
        query: {
          environmentId: input.environmentId,
          hostId: input.hostId,
          projectId: input.projectId,
          providerId: input.providerId,
          modelConnectionId: input.modelConnectionId,
          threadId: input.threadId,
        },
      },
      ...signalRequestArgs(input.signal),
    ),
  );
}
