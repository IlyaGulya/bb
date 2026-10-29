import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import type { TestAppHarness } from "../../../apps/server/test/helpers/test-app.js";

const cliRoot = fileURLToPath(new URL("../../../apps/cli/", import.meta.url));
const cliEntry = join(cliRoot, "src", "index.ts");

export function analyticsCliEnvironment(baseUrl: string, dataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, BB_SERVER_URL: baseUrl, BB_DATA_DIR: dataDir, BB_CLI_REEXEC: "1", BB_CLI_ERROR_LOG: "0", FORCE_COLOR: "0" };
  for (const key of ["BB_CLI", "BB_CLI_DIR", "BB_PROJECT_ID", "BB_THREAD_ID", "BB_ENVIRONMENT_ID", "BB_THREAD_STORAGE", "BB_SERVER_HEADERS", "BB_PRODUCT_ANALYTICS_MODE", "BB_PRODUCT_ANALYTICS_SURFACE"]) delete env[key];
  return env;
}

export async function writeAnalyticsCliLauncher(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, "bb");
  await writeFile(path, `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const result = spawnSync(process.execPath, ["--conditions=source", "--import", "tsx", ${JSON.stringify(cliEntry)}, ...process.argv.slice(2)], { cwd: ${JSON.stringify(cliRoot)}, env: process.env, stdio: "inherit" });
if (result.error) { console.error(result.error); process.exit(1); }
process.exit(result.status ?? 1);
`, { mode: 0o700 });
  return path;
}

export async function withListeningAnalyticsCli<T>(harness: TestAppHarness, run: (fixture: {
  baseUrl: string;
  start(argv: string[], env: NodeJS.ProcessEnv): {
    child: ReturnType<typeof spawn>;
    closed: Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
    waitForWatcher(): Promise<void>;
  };
}) => Promise<T>, observeRequest?: (request: Request) => void): Promise<T> {
  const children = new Map<ReturnType<typeof spawn>, Promise<unknown>>();
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch(request) { observeRequest?.(request); return harness.app.fetch(request); } });
  try {
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Owned CLI fixture did not bind a TCP port");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    harness.config.serverPort = address.port;
    harness.pluginService.bindSdk({ baseUrl });
    return await run({
      baseUrl,
      start(argv, env) {
        const child = spawn(process.execPath, ["--conditions=source", "--import", "tsx", cliEntry, ...argv], { cwd: cliRoot, env, stdio: ["pipe", "pipe", "pipe"] });
        child.stdin.end();
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (value: string) => { stdout += value; });
        child.stderr.on("data", (value: string) => { stderr += value; });
        const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
        const closed = new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (exitCode) => { clearTimeout(timeout); children.delete(child); resolve({ exitCode, stdout, stderr }); });
        });
        children.set(child, closed);
        return {
          child,
          closed,
          async waitForWatcher() {
            if (stdout.includes("Watching ")) return;
            await new Promise<void>((resolve, reject) => {
              const ready = () => {
                if (!stdout.includes("Watching ")) return;
                child.stdout.off("data", ready);
                resolve();
              };
              child.stdout.on("data", ready);
              void closed.then((result) => { child.stdout.off("data", ready); reject(new Error(`Owned watcher exited before admission: ${result.exitCode}\n${result.stderr}`)); }, reject);
            });
          },
        };
      },
    });
  } finally {
    const pending = [...children.values()];
    for (const child of children.keys()) child.kill("SIGKILL");
    await Promise.allSettled(pending);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
