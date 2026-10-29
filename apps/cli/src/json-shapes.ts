export const JSON_SHAPE_BY_COMMAND_PATH: Readonly<Record<string, string>> = {
  "captures create": "{session: {id, subject, policy, enabled, createdAt, expiresAt}, lastSyncAt, lastAckAt, gap, gapCount, storedBytes, committedChunks, pendingBytes, pendingChunks, host, hostEnabled, links, coverage, outcome}",
  "captures list": "[CaptureView] (bare scoped page; same fields as captures show)",
  "captures show": "{session, lastSyncAt, lastAckAt, gap, gapCount, storedBytes, committedChunks, pendingBytes, pendingChunks, host: CaptureOutboxStatus | null, hostEnabled: boolean | null, links, coverage, outcome}",
  "captures stop": "CaptureView (accepted stop; disconnected host is bounded by its admission lease)",
  "captures sync": "CaptureView (one bounded data flush, not a lossless/full-coverage claim)",
  "captures link": "CaptureView with same-context owner-association links; original scope/provenance stays immutable; reuse opaque --operation UUID on retry",
  "captures artifacts": "[{manifest, completedAt, rejectedAt, committedSequences, outcome}] (bare scoped page, no raw bodies; source correlations can be null)",
  "captures inspect": "{manifest, completedAt, rejectedAt, committedSequences, outcome}; with --preview-bytes: {artifactId, raw, encoding, truncated, previewBytes, sizeBytes, storedSha256}",
  "captures import": "{manifest, completedAt, rejectedAt, committedSequences, outcome}; opaque --operation UUID is reused for retry",
  "captures download": "{captureId, artifactId, sizeBytes, integrity} (full verified payload goes only to --output)",
  status:
    "{project: {id, name} | null, thread: {id, status, title, parentThreadId, environment: {hostId, display} | null} | null, childThreads: [{id, status, title}] | null, pendingTodos, pluginsNeedingAttention: [{id, status}], dataDir}",
  "thread list":
    "[{id, projectId, environmentId, providerId, title, status, parentThreadId, sectionId, visibility, archivedAt, pinnedAt, createdAt, updatedAt, activity}]    (bare array; title can be null)",
  "thread show":
    "{thread: {id, status, title, projectId, environmentId, parentThreadId, ...}, environment: {id, hostId, path, branchName, ...} | null, pendingTodos}    (thread fields are under .thread)",
  "thread log":
    "[{id, seq, type, createdAt, threadId, scope, data}]    (bare array of raw events, oldest first; page with --after-seq <seq>); with --message: {message, before, after} of conversation rows",
  "thread output": "{output}",
  "thread spawn":
    "the created thread: {id, status, title, projectId, environmentId, ...}",
  "thread wait": "{threadId, matched: true, target}",
  "thread search": "{active: {total, results}, archived: {total, results}}",
  "prompt-history list":
    "{entries: [{id, createdAt, input, projectId, threadId, scope}], nextCursor: string | null}",
  "project list":
    "[{id, kind, name, gitRemoteUrl, sources: [{id, hostId, path, isDefault}]}]    (bare array)",
  "machine list":
    "[{id, name, type, status, lifecycle, maxPermissionMode, lastSeenAt}]    (bare array)",
  "provider list":
    "[{id, displayName, available, capabilities, reasoningLevels, serviceTiers, readiness: {verification, scope, status, freshness, checkedAt, retryAfterMs, detail}}]    (bare array)",
  "provider readiness":
    "{providers: [{providerId, displayName, status, statusMessage, readiness: {verification, scope, status, freshness, checkedAt, retryAfterMs, detail}, ...}]}",
  "provider models":
    "[{id, model, displayName, supportedReasoningEfforts, defaultReasoningEffort, supportedServiceTiers?, isDefault}]    (bare array)",
  "environment list":
    "[{id, name, projectId, hostId, path, branchName, status, lifecycle}]    (bare array)",
  "environment show":
    "{id, name, projectId, hostId, path, branchName, baseBranch, status, lifecycle}",
  "terminal list":
    "{sessions: [{id, title, status, exitCode, closeReason, cols, rows}]}    (wrapped in .sessions)",
  "terminal output":
    '{chunks: [{seq, dataBase64}], nextSeq, truncated, status, exitCode, closeReason}    (chunk data is base64; status is "exited" once the command has finished)',
  "terminal wait": "{terminalId, matched, nextSeq, exitCode}",
  "plugin list":
    "{plugins: [{id, version, enabled, status, source, rootDir}]}    (wrapped in .plugins)",
  "skill list":
    "{skills: [{id, name, description, scope, provider, filePath}]}    (wrapped in .skills)",
};

export function jsonShapeHelp(commandPath: string): string | null {
  const shape = JSON_SHAPE_BY_COMMAND_PATH[commandPath];
  return shape === undefined
    ? null
    : `\nJSON (--json): ${shape}\nErrors with --json: {"ok": false, "error": {code, message, hint?}} on stdout. Run \`bb guide json\` for every shape.`;
}
