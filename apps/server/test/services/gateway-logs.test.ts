import { mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  downloadGatewayLog,
  listGatewayLogs,
  readGatewayLog,
} from "../../src/services/gateway-logs.js";

function nativeLog(threadId: string, body = "request body"): string {
  return `=== REQUEST INFO ===\nVersion: 8.0.44\nURL: /v1/responses\nMethod: POST\nTimestamp: 2026-10-27T12:00:00Z\n\n\n=== HEADERS ===\nContent-Type: application/json\nx-Bb-ThReAd-Id: ${threadId}\n\n\n=== REQUEST BODY ===\n${body}\n\n\n=== API REQUEST ===\nupstream request\n\n\n=== API RESPONSE ===\nupstream response\n\n\n=== RESPONSE ===\nStatus: 200\nresponse\n`;
}

function logId(filename: string): string {
  return Buffer.from(filename).toString("base64url");
}

describe.skipIf(process.platform !== "linux")("native CPA gateway logs", () => {
  let root: string;
  let foreignRoot: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bb-cpa-logs-"));
    foreignRoot = await mkdtemp(join(tmpdir(), "bb-cpa-foreign-"));
  });
  afterEach(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(foreignRoot, { recursive: true, force: true }),
    ]);
  });

  async function finalized(filename: string, raw: string): Promise<void> {
    const path = join(root, filename);
    await writeFile(path, raw);
    const past = new Date(Date.now() - 10000);
    await utimes(path, past, past);
  }

  it("matches the exact case-insensitive inbound header name, never another thread or body text", async () => {
    await finalized("ours.log", nativeLog("thread-a"));
    await finalized(
      "foreign.log",
      nativeLog(
        "thread-b",
        "X-BB-Thread-Id: thread-a\n=== HEADERS ===\nX-BB-Thread-Id: thread-a\n\n",
      ),
    );
    await finalized("prefix.log", nativeLog("thread-a-extra"));
    await finalized(
      "duplicate.log",
      nativeLog("thread-a\nX-BB-Thread-Id: thread-b"),
    );
    await finalized(
      "body-only.log",
      nativeLog("thread-b")
        .replace("x-Bb-ThReAd-Id: thread-b", "Other-Header: thread-a")
        .replace(
          "request body",
          "=== HEADERS ===\nX-BB-Thread-Id: thread-a\n\n",
        ),
    );
    const result = await listGatewayLogs(root, "thread-a");
    expect(result.entries.map((entry) => entry.id)).toEqual([
      logId("ours.log"),
    ]);
    await expect(
      readGatewayLog(root, "thread-a", logId("foreign.log"), 32),
    ).rejects.toMatchObject({ body: { code: "gateway_log_not_found" } });
  });

  it("rejects traversal, symlink files and symlink roots", async () => {
    await writeFile(join(foreignRoot, "outside.log"), nativeLog("thread-a"));
    await symlink(join(foreignRoot, "outside.log"), join(root, "linked.log"));
    await finalized("ours.log", nativeLog("thread-a"));
    expect(
      (await listGatewayLogs(root, "thread-a")).entries.map(
        (entry) => entry.id,
      ),
    ).toEqual([logId("ours.log")]);
    for (const id of [
      "../outside.log",
      logId("../outside.log"),
      logId("linked.log"),
      logId("/etc/passwd"),
      `${logId("ours.log")}=`,
    ]) {
      await expect(
        readGatewayLog(root, "thread-a", id, 32),
      ).rejects.toMatchObject({ body: { code: "gateway_log_not_found" } });
    }
    await symlink(foreignRoot, join(root, "linked-root"));
    await expect(
      listGatewayLogs(join(root, "linked-root"), "thread-a"),
    ).rejects.toMatchObject({ body: { code: "gateway_logs_unavailable" } });
  });

  it("reports off, missing and no finalized logs explicitly", async () => {
    for (const path of [undefined, join(root, "missing")]) {
      await expect(listGatewayLogs(path, "thread-a")).rejects.toMatchObject({
        body: { code: "gateway_logs_unavailable" },
      });
    }
    await writeFile(
      join(root, "response-body-1.tmp"),
      "streaming private data",
    );
    await expect(listGatewayLogs(root, "thread-a")).rejects.toMatchObject({
      body: { code: "gateway_logs_not_ready" },
    });
    await writeFile(join(root, "settling.log"), nativeLog("thread-a"));
    await expect(
      readGatewayLog(root, "thread-a", logId("settling.log"), 32),
    ).rejects.toMatchObject({ body: { code: "gateway_logs_not_ready" } });
  });

  it("returns an explicitly bounded preview and the entire protected raw download", async () => {
    const raw = nativeLog("thread-a", "x".repeat(300000));
    await finalized("large.log", raw);
    const preview = await readGatewayLog(
      root,
      "thread-a",
      logId("large.log"),
      128,
    );
    expect(preview).toMatchObject({
      raw: raw.slice(0, 128),
      truncated: true,
      previewBytes: 128,
      sizeBytes: Buffer.byteLength(raw),
    });
    const response = await downloadGatewayLog(
      root,
      "thread-a",
      logId("large.log"),
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(await response.text()).toBe(raw);
    await expect(
      readGatewayLog(root, "thread-a", logId("large.log"), 262145),
    ).rejects.toMatchObject({ body: { code: "invalid_request" } });
  });

  it("does not seek a spoofed header beyond the bounded inbound header block", async () => {
    await finalized(
      "oversized.log",
      nativeLog("thread-a").replace(
        "Content-Type: application/json",
        `Long-Header: ${"x".repeat(65536)}`,
      ),
    );
    await expect(
      readGatewayLog(root, "thread-a", logId("oversized.log"), 32),
    ).rejects.toMatchObject({ body: { code: "gateway_log_not_found" } });
  });
});
