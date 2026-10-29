import { appendFile, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function sourceLog(threadId: string, body: string): Buffer {
  return Buffer.from(`=== REQUEST INFO ===\nVersion: synthetic\nURL: /v1/responses\nMethod: POST\n\n=== HEADERS ===\nx-bb-thread-id: ${threadId}\n\n=== REQUEST BODY ===\n${body}\n\n=== API REQUEST ===\nsynthetic request\n\n=== API RESPONSE ===\nsynthetic response\n\n=== RESPONSE ===\nStatus: 200\nsynthetic response\n`);
}

describe.skipIf(process.platform !== "linux")("CPA capture bounded source reads", () => {
  let root: string;
  const threadId = "synthetic-capture-thread";
  beforeEach(async () => {
    vi.resetModules();
    root = await mkdtemp(join(tmpdir(), "bb-cpa-bounded-capture-"));
  });
  afterEach(async () => {
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
    await rm(root, { recursive: true, force: true });
  });

  async function settled(filename: string, bytes: Buffer) {
    const path = join(root, filename);
    await writeFile(path, bytes, { mode: 0o600 });
    const past = new Date(Date.now() - 10000);
    await utimes(path, past, past);
    return path;
  }

  it("retains every byte of an admitted stable source rather than returning a bounded preview", async () => {
    const bytes = sourceLog(threadId, "SYNTHETIC_START\n" + "x".repeat(70000) + "\nSYNTHETIC_END");
    await settled("stable.log", bytes);
    const { captureGatewayLogSource } = await import("../../src/services/gateway-logs.js");
    const value = await captureGatewayLogSource(root, threadId, Buffer.from("stable.log").toString("base64url"), new Set(), bytes.length);
    expect(value?.bytes).toEqual(bytes);
  });

  it("refuses an oversized whole source instead of accepting a truncated artifact", async () => {
    const bytes = sourceLog(threadId, "SYNTHETIC_LARGE_BODY".repeat(1024));
    await settled("oversized.log", bytes);
    const { captureGatewayLogSource } = await import("../../src/services/gateway-logs.js");
    await expect(captureGatewayLogSource(root, threadId, Buffer.from("oversized.log").toString("base64url"), new Set(), 4096))
      .rejects.toMatchObject({ status: 413, body: { code: "capture_source_limit" } });
  });

  it("does not consume beyond the admitted body budget when the actual file grows after inspection", async () => {
    const filename = "growing.log";
    const bytes = sourceLog(threadId, "SYNTHETIC_INITIAL_BODY");
    const path = await settled(filename, bytes);
    const appended = Buffer.from("SYNTHETIC_APPENDED_BODY".repeat(1024));
    const maximum = 4096;
    let headerRead = false;
    let appendedAfterInspection = false;
    let consumedBodyBytes = 0;

    vi.doMock("node:fs/promises", async importOriginal => {
      const real = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...real,
        open: async (...args: Parameters<typeof real.open>) => {
          const handle = await real.open(...args);
          if (typeof args[0] !== "string" || !args[0].endsWith(`/${filename}`)) return handle;
          return new Proxy(handle, {
            get(target, property) {
              if (property === "stat") return async () => {
                const snapshot = await target.stat();
                if (headerRead && !appendedAfterInspection) {
                  await appendFile(path, appended);
                  appendedAfterInspection = true;
                }
                return snapshot;
              };
              if (property === "read") return async (buffer: Buffer, offset: number, length: number, position: number) => {
                const value = await target.read(buffer, offset, length, position);
                if (headerRead) consumedBodyBytes += value.bytesRead;
                else headerRead = true;
                return value;
              };
              if (property === "readFile") return async (...options: Parameters<typeof target.readFile>) => {
                const value = await target.readFile(...options);
                consumedBodyBytes += typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
                return value;
              };
              const value: unknown = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
      };
    });

    const { captureGatewayLogSource } = await import("../../src/services/gateway-logs.js");
    let result: Awaited<ReturnType<typeof captureGatewayLogSource>> | undefined;
    let failure: unknown;
    try { result = await captureGatewayLogSource(root, threadId, Buffer.from(filename).toString("base64url"), new Set(), maximum); }
    catch (error) { failure = error; }
    if (failure !== undefined) {
      expect(failure).toMatchObject({ body: { code: expect.stringMatching(/^(gateway_logs_not_ready|capture_source_limit)$/u) } });
    } else {
      expect(result).not.toBeNull();
      expect(result?.bytes.byteLength).toBeLessThanOrEqual(maximum);
      expect(result?.bytes).toEqual(bytes);
    }
    expect((await stat(path)).size).toBe(bytes.length + appended.length);
    expect(consumedBodyBytes).toBeLessThanOrEqual(maximum);
  });
});
