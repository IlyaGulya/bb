import { describe, expect, it } from "vitest";
import {
  providerInfoSchema,
  providerExecutionReadinessBlocker,
  type ProviderReadiness,
} from "../src/provider-types.js";

describe("provider info schema", () => {
  const baseProviderInfo = {
    id: "codex",
    pluginId: "provider-codex",
    displayName: "Codex",
    logoUrl: null,
    maintenance: { health: true, usage: true, installation: false },
    capabilities: {
      supportsThreadArchive: true,
      supportsThreadRename: true,
      supportsServiceTier: true,
      supportsNativeUserQuestion: false,
      supportsFork: true,
      supportsSessionRewind: true,
      modelCatalogScope: "workspace",
      permissionModes: ["accept-edits", "auto", "full"],
    },
    completedTurnDisplay: "collapse",
    available: true,
  };

  it.each([
    ["initializing", "unverified"],
    ["unknown", "unverified"],
    ["ready", "stale"],
    ["not_installed", "fresh"],
    ["disabled", "fresh"],
    ["auth_required", "fresh"],
    ["unsupported_version", "fresh"],
  ] as const)(
    "blocks %s/%s without choosing a different provider",
    (status, freshness) => {
      const provider = providerInfoSchema.parse({
        ...baseProviderInfo,
        composerActions: [],
      });
      const observation: ProviderReadiness = {
        verification: "required",
        scope: "host",
        status,
        freshness,
        checkedAt: freshness === "unverified" ? null : 123,
        retryAfterMs: 5_000,
        detail: "Check the selected provider.",
      };
      expect(
        providerExecutionReadinessBlocker(provider, observation, "host"),
      ).toContain(status.replaceAll("_", " "));
    },
  );

  it("does not promote host installation health to an environment auth check", () => {
    const provider = providerInfoSchema.parse({
      ...baseProviderInfo,
      composerActions: [],
    });
    const observation: ProviderReadiness = {
      verification: "required",
      scope: "host",
      status: "ready",
      freshness: "fresh",
      checkedAt: 123,
      retryAfterMs: null,
      detail: "Ready",
    };
    expect(
      providerExecutionReadinessBlocker(provider, observation, "host"),
    ).toBeNull();
    expect(
      providerExecutionReadinessBlocker(provider, observation, "environment"),
    ).toContain("not been verified");
  });

  it("keeps unsupported maintenance orthogonal to registration availability and explicit disabling", () => {
    const readiness: ProviderReadiness = {
      verification: "unsupported",
      scope: "host",
      status: "unknown",
      freshness: "unverified",
      checkedAt: null,
      retryAfterMs: null,
      detail: "No health maintenance.",
    };
    const provider = providerInfoSchema.parse({
      ...baseProviderInfo,
      composerActions: [],
      readiness,
    });
    expect(
      providerExecutionReadinessBlocker(provider, null, "environment"),
    ).toBeNull();
    expect(provider.readiness?.status).toBe("unknown");
    expect(
      providerExecutionReadinessBlocker(
        { ...provider, available: false },
        null,
        "host",
      ),
    ).toContain("plugin is unavailable");
    expect(
      providerExecutionReadinessBlocker(
        {
          ...provider,
          readiness: {
            ...readiness,
            status: "disabled",
            detail: "Enable provider.",
          },
        },
        null,
        "host",
      ),
    ).toBe("Enable provider.");
  });

  it("requires provider-declared composer actions", () => {
    expect(() => providerInfoSchema.parse(baseProviderInfo)).toThrow();
  });

  it("accepts each composer action kind", () => {
    expect(
      providerInfoSchema.parse({
        ...baseProviderInfo,
        composerActions: [
          { kind: "skills", trigger: "/" },
          {
            kind: "plan",
            command: { trigger: "/", name: "plan", trailingText: " " },
          },
          {
            kind: "goal",
            command: { trigger: "/", name: "goal", trailingText: " " },
          },
        ],
      }).composerActions,
    ).toEqual([
      { kind: "skills", trigger: "/" },
      {
        kind: "plan",
        command: { trigger: "/", name: "plan", trailingText: " " },
      },
      {
        kind: "goal",
        command: { trigger: "/", name: "goal", trailingText: " " },
      },
    ]);
  });

  it("accepts the explicit skill trigger", () => {
    expect(
      providerInfoSchema.parse({
        ...baseProviderInfo,
        composerActions: [{ kind: "skills", trigger: "$" }],
      }).composerActions,
    ).toEqual([{ kind: "skills", trigger: "$" }]);
  });

  it("validates action-specific fields", () => {
    expect(() =>
      providerInfoSchema.parse({
        ...baseProviderInfo,
        composerActions: [
          {
            kind: "plan",
            command: { trigger: "/", name: "", trailingText: " " },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      providerInfoSchema.parse({
        ...baseProviderInfo,
        composerActions: [
          {
            kind: "goal",
            command: { trigger: "/", name: "goal now", trailingText: " " },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      providerInfoSchema.parse({
        ...baseProviderInfo,
        composerActions: [
          {
            kind: "goal",
            command: { trigger: "/", name: "goal", trailingText: " now" },
          },
        ],
      }),
    ).toThrow();
  });
});
