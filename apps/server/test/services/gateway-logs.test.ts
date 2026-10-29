import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gatewayLogDirectory } from "../../src/services/gateway-log-directory.js";
import {
  downloadGatewayLog,
  gatewayLogManifest,
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

  it("selects the frozen endpoint's log root even when another account has the same thread header and filename", async () => {
    const personal = nativeLog("thread-a", "personal-only");
    const work = nativeLog("thread-a", "work-only");
    await finalized("same.log", personal);
    const other = join(foreignRoot, "same.log");
    await writeFile(other, work);
    const past = new Date(Date.now() - 10000);
    await utimes(other, past, past);
    const mapping = JSON.stringify({
      "https://personal.example/v1/": root,
      "https://work.example/v1": foreignRoot,
    });
    const personalDownload = await downloadGatewayLog(
      gatewayLogDirectory("https://personal.example/v1", mapping),
      "thread-a",
      logId("same.log"),
    );
    const workDownload = await downloadGatewayLog(
      gatewayLogDirectory("https://work.example/v1/", mapping),
      "thread-a",
      logId("same.log"),
    );
    expect(await personalDownload.text()).toBe(personal);
    expect(await workDownload.text()).toBe(work);
    await expect(
      listGatewayLogs(
        gatewayLogDirectory("https://unbound.example/v1", mapping),
        "thread-a",
      ),
    ).rejects.toMatchObject({ body: { code: "gateway_logs_unavailable" } });
  });

  it("refuses invalid or ambiguous endpoint mappings rather than borrowing another account root", () => {
    for (const mapping of [
      "{",
      JSON.stringify({ "https://personal.example/v1": "relative" }),
      JSON.stringify({
        "https://personal.example/v1": root,
        "https://personal.example/v1/": foreignRoot,
      }),
    ]) {
      let error: unknown;
      try {
        gatewayLogDirectory("https://personal.example/v1", mapping);
      } catch (cause) {
        error = cause;
      }
      expect(error).toMatchObject({
        body: { code: "gateway_logs_unavailable" },
      });
    }
  });

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

  it("hashes every retained byte including binary tails and refuses foreign ownership", async () => {
    const prefix = Buffer.from(nativeLog("thread-a", "x".repeat(300000)));
    const first = Buffer.concat([prefix, Buffer.from([0, 255, 128, 1])]);
    const second = Buffer.concat([prefix, Buffer.from([0, 255, 128, 2])]);
    for (const [name, bytes] of [["first.log", first], ["second.log", second]] as const) {
      const path = join(root, name);
      await writeFile(path, bytes);
      const past = new Date(Date.now() - 10000);
      await utimes(path, past, past);
    }
    const firstManifest = await gatewayLogManifest(root, "thread-a", logId("first.log"));
    const secondManifest = await gatewayLogManifest(root, "thread-a", logId("second.log"));
    expect(firstManifest.sha256).toBe(createHash("sha256").update(first).digest("hex"));
    expect(secondManifest.sha256).toBe(createHash("sha256").update(second).digest("hex"));
    expect(firstManifest.sha256).not.toBe(secondManifest.sha256);
    expect(firstManifest).toMatchObject({ sizeBytes: first.length, completeness: "unverified", redaction: "unverified", deliveryAck: null });
    await expect(gatewayLogManifest(root, "thread-b", logId("first.log"))).rejects.toMatchObject({ body: { code: "gateway_log_not_found" } });
    await symlink(join(root, "first.log"), join(root, "alias.log"));
    await expect(gatewayLogManifest(root, "thread-a", logId("alias.log"))).rejects.toMatchObject({ body: { code: "gateway_log_not_found" } });
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
