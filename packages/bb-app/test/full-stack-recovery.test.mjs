import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildNodeEsmEntry } from "../../../scripts/build-utils.mjs";

let root;
let launcher;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "bb-full-stack-recovery-"));
  launcher = join(root, "dist", "bb-app.js");
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await buildNodeEsmEntry({
    cleanDist: false,
    entryPoint: fileURLToPath(new URL("../src/bin/bb-app.ts", import.meta.url)),
    outfile: launcher,
    packageRoot: root,
    sourcemap: false,
  });
  const daemonDir = join(root, "host-daemon", "dist");
  const serverDir = join(root, "server", "dist");
  const appDir = join(root, "app", "dist");
  await mkdir(join(daemonDir, "bb-chunks"), { recursive: true });
  await mkdir(serverDir, { recursive: true });
  await mkdir(appDir, { recursive: true });
  for (const name of [
    "bb",
    "bb-chunks/fixture.js",
    "bb-provider-bridge-worker.mjs",
    "bb-parcel-watcher-child.mjs",
    "bb-plugin-host-worker.mjs",
  ]) {
    await writeFile(join(daemonDir, name), "");
  }
  await writeFile(join(appDir, "index.html"), "<!doctype html>");
  await writeFile(
    join(serverDir, "index.js"),
    `
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
const server = createServer((_request, response) => {
  response.end(JSON.stringify({ ok: true, launchId: process.env.BB_SERVER_LAUNCH_ID }));
});
server.listen(Number(process.env.BB_SERVER_PORT), "127.0.0.1", () => {
  appendFileSync(join(process.env.BB_DATA_DIR, "events"), JSON.stringify({
    kind: "server", pid: process.pid, at: Date.now(),
  }) + "\\n");
});
`,
  );
  await writeFile(
    join(daemonDir, "daemon-bundle.mjs"),
    `
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
const eventsFile = join(process.env.BB_DATA_DIR, "events");
const previousDaemons = readFileSync(eventsFile, "utf8").split("\\n")
  .filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.kind === "daemon");
appendFileSync(eventsFile, JSON.stringify({ kind: "daemon", pid: process.pid, at: Date.now() }) + "\\n");
const connected = previousDaemons.length === 0;
if (!connected && process.env.TEST_DAEMON_MODE === "failing") process.exit(1);
createServer((_request, response) => {
  response.end(JSON.stringify({
    connected,
    hostId: process.env.BB_HOST_ID,
    serverUrl: process.env.BB_SERVER_URL,
  }));
}).listen(Number(process.env.BB_HOST_DAEMON_PORT), "127.0.0.1");
`,
  );
}, 30_000);

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function reserveFreePort() {
  const listener = createServer();
  const listening = once(listener, "listening");
  listener.listen(0, "127.0.0.1");
  await listening;
  const port = listener.address().port;
  const closed = once(listener, "close");
  listener.close();
  await closed;
  return port;
}

async function readEvents(dataDir) {
  try {
    return (await readFile(join(dataDir, "events"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function waitFor(condition, describeFailure) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const result = await condition();
    if (result) return result;
    await sleep(20);
  }
  throw new Error(describeFailure());
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

it.for(["failing", "unready"])(
  "recovers a dead server during %s daemon restarts and reaps interrupted children",
  async (mode, { skip }) => {
    skip(
      process.platform === "win32",
      "Windows cannot deliver a catchable SIGTERM to the launcher",
    );
    const dataDir = await mkdtemp(join(root, "data-"));
    const serverPort = await reserveFreePort();
    let daemonPort = await reserveFreePort();
    while (daemonPort === serverPort) daemonPort = await reserveFreePort();
    const child = spawn(
      process.execPath,
      [
        launcher,
        "--no-in-app-updates",
        "--data-dir",
        dataDir,
        "--server-port",
        String(serverPort),
        "--host-daemon-port",
        String(daemonPort),
      ],
      {
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([key]) => !key.startsWith("BB_"),
            ),
          ),
          BB_HOST_ID: "full-stack-recovery-test",
          BB_HOST_ENROLL_KEY: "test-enrollment",
          TEST_DAEMON_MODE: mode,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const exited = once(child, "exit").then(([code]) => code);
    const failure = () =>
      `Launcher did not recover during ${mode} daemon restart:\n${output}`;
    try {
      await waitFor(() => output.includes("bb is ready"), failure);
      const initial = await readEvents(dataDir);
      const firstServer = initial.find((event) => event.kind === "server");
      const firstDaemon = initial.find((event) => event.kind === "daemon");
      expect(firstServer).toBeDefined();
      expect(firstDaemon).toBeDefined();
      process.kill(firstDaemon.pid, "SIGTERM");
      const retryCount = mode === "failing" ? 3 : 2;
      const daemons = await waitFor(async () => {
        const runs = (await readEvents(dataDir)).filter(
          (event) => event.kind === "daemon",
        );
        return runs.length >= retryCount ? runs : null;
      }, failure);
      if (mode === "failing") {
        expect(daemons[2].at - daemons[1].at).toBeGreaterThanOrEqual(900);
        await waitFor(
          () => output.split("Host daemon failed to restart").length >= 3,
          failure,
        );
      } else {
        await waitFor(async () => {
          try {
            const status = await fetch(
              `http://127.0.0.1:${daemonPort}/status`,
            ).then((response) => response.json());
            return status.connected === false;
          } catch {
            return false;
          }
        }, failure);
      }
      process.kill(firstServer.pid, "SIGTERM");
      const servers = await waitFor(async () => {
        const runs = (await readEvents(dataDir)).filter(
          (event) => event.kind === "server",
        );
        return runs.length >= 2 ? runs : null;
      }, failure);
      expect(servers).toHaveLength(2);
      expect(servers[1].pid).not.toBe(firstServer.pid);
      if (mode === "unready") expect(isAlive(daemons[1].pid)).toBe(false);
      const health = await fetch(`http://127.0.0.1:${serverPort}/health`).then(
        (response) => response.json(),
      );
      expect(health.ok).toBe(true);
      await waitFor(async () => {
        const runs = (await readEvents(dataDir)).filter(
          (event) => event.kind === "daemon",
        );
        return runs.length > daemons.length;
      }, failure);
      child.kill("SIGTERM");
      const shutdownTimeout = setTimeout(() => child.kill("SIGKILL"), 8_000);
      try {
        expect(await exited, output).toBe(0);
      } finally {
        clearTimeout(shutdownTimeout);
      }
      for (const event of await readEvents(dataDir)) {
        expect(
          isAlive(event.pid),
          `Leaked ${event.kind} child ${event.pid}`,
        ).toBe(false);
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
      const cleanupTimeout = setTimeout(() => child.kill("SIGKILL"), 8_000);
      try {
        await exited;
      } finally {
        clearTimeout(cleanupTimeout);
        for (const event of await readEvents(dataDir)) {
          try {
            process.kill(event.pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        }
      }
    }
  },
  30_000,
);
