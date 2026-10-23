import { ApiError } from "../../src/errors.js";
import type { ProviderReadiness } from "@bb/domain";
import { createDeferredPromise } from "@bb/test-helpers";
import { describe, expect, it, vi } from "vitest";
import { createProviderRegistryService } from "../../src/services/providers/provider-registry.js";
import { minimalProviderRegistration } from "../helpers/provider-registry.js";

const CURSOR_LIKE_INFO = {
  pluginId: "provider-acp",
  available: true,
  maintenance: { health: true, usage: true, installation: false },
  capabilities: {
    supportsThreadArchive: false,
    supportsThreadRename: false,
    supportsServiceTier: false,
    supportsNativeUserQuestion: false,
    supportsFork: false,
    supportsSessionRewind: false,
    modelCatalogScope: "workspace" as const,
    permissionModes: ["full" as const],
  },
  composerActions: [],
  completedTurnDisplay: "collapse" as const,
  displayName: "Plugin Provider",
  id: "plugin-provider",
  logoUrl: null,
};

const MINIMAL_SERVER_CAPABILITIES = {
  supportsManualCompaction: false,
  reasoningLevels: ["medium" as const],
  fork: "none" as const,
};

function registerProvider(
  registry: ReturnType<typeof createProviderRegistryService>,
  id: string,
  pluginId: string,
  installRank?: { bundledIndex: number | null; installedAt: number },
): { dispose(): void } {
  return registry.register({
    ...minimalProviderRegistration({
      pluginId,
      info: { ...CURSOR_LIKE_INFO, id },
      serverCapabilities: MINIMAL_SERVER_CAPABILITIES,
    }),
    ...(installRank === undefined ? {} : { installRank }),
  });
}

describe("provider registry policy accessors", () => {
  it("answers from the registration, not a core seed", () => {
    const registry = createProviderRegistryService();
    registry.register(
      minimalProviderRegistration({
        pluginId: "provider-codex",
        info: {
          ...CURSOR_LIKE_INFO,
          id: "codex",
          capabilities: {
            ...CURSOR_LIKE_INFO.capabilities,
            supportsFork: true,
            supportsSessionRewind: true,
            modelCatalogScope: "workspace",
            permissionModes: ["accept-edits", "full"],
          },
        },
        serverCapabilities: MINIMAL_SERVER_CAPABILITIES,
      }),
    );
    expect(registry.getServerCapabilities("codex")).toStrictEqual(
      MINIMAL_SERVER_CAPABILITIES,
    );
    expect(registry.getSupportedPermissionModes("codex")).toStrictEqual([
      "accept-edits",
      "full",
    ]);
    expect(registry.supportsFork("codex")).toBe(true);
  });

  it("answers for an unregistered acp-* id exactly as for any unknown id", () => {
    const registry = createProviderRegistryService();
    expect(registry.getServerCapabilities("acp-custom-agent")).toBeNull();
    expect(registry.getSupportedPermissionModes("acp-custom-agent")).toBeNull();
    expect(registry.supportsFork("acp-custom-agent")).toBe(false);
    expect(registry.supportsSessionRewind("acp-custom-agent")).toBe(false);
    expect(registry.supportsManualCompaction("acp-opencode")).toBe(false);
  });

  it("stops claiming capabilities for a provider whose plugin is gone", () => {
    const registry = createProviderRegistryService();
    const handle = registry.register(
      minimalProviderRegistration({
        pluginId: "provider-codex",
        info: { ...CURSOR_LIKE_INFO, id: "codex" },
        serverCapabilities: {
          ...MINIMAL_SERVER_CAPABILITIES,
          supportsManualCompaction: true,
        },
      }),
    );
    expect(registry.supportsManualCompaction("codex")).toBe(true);

    handle.dispose();
    expect(registry.get("codex")).toBeNull();
    expect(registry.supportsManualCompaction("codex")).toBe(false);
    expect(registry.getServerCapabilities("codex")).toBeNull();
  });
});

