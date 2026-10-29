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
