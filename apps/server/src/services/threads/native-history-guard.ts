import { getThread, getThreadPluginMetadata, type DbQueryConnection } from "@bb/db";
import { nativeSessionSourceSchema } from "@bb/host-daemon-contract";
import { ApiError } from "../../errors.js";

import { NATIVE_HISTORY_OWNER } from "@bb/domain";
export function nativeHistoryMetadata(db: DbQueryConnection, threadId: string) {
  const thread = getThread(db, threadId);
  if (thread?.originPluginId !== NATIVE_HISTORY_OWNER) return null;
  const stored = getThreadPluginMetadata(db, threadId, NATIVE_HISTORY_OWNER);
  if (stored.corrupt) throw new ApiError(409, "provider_session_unavailable", "Native import provenance is corrupt; refusing continuation.");
  return stored.metadata;
}
export function assertNativeHistoryWritable(db: DbQueryConnection, threadId: string): void {
  const metadata = nativeHistoryMetadata(db, threadId);
  if (metadata !== null && metadata.mode !== "native-admitted") throw new ApiError(409, "provider_session_unavailable", "This thread is a native history archive, not an admitted runtime. Use its explicit native admission or create a separate thread with handoff; no fresh session was substituted.");
}
export function nativeHistoryResumeSource(db: DbQueryConnection, threadId: string) {
  const metadata = nativeHistoryMetadata(db, threadId);
  if (metadata === null) return undefined;
  assertNativeHistoryWritable(db, threadId);
  const parsed = nativeSessionSourceSchema.safeParse(metadata.source);
  if (!parsed.success) throw new ApiError(409, "provider_session_unavailable", "Native source namespace is unavailable; refusing an ambient resume.");
  return parsed.data;
}
