import { describe, expect, it, vi } from "vitest";
import { registerModelConnectionCommands } from "../../commands/execution-context.js";
import {
  runCommand,
  setupCommandOutputTestEnvironment,
  stubServerApi,
  type CommandRegistrar,
} from "../helpers/command-output-harness.js";

const gateway = {
  baseUrl: "http://cpa:8317/v1",
  protocol: "openai-responses",
  accountPrefix: "personal",
  modelProvider: "openai-codex",
  credential: { kind: "env", name: "CPA_CLIENT_KEY" },
  allowedHostIds: ["worker-a"],
};
const nativeAuth = { configDir: null, profile: null, hostEnv: null };
const connection = {
  id: "conn-cpa",
  name: "Personal",
  provider: "acp-omp",
  hostId: null,
  enabled: true,
  revoked: false,
  nativeAuth,
  gateway,
  createdAt: 1,
  updatedAt: 1,
};

describe("bb model-connection gateway controls", () => {
  setupCommandOutputTestEnvironment();
  const register: CommandRegistrar = (program) =>
    registerModelConnectionCommands(program, () => "http://server");
  it.each(["--gateway-api-key", "--gateway-token", "--gateway-credential"])(
    "does not accept raw credential flags: %s",
    async (flag) => {
      const post = vi.fn(async () => connection);
      stubServerApi({ "v1.model-connections.$post": post });
      await expect(runCommand([
        "model-connection", "create", "--name", "Personal", flag, "not-a-reference",
      ], register)).rejects.toThrow();
      expect(post).not.toHaveBeenCalled();
    },
  );


  it("creates a portable gateway with only worker credential references", async () => {
    const post = vi.fn(async () => connection);
    stubServerApi({ "v1.model-connections.$post": post });
    await runCommand([
      "model-connection", "create", "--name", "Personal",
      "--gateway-base-url", gateway.baseUrl,
      "--gateway-protocol", gateway.protocol,
      "--gateway-account-prefix", gateway.accountPrefix,
      "--gateway-model-provider", gateway.modelProvider,
      "--gateway-credential-env", gateway.credential.name,
      "--gateway-allowed-host", "worker-a",
      "--gateway-allowed-host", "worker-b", "--json",
    ], register);
    expect(post).toHaveBeenCalledWith({ json: {
      name: "Personal",
      provider: "acp-omp",
      hostId: null,
      enabled: true,
      revoked: false,
      nativeAuth,
      gateway: { ...gateway, allowedHostIds: ["worker-a", "worker-b"] },
    } });
  });

  it("edits a gateway reference without losing the frozen configuration fields", async () => {
    const patch = vi.fn(async () => connection);
    stubServerApi({
      "v1.model-connections.:id.$get": vi.fn(async () => connection),
      "v1.model-connections.$patch": patch,
    });
    await runCommand([
      "model-connection", "update", connection.id,
      "--gateway-credential-file", "/run/credentials/cpa-client", "--json",
    ], register);
    expect(patch).toHaveBeenCalledWith({ json: {
      id: connection.id,
      provider: "acp-omp",
      hostId: null,
      nativeAuth,
      gateway: { ...gateway, credential: { kind: "file", path: "/run/credentials/cpa-client" } },
    } });
  });

  it("clears the gateway when selecting a native host", async () => {
    const patch = vi.fn(async () => ({ ...connection, hostId: "worker-a", gateway: null }));
    stubServerApi({ "v1.model-connections.$patch": patch });
    await runCommand([
      "model-connection", "update", connection.id, "--host", "worker-a", "--json",
    ], register);
    expect(patch).toHaveBeenCalledWith({ json: {
      id: connection.id, hostId: "worker-a", gateway: null,
    } });
  });

  it.each([
    ["--gateway-credential-env", "raw-key=not-an-env-name"],
    ["--gateway-credential-file", "relative-key-path"],
  ])("rejects invalid credential references before sending an update: %s", async (flag, value) => {
    const patch = vi.fn(async () => connection);
    stubServerApi({
      "v1.model-connections.:id.$get": vi.fn(async () => connection),
      "v1.model-connections.$patch": patch,
    });
    await expect(runCommand([
      "model-connection", "update", connection.id, flag, value, "--json",
    ], register)).rejects.toThrow();
    expect(patch).not.toHaveBeenCalled();
  });

  it("rejects ambiguous credential references", async () => {
    const patch = vi.fn(async () => connection);
    stubServerApi({
      "v1.model-connections.:id.$get": vi.fn(async () => connection),
      "v1.model-connections.$patch": patch,
    });
    await expect(runCommand([
      "model-connection", "update", connection.id,
      "--gateway-credential-env", "CPA_CLIENT_KEY",
      "--gateway-credential-file", "/run/credentials/cpa-client", "--json",
    ], register)).rejects.toThrow();
    expect(patch).not.toHaveBeenCalled();
  });
});
