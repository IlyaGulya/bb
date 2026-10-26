import { describe, expect, it } from "vitest";
import {
  assertAcpConnectionUnchanged,
  resolveAcpScopedOptions,
} from "./scoped-context.js";

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: "personal-omp",
    name: "Personal OMP",
    provider: "acp-omp",
    hostId: "native-host",
    enabled: true,
    revoked: false,
    nativeAuth: { configDir: null, profile: null, hostEnv: null },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function resolve(
  providerOptions?: Record<string, unknown>,
  env: Record<string, string> = {},
) {
  return resolveAcpScopedOptions({ providerOptions, dialectId: "omp", env });
}

describe("native ACP scoped options", () => {
  it("preserves legacy launches without selecting or copying an account", () => {
    expect(
      resolve(undefined, { OMP_AUTH_BROKER_TOKEN: "host-secret" }),
    ).toEqual({
      executionContext: null,
      modelConnection: null,
      env: {},
    });
  });

  it("allows independent connections to reference the same existing native source", () => {
    const work = resolve({ modelConnection: connection({ id: "work-omp" }) });
    const personal = resolve({ modelConnection: connection() });
    expect(work.env).toEqual({});
    expect(personal.env).toEqual({});
    expect(work.modelConnection?.id).toBe("work-omp");
    expect(personal.modelConnection?.id).toBe("personal-omp");
  });

  it("resolves broker host references without moving native profiles or mutating the host", () => {
    const hostEnv = {
      WORK_BROKER: "https://broker.example",
      WORK_TOKEN: "reference-value",
    };
    const result = resolve(
      {
        modelConnection: connection({
          nativeAuth: {
            configDir: null,
            profile: null,
            hostEnv: {
              brokerUrlEnv: "WORK_BROKER",
              brokerTokenEnv: "WORK_TOKEN",
            },
          },
        }),
      },
      hostEnv,
    );
    expect(result.env).toEqual({
      OMP_AUTH_BROKER_URL: "https://broker.example",
      OMP_AUTH_BROKER_TOKEN: "reference-value",
    });
    expect(hostEnv).toEqual({
      WORK_BROKER: "https://broker.example",
      WORK_TOKEN: "reference-value",
    });
    expect(result.modelConnection?.nativeAuth.hostEnv).toEqual({
      brokerUrlEnv: "WORK_BROKER",
      brokerTokenEnv: "WORK_TOKEN",
    });
  });

  it.each([
    {
      nativeAuth: {
        configDir: "/other-native-profile",
        profile: null,
        hostEnv: null,
      },
    },
    { nativeAuth: { configDir: null, profile: "personal", hostEnv: null } },
  ])(
    "refuses profile selection that would also replace context and session storage",
    (overrides) => {
      expect(() =>
        resolve({ modelConnection: connection(overrides) }),
      ).toThrow();
    },
  );

  it.each([{ enabled: false }, { revoked: true }])(
    "refuses unavailable native connections",
    (overrides) => {
      expect(() => resolve({ modelConnection: connection(overrides) })).toThrow(
        "disabled or revoked",
      );
    },
  );

  it("refuses missing explicit broker references rather than falling back to ambient login", () => {
    expect(() =>
      resolve(
        {
          modelConnection: connection({
            nativeAuth: {
              configDir: null,
              profile: null,
              hostEnv: {
                brokerUrlEnv: "MISSING_URL",
                brokerTokenEnv: "MISSING_TOKEN",
              },
            },
          }),
        },
        {
          OMP_AUTH_BROKER_URL: "https://ambient.example",
          OMP_AUTH_BROKER_TOKEN: "ambient",
        },
      ),
    ).toThrow("native login fallback is disabled");
  });

  it.each([
    "file:///local",
    "https://user:password@broker.example",
    "not-a-url",
  ])(
    "refuses an invalid native broker URL without exposing its value",
    (url) => {
      const run = () =>
        resolve(
          {
            modelConnection: connection({
              nativeAuth: {
                configDir: null,
                profile: null,
                hostEnv: {
                  brokerUrlEnv: "URL_REF",
                  brokerTokenEnv: "TOKEN_REF",
                },
              },
            }),
          },
          { URL_REF: url, TOKEN_REF: "secret" },
        );
      expect(run).toThrow("HTTP or HTTPS URL");
      try {
        run();
      } catch (error) {
        expect(String(error)).not.toContain(url);
        expect(String(error)).not.toContain("secret");
      }
    },
  );

  it.each([
    { executionContext: { id: "partial-context" } },
    { modelConnection: { id: "partial-connection" } },
  ])("rejects malformed snapshots at the ACP boundary", (options) => {
    expect(() => resolve(options)).toThrow("Invalid");
  });

  it("rejects provider/account mismatches", () => {
    expect(() =>
      resolve({ modelConnection: connection({ provider: "claude-code" }) }),
    ).toThrow("shipped acp-omp");
    expect(() =>
      resolveAcpScopedOptions({
        providerOptions: { modelConnection: connection() },
        dialectId: "opencode",
        env: {},
      }),
    ).toThrow("shipped acp-omp");
  });

  it("keeps active and resumed selections immutable", () => {
    const original = resolve({ modelConnection: connection() }).modelConnection;
    const same = resolve({ modelConnection: connection() }).modelConnection;
    expect(() => assertAcpConnectionUnchanged(original, same)).not.toThrow();
    expect(() => assertAcpConnectionUnchanged(original, null)).toThrow(
      "cannot change",
    );
    const changed = resolve({
      modelConnection: connection({ id: "other-account" }),
    }).modelConnection;
    expect(() => assertAcpConnectionUnchanged(original, changed)).toThrow(
      "cannot change",
    );
  });
});
