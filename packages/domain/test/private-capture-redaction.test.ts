import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  captureHasUnredactedAuth,
  redactCapturePayload,
} from "../src/private-capture-redaction.js";

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);

const credentials = [
  { encoded: String.raw`\u0078-api-key`, decoded: "x-api-key" },
  { encoded: String.raw`authoriz\u0061tion`, decoded: "authorization" },
  { encoded: String.raw`refresh_\u0074oken`, decoded: "refresh_token" },
];

describe("private capture decoded JSON credentials", () => {
  it.each(credentials)("redacts a complete multiline document with $decoded", ({ encoded, decoded }) => {
    const source = encode(`{\n  "safe": {"message": "keep this value"},\n  "${encoded}": "SYNTHETIC_SECRET"\n}\n`);
    const result = redactCapturePayload(source);
    const value: unknown = JSON.parse(decode(result.bytes));
    expect(value).toEqual({ safe: { message: "keep this value" }, [decoded]: "[REDACTED]" });
    expect(result.redacted).toBe(true);
    expect(decode(result.bytes)).not.toContain("SYNTHETIC_SECRET");
  });

  it.each(credentials)("audits the decoded $decoded key before artifact completion", ({ encoded }) => {
    const source = encode(`{\n  "${encoded}": "SYNTHETIC_SECRET",\n  "safe": "keep this value"\n}\n`);
    expect(captureHasUnredactedAuth(source, true)).toBe(true);
    const safe = encode(`{\n  "${encoded}": "[REDACTED]",\n  "safe": "keep this value"\n}\n`);
    expect(captureHasUnredactedAuth(safe, true)).toBe(false);
  });

  it("preserves nested array content while removing decoded credentials and encoded JSON credentials", () => {
    const nested = String.raw`{"\u0063ookie":"SYNTHETIC_COOKIE","result":{"ok":true}}`;
    const source = encode(`{\n  "items": [\n    {"\\u0078-api-key": "SYNTHETIC_KEY", "value": 7},\n    {"line": ${JSON.stringify(nested)}}\n  ]\n}`);
    const result = redactCapturePayload(source);
    const value = z.object({ items: z.tuple([
      z.object({ "x-api-key": z.string(), value: z.number() }),
      z.object({ line: z.string() }),
    ]) }).parse(JSON.parse(decode(result.bytes)));
    expect(value.items[0]).toEqual({ "x-api-key": "[REDACTED]", value: 7 });
    expect(JSON.parse(value.items[1].line)).toEqual({ cookie: "[REDACTED]", result: { ok: true } });
    expect(captureHasUnredactedAuth(source, true)).toBe(true);
    expect(captureHasUnredactedAuth(result.bytes, true)).toBe(false);
  });

  it("keeps separate JSON records and SSE event payloads separate", () => {
    const source = encode(String.raw`{"\u0078-api-key":"SYNTHETIC_A","sequence":1}` + "\n" +
      "data: " + String.raw`{"authoriz\u0061tion":"SYNTHETIC_B","sequence":2}` + "\n\n" + "data: [DONE]\n");
    const text = decode(redactCapturePayload(source).bytes);
    const lines = text.split("\n");
    expect(JSON.parse(lines[0]!)).toEqual({ "x-api-key": "[REDACTED]", sequence: 1 });
    expect(JSON.parse(lines[1]!.slice(6))).toEqual({ authorization: "[REDACTED]", sequence: 2 });
    expect(lines.slice(2)).toEqual(["", "data: [DONE]", ""]);
    expect(text).not.toContain("SYNTHETIC_");
  });
});
