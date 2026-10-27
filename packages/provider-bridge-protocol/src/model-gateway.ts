import {
  constants,
  existsSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ModelConnectionSnapshot } from "@bb/domain";
import { z } from "zod";

export type ModelGateway = NonNullable<ModelConnectionSnapshot["gateway"]>;
export const gatewayModelSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    reasoning: z.boolean(),
    input: z.array(z.enum(["text", "image"])),
    supportsTools: z.boolean().optional(),
    cost: z.object({
      input: z.number(),
      output: z.number(),
      cacheRead: z.number(),
      cacheWrite: z.number(),
    }),
    contextWindow: z.number().positive(),
    maxTokens: z.number().positive(),
  })
  .passthrough();
export type GatewayModel = z.infer<typeof gatewayModelSchema>;

export function gatewayChildEnv(
  gateway: ModelGateway,
  workerEnv: NodeJS.ProcessEnv,
  launchEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env = { ...launchEnv };
  if (gateway.credential.kind === "env") {
    const name = gateway.credential.name;
    if (workerEnv[name] === undefined) delete env[name];
    else env[name] = workerEnv[name];
  }
  return env;
}

export function resolveGatewayCredential(
  gateway: ModelGateway,
  env: NodeJS.ProcessEnv,
): string {
  let value: string | undefined;
  if (gateway.credential.kind === "env") {
    value = env[gateway.credential.name];
  } else {
    if (!isAbsolute(gateway.credential.path))
      throw new Error("CPA credential file must be absolute.");
    const fd = openSync(
      gateway.credential.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.size > 16384 ||
        (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw new Error(
          "CPA credential file must be a small owner-only regular file owned by the worker user.",
        );
      const bytes = Buffer.alloc(16385);
      const count = readSync(fd, bytes, 0, bytes.length, 0);
      if (count > 16384)
        throw new Error("CPA credential file exceeds the size limit.");
      value = bytes.toString("utf8", 0, count);
    } finally {
      closeSync(fd);
    }
  }
  const key = value?.trim();
  if (!key || key.length > 16384 || /[\r\n\0]/.test(key))
    throw new Error(
      "CPA client credential is missing or invalid; native login fallback is disabled.",
    );
  return key;
}

export async function listGatewayModelIds(
  gateway: ModelGateway,
  key: string,
  fetchModels: typeof fetch = fetch,
): Promise<string[]> {
  let response: Response;
  try {
    response = await fetchModels(
      `${gateway.baseUrl.replace(/\/+$/, "")}/models`,
      {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      },
    );
  } catch {
    throw new Error(
      "CPA model discovery failed; check the endpoint and worker credential reference.",
    );
  }
  if (!response.ok)
    throw new Error(
      `CPA model discovery rejected the request (HTTP ${response.status}).`,
    );
  const body = z
    .object({ data: z.array(z.object({ id: z.string() })) })
    .parse(await response.json());
  const prefix = `${gateway.accountPrefix}/`;
  const ids = [...new Set(body.data.map((model) => model.id))].filter(
    (id) => id.startsWith(prefix) && id.length > prefix.length,
  );
  if (!ids.length)
    throw new Error("CPA returned no models in the bound account namespace.");
  return ids;
}

export async function discoverGatewayModels(
  gateway: ModelGateway,
  key: string,
  catalog: readonly GatewayModel[],
  fetchModels: typeof fetch = fetch,
): Promise<GatewayModel[]> {
  const ids = await listGatewayModelIds(gateway, key, fetchModels);
  const prefix = `${gateway.accountPrefix}/`;
  const models: GatewayModel[] = [];
  for (const id of ids) {
    const metadata = catalog.find(
      (model) => model.id === id.slice(prefix.length),
    );
    if (!metadata) continue;
    const {
      headers: _headers,
      baseUrl: _baseUrl,
      provider: _provider,
      api: _api,
      contextPromotionTarget: _promotion,
      compactionModel: _compaction,
      remoteCompaction: _remoteCompaction,
      transport: _transport,
      preferWebsockets: _websockets,
      ...safe
    } = metadata;
    models.push({ ...safe, id });
  }
  if (!models.length)
    throw new Error(
      "CPA returned no supported models in the bound account namespace.",
    );
  return models;
}

function gatewayReceiptPath(
  dataDir: string,
  id: string,
  directory: string,
): string {
  return join(
    dataDir,
    directory,
    `${createHash("sha256").update(id).digest("hex")}.json`,
  );
}

export function hasGatewayReceipt(
  dataDir: string,
  id: string,
  receiptDirectory = "omp-gateway",
): boolean {
  return existsSync(gatewayReceiptPath(dataDir, id, receiptDirectory));
}

export function pinGatewayReceipt(
  dataDir: string,
  threadId: string,
  gateway: ModelGateway,
  model: string,
  resume: boolean,
  receiptDirectory = "omp-gateway",
): { path: string; verify(): void } {
  const root = join(dataDir, receiptDirectory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = gatewayReceiptPath(dataDir, threadId, receiptDirectory);
  const receipt = { version: 1, gateway, model };
  const verify = () => {
    try {
      if (isDeepStrictEqual(JSON.parse(readFileSync(path, "utf8")), receipt))
        return;
    } catch {}
    throw new Error(
      "The pinned CPA model receipt is unavailable or changed; create a new thread to change its gateway binding.",
    );
  };
  if (resume) verify();
  else {
    try {
      writeFileSync(path, JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      verify();
    }
  }
  return { path, verify };
}

export function requireGatewayModel(
  model: string | undefined,
  gateway: ModelGateway,
  models: readonly Pick<GatewayModel, "id">[],
): string {
  const prefix = `bb-cpa/${gateway.accountPrefix}/`;
  if (
    !model?.startsWith(prefix) ||
    !models.some((entry) => `bb-cpa/${entry.id}` === model)
  )
    throw new Error(
      "Select an exact supported model from this CPA connection; native/default fallback is disabled.",
    );
  return model.slice("bb-cpa/".length);
}
