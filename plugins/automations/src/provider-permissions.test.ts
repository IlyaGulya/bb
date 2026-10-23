import type {
  PluginProvidersState,
  ProviderReadiness,
} from "@get-bb/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { resolvePermissionMode } from "./provider-permissions.js";

const provider: PluginProvidersState["providers"][number] = {
  id: "acp-omp",
  pluginId: "provider-acp",
  displayName: "OMP",
  logoUrl: null,
  available: true,
  composerActions: [],
  completedTurnDisplay: "collapse",
  maintenance: { health: true, usage: false, installation: false },
  capabilities: {
    supportsThreadArchive: false,
    supportsThreadRename: false,
    supportsServiceTier: false,
    supportsNativeUserQuestion: false,
    supportsFork: false,
    supportsSessionRewind: false,
    modelCatalogScope: "workspace",
    permissionModes: ["full"],
  },
};

function api(readiness: ProviderReadiness, selected = provider) {
  return {
    sdk: {
      providers: { list: vi.fn(async () => [selected]) },
      system: {
        providerStates: vi.fn(async () => ({
          providers: [
            {
              providerId: selected.id,
              displayName: selected.displayName,
              status: "unknown" as const,
              statusMessage: null,
              accountEmail: null,
              planLabel: null,
              installedVersion: null,
              minimumSupportedVersion: null,
              canInstall: false,
              canUpdate: false,
              loginCommand: null,
              localLoginCommand: null,
              readiness,
            },
          ],
        })),
      },
    },
  };
}

const ready: ProviderReadiness = {
  verification: "required",
  scope: "host",
  status: "ready",
  freshness: "fresh",
  checkedAt: 123,
  retryAfterMs: null,
  detail: "Ready",
};

describe("automation provider readiness", () => {
  it.each([
    "initializing",
    "unknown",
    "not_installed",
    "auth_required",
    "disabled",
    "unsupported_version",
  ] as const)(
    "blocks %s before choosing permission defaults",
    async (status) => {
      const bb = api({
        ...ready,
        status,
        detail: "Check the selected provider.",
      });
      await expect(
        resolvePermissionMode(bb, provider.id, undefined, {
          hostId: "host-one",
        }),
      ).rejects.toThrow(status.replaceAll("_", " "));
      expect(bb.sdk.system.providerStates).toHaveBeenCalledWith({
        hostId: "host-one",
        providerId: provider.id,
      });
    },
  );

  it("rejects stale success and host-only success for an environment", async () => {
    await expect(
      resolvePermissionMode(
        api({ ...ready, freshness: "stale" }),
        provider.id,
        "full",
      ),
    ).rejects.toThrow("stale");
    await expect(
      resolvePermissionMode(api(ready), provider.id, "full", {
        environmentId: "env-one",
      }),
    ).rejects.toThrow("not been verified");
    await expect(
      resolvePermissionMode(
        api({ ...ready, scope: "environment" }),
        provider.id,
        "full",
        { environmentId: "env-one" },
      ),
    ).resolves.toBe("full");
  });

  it("does not require an invented readiness observation from an unsupported provider", async () => {
    const readiness: ProviderReadiness = {
      ...ready,
      verification: "unsupported",
      status: "unknown",
      freshness: "unverified",
      checkedAt: null,
    };
    const bb = api(readiness, {
      ...provider,
      readiness,
      maintenance: { ...provider.maintenance, health: false },
    });
    await expect(resolvePermissionMode(bb, provider.id, "full")).resolves.toBe(
      "full",
    );
    expect(bb.sdk.system.providerStates).not.toHaveBeenCalled();
  });
});