describe("provider registry ordering", () => {
  it("lists bundled plugins first in bundled order, then others by install time", () => {
    const registry = createProviderRegistryService();
    registerProvider(registry, "late-agent", "late", {
      bundledIndex: null,
      installedAt: 2_000,
    });
    registerProvider(registry, "pi", "provider-pi", {
      bundledIndex: 2,
      installedAt: 5_000,
    });
    registerProvider(registry, "early-agent", "early", {
      bundledIndex: null,
      installedAt: 1_000,
    });
    registerProvider(registry, "codex", "provider-codex", {
      bundledIndex: 0,
      installedAt: 9_000,
    });

    expect(registry.list().map((entry) => entry.info.id)).toStrictEqual([
      "codex",
      "pi",
      "early-agent",
      "late-agent",
    ]);
  });

  it("keeps registration order among entries with no install rank", () => {
    const registry = createProviderRegistryService();
    registerProvider(registry, "zeta-agent", "zeta");
    registerProvider(registry, "alpha-agent", "alpha");
    registerProvider(registry, "codex", "provider-codex", {
      bundledIndex: 0,
      installedAt: 0,
    });

    expect(registry.list().map((entry) => entry.info.id)).toStrictEqual([
      "codex",
      "zeta-agent",
      "alpha-agent",
    ]);
  });

  it("re-enabling a provider plugin restores its listing position", () => {
    const registry = createProviderRegistryService();
    registerProvider(registry, "codex", "provider-codex", {
      bundledIndex: 0,
      installedAt: 0,
    });
    const pi = registerProvider(registry, "pi", "provider-pi", {
      bundledIndex: 1,
      installedAt: 0,
    });
    registerProvider(registry, "acp-cursor", "provider-acp", {
      bundledIndex: 2,
      installedAt: 0,
    });

    pi.dispose();
    expect(registry.list().map((entry) => entry.info.id)).toStrictEqual([
      "codex",
      "acp-cursor",
    ]);

    registerProvider(registry, "pi", "provider-pi", {
      bundledIndex: 1,
      installedAt: 0,
    });
    expect(registry.list().map((entry) => entry.info.id)).toStrictEqual([
      "codex",
      "pi",
      "acp-cursor",
    ]);
  });

  it("lets the user's providerOrder lead and reads a default only when registered", () => {
    const preferences = {
      providerOrder: ["acp-cursor", "ghost", "pi"],
      defaultProviderId: "ghost" as string | null,
    };
    const registry = createProviderRegistryService({
      readUserProviderPreferences: () => preferences,
    });
    registerProvider(registry, "codex", "provider-codex", {
      bundledIndex: 0,
      installedAt: 0,
    });
    registerProvider(registry, "pi", "provider-pi", {
      bundledIndex: 1,
      installedAt: 0,
    });
    registerProvider(registry, "acp-cursor", "provider-acp", {
      bundledIndex: 2,
      installedAt: 0,
    });

    expect(registry.list().map((entry) => entry.info.id)).toStrictEqual([
      "acp-cursor",
      "pi",
      "codex",
    ]);
    expect(registry.getUserDefaultProviderId()).toBeNull();
    preferences.defaultProviderId = "codex";
    expect(registry.getUserDefaultProviderId()).toBe("codex");
    preferences.providerOrder = [];
    expect(registry.list().map((entry) => entry.info.id)).toStrictEqual([
      "codex",
      "pi",
      "acp-cursor",
    ]);
  });
});

describe("provider registry", () => {
  it("starts empty: providers exist only while a plugin declares them", () => {
    expect(createProviderRegistryService().list()).toStrictEqual([]);
  });

  it("frees an id the moment its registration is disposed", () => {
    const registry = createProviderRegistryService();
    for (const providerId of ["codex", "pi", "acp-cursor", "acp-anything"]) {
      const handle = registerProvider(registry, providerId, "first-plugin");
      expect(() =>
        registerProvider(registry, providerId, "second-plugin"),
      ).toThrow(/already registered/);
      handle.dispose();
      registerProvider(registry, providerId, "second-plugin").dispose();
    }
  });

  it("adds and disposes plugin registrations", () => {
    const registry = createProviderRegistryService();
    const handle = registry.register(
      minimalProviderRegistration({
        pluginId: "some-plugin",
        info: CURSOR_LIKE_INFO,
        serverCapabilities: MINIMAL_SERVER_CAPABILITIES,
      }),
    );
    expect(registry.get("plugin-provider")).toMatchObject({
      pluginId: "some-plugin",
    });
    expect(registry.list()).toHaveLength(1);

    handle.dispose();
    expect(registry.get("plugin-provider")).toBeNull();
    expect(registry.list()).toHaveLength(0);

    const second = registry.register(
      minimalProviderRegistration({
        pluginId: "other-plugin",
        info: CURSOR_LIKE_INFO,
        serverCapabilities: MINIMAL_SERVER_CAPABILITIES,
      }),
    );
    handle.dispose();
    expect(registry.get("plugin-provider")).toMatchObject({
      pluginId: "other-plugin",
    });
    second.dispose();
  });

  it("releases a provider-scoped boot wait as soon as that provider registers", async () => {
    const registry = createProviderRegistryService({
      deferRegistrationsSettled: true,
    });
    let requestedProviderReady = false;
    let unrelatedProviderReady = false;
    const requestedWait = registry.whenProviderRegistered("codex").then(() => {
      requestedProviderReady = true;
    });
    const unrelatedWait = registry
      .whenProviderRegistered("claude-code")
      .then(() => {
        unrelatedProviderReady = true;
      });

    registerProvider(registry, "codex", "provider-codex");
    await requestedWait;

    expect(requestedProviderReady).toBe(true);
    expect(unrelatedProviderReady).toBe(false);

    registry.markRegistrationsSettled();
    await unrelatedWait;
    expect(unrelatedProviderReady).toBe(true);
  });

  it("releases an ACP wait only on that agent's own registration", async () => {
    const registry = createProviderRegistryService({
      deferRegistrationsSettled: true,
    });
    let released = false;
    const ready = registry.whenProviderRegistered("acp-opencode").then(() => {
      released = true;
    });

    registerProvider(registry, "acp-cursor", "provider-acp");
    await Promise.resolve();
    expect(released).toBe(false);

    registerProvider(registry, "acp-opencode", "provider-acp");
    await ready;
    expect(registry.get("acp-opencode")).not.toBeNull();
  });
});

