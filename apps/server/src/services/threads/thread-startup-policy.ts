import { getLatestStoredThreadEventOfTypes, type DbQueryConnection } from "@bb/db";
import { providerStartupDiagnosticSchema, systemOperationEventDataSchema } from "@bb/domain";
import { ApiError } from "../../errors.js";

export function assertThreadStartupAvailable(db: DbQueryConnection, threadId: string): void {
  const latest = getLatestStoredThreadEventOfTypes(db, {
    threadId, types: ["system/operation"], afterSequence: 0, operation: "provider_startup",
  });
  if (!latest) return;
  let value: unknown;
  try {
    value = JSON.parse(latest.data);
  } catch {
    throw new ApiError(409, "provider_startup_diagnostic_invalid", "Provider startup ownership could not be verified. Operator verification is required before retry.");
  }
  const parsed = systemOperationEventDataSchema.safeParse(value);
  const diagnostic = providerStartupDiagnosticSchema.safeParse(parsed.success ? parsed.data.metadata : null);
  if (!diagnostic.success || diagnostic.data.retryBlocked) {
    throw new ApiError(409, "provider_startup_stop_unverified", "The previous startup could not confirm that its owned processes stopped. Retry and continuation remain blocked; operator verification is required.");
  }
}
