import { z } from "zod";

export const CAPTURE_MITMPROXY_VERSION = "12.3.1";
export const captureProcessPolicySchema = z.object({
  python: z.string().min(1).max(4096).refine(value => value.startsWith("/") && !value.includes("\0")),
  mitmdump: z.string().min(1).max(4096).refine(value => value.startsWith("/") && !value.includes("\0")).optional(),
  network: z.enum(["explicit-proxy", "local-pid"]),
  trust: z.enum(["node-extra-ca", "ssl-cert-file", "external-process-trust"]),
  native: z.enum(["stdio", "claude-hooks", "terminal"]),
  binaryReview: z.literal("owner-reviewed-no-auth-material"),
}).strict();
export const captureProcessEvidenceSchema = z.object({
  processSessionId: z.string().uuid(),
  rootPid: z.number().int().positive(),
  producerPid: z.number().int().positive(),
  recordId: z.string().uuid(),
  role: z.enum(["metadata", "body"]),
  direction: z.enum(["request", "response", "stdin", "stdout", "tool", "websocket-client", "websocket-server", "lifecycle"]),
  sequence: z.number().int().nonnegative(),
}).strict();
export const captureProcessStatusSchema = z.object({
  phase: z.enum(["prepared", "running", "exited", "dependency_unavailable", "source_unavailable", "partial_source", "lease_expired", "quota", "disk_pressure", "privacy_rejected"]),
  requiredMitmproxy: z.literal(CAPTURE_MITMPROXY_VERSION),
  launchPrefix: z.array(z.string()).min(1).max(8),
  mcpPrefix: z.array(z.string()).min(1).max(8),
  hookCommand: z.array(z.string()).min(1).max(8),
  rootPid: z.number().int().positive().nullable(),
  processSessionId: z.string().uuid().nullable(),
  pendingSourceBytes: z.number().int().nonnegative(),
  openRecords: z.number().int().nonnegative(),
  exitCode: z.number().int().nullable(),
  droppedSourceBytes: z.number().int().nonnegative().nullable(),
  prerequisite: z.string().max(1024),
}).strict();
export type CaptureProcessPolicy = z.infer<typeof captureProcessPolicySchema>;
export type CaptureProcessEvidence = z.infer<typeof captureProcessEvidenceSchema>;
export type CaptureProcessStatus = z.infer<typeof captureProcessStatusSchema>;