describe("provider readiness observations", () => {
  const ready = () => ({
    verification: "required" as const,
    scope: "host" as const,
    status: "ready" as const,
    freshness: "fresh" as const,
    checkedAt: Date.now(),
    retryAfterMs: null,
    detail: "Ready",
  });
  const key = { hostId: "host_1", providerId: "codex" };

  it("shares a cold probe without claiming initialization is readiness", async () => {
    const registry = createProviderRegistryService();
    const held = createDeferredPromise<ProviderReadiness>();
    const probe = vi.fn(() => held.promise);
    const first = registry.resolveReadiness(key, probe);
    const second = registry.resolveReadiness(key, probe);
    expect(registry.lookupReadiness(key)).toMatchObject({
      status: "initializing",
      freshness: "unverified",
      checkedAt: null,
    });
    await Promise.resolve();
    expect(probe).toHaveBeenCalledTimes(1);
    held.resolve(ready());
    expect(await first).toMatchObject({ status: "ready", freshness: "fresh" });
    expect(await second).toEqual(await first);
  });

  it("retains observations as stale across transient failure and applies a retry cooldown", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const registry = createProviderRegistryService();
      const observation = ready();
      registry.observeReadiness(key, observation);
      vi.setSystemTime(Date.now() + 5 * 60_000);
      const failing = vi.fn(async () => {
        throw new Error("host timeout");
      });
      expect(await registry.resolveReadiness(key, failing)).toMatchObject({
        status: "ready",
        freshness: "stale",
        checkedAt: observation.checkedAt,
        retryAfterMs: 5_000,
      });
      await vi.waitFor(() =>
        expect(registry.lookupReadiness(key)?.detail).toContain(
          "refresh failed",
        ),
      );
      await registry.resolveReadiness(key, failing);
      expect(failing).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 5_000);
      await registry.resolveReadiness(key, async () => ({
        ...ready(),
        status: "not_installed",
      }));
      await vi.waitFor(() =>
        expect(registry.lookupReadiness(key)).toMatchObject({
          status: "not_installed",
          freshness: "fresh",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not turn a cold failure into confirmed absence", async () => {
    const registry = createProviderRegistryService();
    expect(
      await registry.resolveReadiness(key, async () => {
        throw new ApiError(502, "host_unavailable", "Host is unavailable");
      }),
    ).toMatchObject({
      status: "initializing",
      freshness: "unverified",
      checkedAt: null,
      retryAfterMs: 5_000,
    });
  });

  it("does not overwrite a newer observation when an older probe finishes", async () => {
    const registry = createProviderRegistryService();
    const held = createDeferredPromise<ProviderReadiness>();
    const pending = registry.resolveReadiness(key, () => held.promise);
    registry.invalidateReadiness();
    registry.observeReadiness(key, { ...ready(), status: "auth_required" });
    held.resolve(ready());
    await pending;
    expect(registry.lookupReadiness(key)?.status).toBe("auth_required");
  });

  it("isolates hosts and invalidates only the changed provider registration", () => {
    const registry = createProviderRegistryService();
    const registration = registerProvider(registry, "codex", "provider-codex");
    registry.observeReadiness(key, ready());
    registry.observeReadiness(
      { ...key, hostId: "host_2" },
      { ...ready(), status: "not_installed" },
    );
    registry.observeReadiness({ ...key, providerId: "pi" }, ready());
    registerProvider(registry, "claude-code", "provider-claude-code");
    expect(registry.lookupReadiness(key)?.status).toBe("ready");
    expect(registry.lookupReadiness({ ...key, hostId: "host_2" })?.status).toBe(
      "not_installed",
    );
    registration.dispose();
    expect(registry.lookupReadiness(key)).toBeUndefined();
    expect(registry.lookupReadiness({ ...key, providerId: "pi" })?.status).toBe(
      "ready",
    );
  });
});
