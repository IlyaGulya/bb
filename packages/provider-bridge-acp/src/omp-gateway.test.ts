import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverGatewayModels,
  gatewayChildEnv,
  pinGatewayReceipt,
  requireGatewayModel,
  resolveGatewayCredential,
  type GatewayModel,
  type OmpGateway,
} from "./omp-gateway.js";

const roots: string[] = [];
const gateway: OmpGateway = {
  baseUrl: "http://127.0.0.1:8317/v1/",
  protocol: "openai-responses",
  accountPrefix: "personal",
  modelProvider: "openai-codex",
  credential: { kind: "env", name: "CPA_CLIENT_KEY" },
  allowedHostIds: ["worker"],
};
const metadata: GatewayModel = {
  id: "gpt-example",
  name: "Native example",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 3, output: 9, cacheRead: 1, cacheWrite: 2 },
  contextWindow: 123456,
  maxTokens: 23456,
};
function root() {
  const path = mkdtempSync(join(tmpdir(), "bb-cpa-"));
  roots.push(path);
  return path;
}
afterEach(() => {
  for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe("CPA native gateway boundary", () => {
  it("uses only the declared client key and never an ambient native provider credential", () => {
    expect(
      gatewayChildEnv(
        gateway,
        { CPA_CLIENT_KEY: "worker-key" },
        { CPA_CLIENT_KEY: "plugin-key" },
      ).CPA_CLIENT_KEY,
    ).toBe("worker-key");
    expect(
      gatewayChildEnv(gateway, {}, { CPA_CLIENT_KEY: "plugin-key" })
        .CPA_CLIENT_KEY,
    ).toBeUndefined();
    expect(
      resolveGatewayCredential(gateway, {
        CPA_CLIENT_KEY: " selected-key ",
        OPENAI_API_KEY: "native-key",
      }),
    ).toBe("selected-key");
    expect(() =>
      resolveGatewayCredential(gateway, { OPENAI_API_KEY: "native-key" }),
    ).toThrow("missing");
    expect(() =>
      resolveGatewayCredential(gateway, { CPA_CLIENT_KEY: " \n " }),
    ).toThrow("missing");
  });
  it("reads a rotated owner-only file on each launch and refuses unsafe files", () => {
    const path = join(root(), "client-key");
    const selected: OmpGateway = {
      ...gateway,
      credential: { kind: "file", path },
    };
    writeFileSync(path, "first-key\n", { mode: 0o600 });
    expect(
      resolveGatewayCredential(selected, { CPA_CLIENT_KEY: "wrong-key" }),
    ).toBe("first-key");
    writeFileSync(path, "second-key\n");
    expect(resolveGatewayCredential(selected, {})).toBe("second-key");
    chmodSync(path, 0o644);
    expect(() => resolveGatewayCredential(selected, {})).toThrow("owner-only");
    chmodSync(path, 0o600);
    const link = join(root(), "link");
    symlinkSync(path, link);
    expect(() =>
      resolveGatewayCredential(
        { ...gateway, credential: { kind: "file", path: link } },
        {},
      ),
    ).toThrow();
  });
  it("pins routing and model mapping, detects edited receipts and allows secret rotation behind the reference", () => {
    const directory = root();
    const receipt = pinGatewayReceipt(
      directory,
      "thread",
      gateway,
      "bb-cpa/personal/gpt-example",
      false,
    );
    expect(() =>
      pinGatewayReceipt(
        directory,
        "thread",
        gateway,
        "bb-cpa/personal/gpt-example",
        true,
      ),
    ).not.toThrow();
    expect(() =>
      pinGatewayReceipt(
        directory,
        "thread",
        { ...gateway, baseUrl: "https://other.invalid/v1" },
        "bb-cpa/personal/gpt-example",
        true,
      ),
    ).toThrow("receipt");
    writeFileSync(receipt.path, "{}");
    expect(receipt.verify).toThrow("receipt");
  });
  it("joins the model API base, binds exact namespaces and copies real metadata only", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              { id: "personal/gpt-example" },
              { id: "personal-other/gpt-example" },
              { id: "other/gpt-example" },
              { id: "personal/unknown" },
              { id: "personal/gpt-example" },
            ],
          }),
        ),
      );
    const models = await discoverGatewayModels(
      gateway,
      "client-key",
      [metadata],
      fetch,
    );
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8317/v1/models",
      expect.objectContaining({
        headers: { Authorization: "Bearer client-key" },
        redirect: "error",
      }),
    );
    expect(models).toEqual([{ ...metadata, id: "personal/gpt-example" }]);
    expect(
      requireGatewayModel("bb-cpa/personal/gpt-example", gateway, models),
    ).toBe("personal/gpt-example");
    for (const selection of [
      undefined,
      "default",
      "openai-codex/gpt-example",
      "bb-cpa/other/gpt-example",
      "bb-cpa/personal/unknown",
    ])
      expect(() => requireGatewayModel(selection, gateway, models)).toThrow(
        "fallback",
      );
  });
  it("fails closed for missing auth, unsupported models, and ambiguous namespace matches", async () => {
    const unauthorized = vi
      .fn()
      .mockResolvedValue(new Response("unauthorized", { status: 401 }));
    await expect(
      discoverGatewayModels(gateway, "bad-key", [metadata], unauthorized),
    ).rejects.toThrow("401");
    const unknown = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              { id: "personal-other/gpt-example" },
              { id: "personal/unknown" },
            ],
          }),
        ),
      );
    await expect(
      discoverGatewayModels(gateway, "client-key", [metadata], unknown),
    ).rejects.toThrow("no supported models");
  });
});
