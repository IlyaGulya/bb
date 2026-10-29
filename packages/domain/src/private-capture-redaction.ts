const credentialKey = /^(authorization|proxy-authorization|cookie|set-cookie|(?:[a-z0-9]+[-_])*(?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|security[-_]?token|oauth[-_]?token|auth[-_]?token|session[-_]?token|password|secret)|(?:[a-z0-9]+[-_])+token)$/iu;
const jsonField = /("(?:[^"\\]|\\.)*")(\s*:\s*)("(?:[^"\\]|\\.)*")/gu;
export class CapturePayloadError extends Error {
  constructor(readonly code: "source_limit" | "privacy_rejected" | "invalid_utf8") { super(`capture_${code}`); }
}
function redactLooseSecrets(text: string): string {
  return text.replace(/\b(Bearer|Basic)[ \t]+[A-Za-z0-9._~+/=-]+/giu, "$1 [REDACTED]")
    .replace(/([?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|oauth[-_]?token|auth[-_]?token|session[-_]?token|token)=)[^&#\s"\\]+/giu, "$1[REDACTED]")
    .replace(/(^|[\r\n;&?\s])((?:(?:[a-z0-9]+[-_])*(?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|security[-_]?token|oauth[-_]?token|auth[-_]?token|session[-_]?token|password|secret)|(?:[a-z0-9]+[-_])+token)=)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^&;\s]*)/gimu, "$1$2[REDACTED]")
    .replace(/(https?:\/\/)[^/\s@]+@/giu, "$1[REDACTED]@");
}
function redactJson(value: unknown, state: { changed: boolean }, depth = 0): unknown {
  if (depth > 64) throw new CapturePayloadError("source_limit");
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) value[index] = redactJson(value[index], state, depth + 1);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      if (credentialKey.test(key) && entry !== "[REDACTED]" && entry !== "") {
        Reflect.set(value, key, "[REDACTED]");
        state.changed = true;
      } else Reflect.set(value, key, redactJson(entry, state, depth + 1));
    }
  } else if (typeof value === "string") {
    const nested = /^[\s]*[\[{]/u.test(value) ? redactJsonDocument(value, depth + 1) : null;
    const text = redactLooseSecrets(nested?.text ?? value);
    if (text !== value) { state.changed = true; return text; }
  }
  return value;
}
function redactJsonDocument(source: string, depth = 0): { text: string; changed: boolean } | null {
  let value: unknown;
  try { value = JSON.parse(source); } catch { return null; }
  const state = { changed: false };
  const result = redactJson(value, state, depth);
  return { text: state.changed ? JSON.stringify(result) : source, changed: state.changed };
}
function isCredentialJsonKey(key: string): boolean {
  try { const value: unknown = JSON.parse(key); return typeof value === "string" && credentialKey.test(value); }
  catch { return false; }
}
export function redactCapturePayload(source: Uint8Array): { bytes: Uint8Array<ArrayBuffer>; redacted: boolean } {
  let raw: string;
  try { raw = new TextDecoder("utf-8", { fatal: true }).decode(source); }
  catch { throw new CapturePayloadError("invalid_utf8"); }
  if (captureContainsPrivateKey(source)) throw new CapturePayloadError("privacy_rejected");
  let folded = false;
  const document = redactJsonDocument(raw);
  const text = redactLooseSecrets((document?.text ?? raw.split("\n").map(line => {
    if (folded && /^[ \t]/u.test(line)) return " [REDACTED]";
    folded = false;
    const header = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.*)$/u.exec(line);
    if (header && credentialKey.test(header[1]!)) { folded = true; return `${header[1]}: [REDACTED]`; }
    const prefix = line.startsWith("data: ") ? "data: " : "";
    return prefix + (redactJsonDocument(line.slice(prefix.length))?.text ?? line.slice(prefix.length));
  }).join("\n")).replace(jsonField, (match: string, key: string, separator: string) => isCredentialJsonKey(key) ? `${key}${separator}"[REDACTED]"` : match));
  return { bytes: new TextEncoder().encode(text), redacted: text !== raw };
}

export function captureContainsPrivateKey(source: Uint8Array): boolean {
  const marker = [45, 45, 45, 45, 45, 66, 69, 71, 73, 78, 32];
  for (let offset = 0; offset + marker.length < source.length; offset += 1) {
    if (source[offset] !== 45 || !marker.every((byte, index) => source[offset + index] === byte)) continue;
    const candidate = new TextDecoder().decode(source.subarray(offset, offset + 96));
    if (/^-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY(?: BLOCK)?-----/u.test(candidate)) return true;
  }
  return false;
}

export function captureHasUnredactedAuth(source: Uint8Array, lastChunk: boolean): boolean {
  const text = new TextDecoder().decode(source);
  if (redactLooseSecrets(text) !== text) return true;
  if (redactJsonDocument(text)?.changed) return true;
  const lines = text.split("\n");
  if (!lastChunk) lines.pop();
  for (const line of lines) {
    const header = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.*)$/u.exec(line);
    if (header && credentialKey.test(header[1]!) && header[2]!.trim() !== "[REDACTED]" && header[2]!.trim() !== "") return true;
    const record = line.startsWith("data: ") ? line.slice(6) : line;
    if (redactJsonDocument(record)?.changed) return true;
  }
  for (const match of text.matchAll(jsonField)) {
    if (!isCredentialJsonKey(match[1]!)) continue;
    try { const value: unknown = JSON.parse(match[3]!); if (value !== "[REDACTED]" && value !== "") return true; } catch { return true; }
  }
  return false;
}

export function captureReportedModels(source: Uint8Array): { models: string[]; indexLimited: boolean } {
  const models = new Set<string>();
  let indexLimited = false;
  function visit(value: unknown, depth: number): void {
    if (depth > 4 || typeof value !== "object" || value === null || Array.isArray(value)) return;
    if ("model" in value && typeof value.model === "string" && value.model.length > 0) {
      if (value.model.length <= 256 && (models.size < 32 || models.has(value.model))) models.add(value.model);
      else indexLimited = true;
    }
    if ("execution" in value) visit(value.execution, depth + 1);
    if ("params" in value) visit(value.params, depth + 1);
    if ("result" in value) visit(value.result, depth + 1);
    if ("message" in value) visit(value.message, depth + 1);
    if ("line" in value && typeof value.line === "string") {
      try { visit(JSON.parse(value.line), depth + 1); } catch {}
    }
    if ("data" in value && typeof value.data === "string") {
      try { visit(JSON.parse(value.data), depth + 1); } catch {}
    }
  }
  const raw = new TextDecoder().decode(source);
  for (const section of raw.split(/^=== [^\r\n]+ ===\r?$/gmu)) {
    const start = section.indexOf("{");
    const end = section.lastIndexOf("}");
    if (start < 0 || end < start) continue;
    try { visit(JSON.parse(section.slice(start, end + 1)), 0); } catch {}
  }
  for (const line of raw.split("\n")) {
    const value = (line.startsWith("data: ") ? line.slice(6) : line).trimStart();
    if (!value.startsWith("{")) continue;
    try { visit(JSON.parse(value), 0); } catch {}
  }
  return { models: [...models], indexLimited };
}
