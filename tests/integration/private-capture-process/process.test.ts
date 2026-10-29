import { createHash } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureManifestSchema, captureSessionSchema, redactCapturePayload, type CaptureManifest, type CaptureSession } from "@bb/domain";
import { spawnManagedProcess, type ManagedProcess } from "../../../packages/process-utils/src/managed-process.js";
import { exchangeHostCapture, startHostCaptureOutbox } from "../../../apps/host-daemon/src/private-capture.js";
import { captureSessionFixture } from "../../../apps/host-daemon/test/private-capture-fixtures.js";
import { captureCipherContext, captureReadEncrypted } from "@bb/process-utils";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const client = String.raw`
import base64, hashlib, http.client, json, os, subprocess, sys, urllib.parse
proxy = urllib.parse.urlsplit(os.environ["HTTP_PROXY"])
auth = base64.b64encode((proxy.username + ":" + proxy.password).encode()).decode()
port = int(sys.argv[1])
body = json.dumps({"api_key":"SYNTHETIC_BODY_SECRET", "payload":"s" * 405000}, separators=(",", ":")).encode()
def connection():
    return http.client.HTTPConnection(proxy.hostname, proxy.port, timeout=30)
first = connection()
first.request("POST", "http://127.0.0.1:" + str(port) + "/body", body, {"Proxy-Authorization":"Basic " + auth, "X-Api-Key":"SYNTHETIC_HEADER_SECRET", "Content-Type":"application/json"})
assert first.getresponse().read() == b"SYNTHETIC_ORIGIN_ACK"
first.close()
stream = connection()
stream.request("GET", "http://127.0.0.1:" + str(port) + "/stream", headers={"Proxy-Authorization":"Basic " + auth})
response = stream.getresponse()
head = response.readline()
assert head == b"data: SYNTHETIC_FIRST\n"
ack = connection()
ack.request("GET", "http://127.0.0.1:" + str(port) + "/first-observed", headers={"Proxy-Authorization":"Basic " + auth})
assert ack.getresponse().status == 204
ack.close()
assert head + response.read() == b"data: SYNTHETIC_FIRST\n\ndata: SYNTHETIC_LAST\n\n"
stream.close()
server = "import sys,json,hashlib; value=json.loads(sys.stdin.readline()); print(json.dumps({'jsonrpc':'2.0','id':value['id'],'result':{'content':[{'type':'text','text':hashlib.sha256(value['params']['arguments']['value'].encode()).hexdigest()}]}}),flush=True)"
mcp = subprocess.Popen(json.loads(sys.argv[2]) + [sys.executable, "-u", "-c", server], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
query = {"jsonrpc":"2.0", "id":"synthetic-call", "method":"tools/call", "params":{"name":"sha256", "arguments":{"value":"SYNTHETIC_MCP_INPUT"}}}
output, _ = mcp.communicate((json.dumps(query) + "\n").encode(), timeout=30)
assert mcp.returncode == 0
assert json.loads(output)["result"]["content"][0]["text"] == hashlib.sha256(b"SYNTHETIC_MCP_INPUT").hexdigest()
print(json.dumps({"originInputSha256":hashlib.sha256(body).hexdigest(), "mcpResultSha256":hashlib.sha256(b"SYNTHETIC_MCP_INPUT").hexdigest()}), flush=True)
`;

describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")("explicit opt-in synthetic process capture", () => {
  let root = "";
  let python: string;
  let session: CaptureSession;
  let child: ManagedProcess | undefined;
  let origin: Server | undefined;

  beforeEach(async () => {
    root = "";
    const configured = process.env.BB_CAPTURE_PYTHON;
    if (!configured) throw new Error("Set BB_CAPTURE_PYTHON to an operator-provisioned Python >=3.12 with cryptography; mitmproxy==12.3.1 must be installed there or explicitly selected with BB_CAPTURE_MITMDUMP. No installation occurs.");
    python = configured;
    root = await mkdtemp(join(tmpdir(), "bb-capture-process-synthetic-"));
    session = captureSessionSchema.parse(captureSessionFixture(undefined, { runtimeId: "synthetic-http-mcp", runtimeVersion: "fixture" }, {
      process: { python, ...(process.env.BB_CAPTURE_MITMDUMP ? { mitmdump: process.env.BB_CAPTURE_MITMDUMP } : {}), network: "explicit-proxy", trust: "ssl-cert-file", native: "terminal", binaryReview: "owner-reviewed-no-auth-material" },
    }));
  });
  afterEach(async () => {
    if (!root) return;
    if (child) await child.stop();
    if (origin) {
      origin.closeAllConnections();
      await new Promise<void>((resolve, reject) => origin!.close(error => error ? reject(error) : resolve()));
    }
    const lifecycle = startHostCaptureOutbox(root);
    await lifecycle.stop();
    await rm(root, { recursive: true, force: true });
    child = undefined;
    origin = undefined;
  });

  function exchange(poll = true) {
    return exchangeHostCapture(root, { type: "capture.exchange", session, leaseUntil: Math.min(session.expiresAt, Date.now() + 300000), ack: null, poll });
  }
  async function artifacts(): Promise<Array<{ manifest: CaptureManifest; body: Buffer }>> {
    const directory = join(root, "private-capture", "host", session.id, "outbox");
    const result = [];
    for (const id of await readdir(directory)) {
      const manifest = captureManifestSchema.parse(JSON.parse(await readFile(join(directory, id, "manifest.json"), "utf8")));
      const body = Buffer.concat(await Promise.all(manifest.chunks.map(chunk => captureReadEncrypted(join(directory, id), `${chunk.sequence}.chunk`, 262144, captureCipherContext(root, "host", session, `${manifest.artifactId}/${chunk.sequence}.chunk`)))));
      expect(sha(body)).toBe(manifest.storedSha256);
      result.push({ manifest, body });
    }
    return result;
  }

  it("forwards a multichunk body unchanged, delivers SSE before EOF, independently records MCP and excludes a direct unrelated client", async () => {
    let completeFirst!: () => void;
    const observedFirst = new Promise<void>(resolve => { completeFirst = resolve; });
    let endStream!: () => void;
    const received: Buffer[] = [];
    const headers: Array<string | string[] | undefined> = [];
    origin = createServer(async (req, response) => {
      if (req.url === "/body") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        received.push(Buffer.concat(chunks));
        headers.push(req.headers["x-api-key"]);
        response.end("SYNTHETIC_ORIGIN_ACK");
      } else if (req.url === "/stream") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: SYNTHETIC_FIRST\n\n");
        endStream = () => response.end("data: SYNTHETIC_LAST\n\n");
      } else if (req.url === "/first-observed") {
        completeFirst();
        response.writeHead(204).end();
      } else {
        response.end("SYNTHETIC_UNRELATED_NOT_CAPTURED");
      }
    });
    await new Promise<void>(resolve => origin!.listen(0, "127.0.0.1", resolve));
    const address = origin.address();
    if (!address || typeof address === "string") throw new Error("Synthetic fixture has no TCP port");
    const prepared = await exchange(false);
    if (!prepared.status.process) throw new Error("Process preparation returned no process contract");
    const prefix = prepared.status.process.launchPrefix;
    if (!prefix[0]) throw new Error("Missing process launcher");
    child = spawnManagedProcess({ command: prefix[0], args: [...prefix.slice(1), python, "-u", "-c", client, String(address.port), JSON.stringify(prepared.status.process.mcpPrefix)], env: { PATH: process.env.PATH }, cwd: root });
    const output: Buffer[] = [];
    child.child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.child.stderr.resume();
    const closed = new Promise<number | null>((resolve, reject) => { child!.child.once("error", reject); child!.child.once("close", resolve); });
    await Promise.race([observedFirst, closed.then(code => { throw new Error(`Synthetic native client exited before first SSE observation (${code})`); })]);
    expect(received).toEqual([Buffer.from(JSON.stringify({ api_key: "SYNTHETIC_BODY_SECRET", payload: "s".repeat(405000) }))]);
    expect(headers).toEqual(["SYNTHETIC_HEADER_SECRET"]);
    await new Promise<void>((resolve, reject) => {
      const unrelated = request({ host: "127.0.0.1", port: address.port, path: "/outside" }, response => { response.resume(); response.once("end", resolve); });
      unrelated.once("error", reject);
      unrelated.end();
    });
    endStream();
    expect(await closed).toBe(0);
    const summary: unknown = JSON.parse(Buffer.concat(output).toString("utf8"));
    expect(summary).toEqual({ originInputSha256: sha(received[0]!), mcpResultSha256: sha(Buffer.from("SYNTHETIC_MCP_INPUT")) });
    await exchange();
    const stored = await artifacts();
    const networkBodies = stored.filter(item => item.manifest.source === "mitmproxy" && item.manifest.process?.role === "body");
    const sent = networkBodies.find(item => item.manifest.process?.direction === "request" && item.manifest.sourceSha256 === sha(received[0]!));
    expect(sent?.body).toEqual(Buffer.from(redactCapturePayload(received[0]!).bytes));
    expect(sent?.manifest.chunks.map(chunk => chunk.sequence)).toEqual([0, 1]);
    const stream = networkBodies.find(item => item.manifest.transport === "sse");
    expect(stream?.body).toEqual(Buffer.from("data: SYNTHETIC_FIRST\n\ndata: SYNTHETIC_LAST\n\n"));
    expect(stream?.manifest.streamState).toBe("complete");
    const mcp = stored.filter(item => item.manifest.source === "mcp-stdio" && item.manifest.process?.role === "body");
    expect(mcp.map(item => item.manifest.process?.direction).sort()).toEqual(["stdin", "stdout"]);
    expect(mcp.find(item => item.manifest.process?.direction === "stdin")?.body.toString()).toContain("SYNTHETIC_MCP_INPUT");
    expect(mcp.find(item => item.manifest.process?.direction === "stdout")?.body.toString()).toContain(sha(Buffer.from("SYNTHETIC_MCP_INPUT")));
    expect(stored.some(item => item.body.includes("SYNTHETIC_HEADER_SECRET") || item.body.includes("SYNTHETIC_BODY_SECRET") || item.body.includes("SYNTHETIC_UNRELATED_NOT_CAPTURED"))).toBe(false);
  });
});
