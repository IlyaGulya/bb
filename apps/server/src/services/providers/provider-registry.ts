import type {
  ProviderNativeRoots,
  AvailableModel,
  ExtensionKind,
  JsonValue,
  PermissionMode,
  ProviderFork,
  ProviderInfo,
  ReasoningLevel,
} from "@bb/domain";
import { parseExtensionKind } from "@bb/domain";
import type {
  PluginProviderExtensionKindDeclaration,
  PluginProviderOptionsContext,
} from "@get-bb/plugin-sdk";
import { providerAlreadyRegisteredMessage } from "@get-bb/plugin-sdk/internal/host-policy";

import {
  createProviderReadinessCache,
  type ProviderReadinessCache,
} from "./provider-readiness.js";

export interface ProviderServerCapabilities {
  reasoningLevels: readonly ReasoningLevel[];
  fork: ProviderFork;
  supportsManualCompaction: boolean;
}

export interface ProviderInstallRank {
  bundledIndex: number | null;
  installedAt: number;
}

export type ProviderExtensionKindSchemas = Readonly<
  Record<string, PluginProviderExtensionKindDeclaration>
>;

export interface ProviderRegistration {
  info: ProviderInfo;
  serverCapabilities: ProviderServerCapabilities;
  bridgeOptions: Readonly<Record<string, JsonValue>>;
  extensionKinds: ProviderExtensionKindSchemas;
  visibility: "always" | "installed";
  pluginId: string;
  fallbackModels: readonly AvailableModel[];
  envPassthrough: readonly string[];
  nativeSkillRoots: ProviderNativeRoots;
  nativeCommandRoots: ProviderNativeRoots;
  resolvesNativeRoots: boolean;
  deriveProviderOptions: (
    context: Omit<PluginProviderOptionsContext, "settings">,
  ) => Readonly<Record<string, JsonValue>>;
  icon?: { bytes: Uint8Array; contentType: string; hash: string };
  iconNames: ReadonlySet<string>;
}

export interface ProviderRegistryService extends ProviderReadinessCache {
  list(): ProviderRegistration[];
  disabledProviderIds(): ReadonlySet<string>;
  getUserDefaultProviderId(): string | null;
  get(providerId: string): ProviderRegistration | null;
  getRegistrationRevision(): number;
  getServerCapabilities(providerId: string): ProviderServerCapabilities | null;
  getSupportedPermissionModes(
    providerId: string,
  ): readonly PermissionMode[] | null;
  supportsFork(providerId: string): boolean;
  supportsSessionRewind(providerId: string): boolean;
  supportsManualCompaction(providerId: string): boolean;
  getExtensionKindSchemas(
    kind: ExtensionKind,
  ): PluginProviderExtensionKindDeclaration | null;
  register(
    registration: ProviderRegistration & {
      installRank?: ProviderInstallRank;
    },
  ): { dispose(): void };
  whenProviderRegistered(providerId: string): Promise<void>;
  whenRegistrationsSettled(): Promise<void>;
  markRegistrationsSettled(): void;
}

const REGISTRATIONS_SETTLED_TIMEOUT_MS = 30_000;

interface ProviderRegistryDeps {
  readUserProviderPreferences?: () => {
    providerOrder: readonly string[];
    defaultProviderId: string | null;
    disabledProviderIds?: readonly string[];
  };
  deferRegistrationsSettled?: boolean;
}

export function createProviderRegistryService(
  deps: ProviderRegistryDeps = {},
): ProviderRegistryService {
  const pluginRegistrations = new Map<string, ProviderRegistration>();
  const registrationRanks = new Map<
    ProviderRegistration,
    { installRank: ProviderInstallRank | null; sequence: number }
  >();
  const providerRegistrationWaiters = new Map<string, Set<() => void>>();
  let registrationRevision = 0;
  const readiness = createProviderReadinessCache();
  let registrationSequence = 0;

  function compareInstallRank(
    a: ProviderRegistration,
    b: ProviderRegistration,
  ): number {
    const rankA = registrationRanks.get(a);
    const rankB = registrationRanks.get(b);
    const installA = rankA?.installRank ?? null;
    const installB = rankB?.installRank ?? null;
    if (installA !== null || installB !== null) {
      if (installA === null) return 1;
      if (installB === null) return -1;
      const bundledA = installA.bundledIndex;
      const bundledB = installB.bundledIndex;
      if (bundledA !== null || bundledB !== null) {
        if (bundledA === null) return 1;
        if (bundledB === null) return -1;
        if (bundledA !== bundledB) return bundledA - bundledB;
      } else if (installA.installedAt !== installB.installedAt) {
        return installA.installedAt - installB.installedAt;
      }
    }
    return (rankA?.sequence ?? 0) - (rankB?.sequence ?? 0);
  }
  let settle: (() => void) | null = null;
  const settled: Promise<void> =
    deps.deferRegistrationsSettled === true
      ? new Promise<void>((resolve) => {
          settle = resolve;
        })
      : Promise.resolve();

  function getRegistration(providerId: string): ProviderRegistration | null {
    return pluginRegistrations.get(providerId) ?? null;
  }

  function releaseProviderRegistrationWaiters(providerId: string): void {
    const waiters = providerRegistrationWaiters.get(providerId);
    if (waiters === undefined) return;
    providerRegistrationWaiters.delete(providerId);
    for (const resolve of waiters) resolve();
  }

  function releaseAllProviderRegistrationWaiters(): void {
    for (const waiters of providerRegistrationWaiters.values()) {
      for (const resolve of waiters) resolve();
    }
    providerRegistrationWaiters.clear();
  }

  async function waitUntilSettledOrTimeout(
    readiness: Promise<void>,
  ): Promise<void> {
    if (settle === null) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      readiness,
      settled,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, REGISTRATIONS_SETTLED_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
  }

  const service: ProviderRegistryService = {
    ...readiness,
    disabledProviderIds() {
      return new Set(
        deps.readUserProviderPreferences?.().disabledProviderIds ?? [],
      );
    },
    list() {
      const entries = [...pluginRegistrations.values()].sort(
        compareInstallRank,
      );
      const userOrder =
        deps.readUserProviderPreferences?.().providerOrder ?? [];
      if (userOrder.length === 0) {
        return entries;
      }
      const pinned = (entry: ProviderRegistration): number => {
        const index = userOrder.indexOf(entry.info.id);
        return index === -1 ? userOrder.length : index;
      };
      return entries.sort((a, b) => pinned(a) - pinned(b));
    },

    getUserDefaultProviderId() {
      const preferences = deps.readUserProviderPreferences?.();
      const preferred = preferences?.defaultProviderId ?? null;
      if (
        preferred === null ||
        !pluginRegistrations.has(preferred) ||
        preferences?.disabledProviderIds?.includes(preferred) === true
      ) {
        return null;
      }
      return preferred;
    },

    get(providerId) {
      return getRegistration(providerId);
    },

    getRegistrationRevision() {
      return registrationRevision;
    },

    getServerCapabilities(providerId) {
      return getRegistration(providerId)?.serverCapabilities ?? null;
    },

    getSupportedPermissionModes(providerId) {
      return (
        getRegistration(providerId)?.info.capabilities.permissionModes ?? null
      );
    },

    supportsFork(providerId) {
      return (
        getRegistration(providerId)?.info.capabilities.supportsFork ?? false
      );
    },

    supportsSessionRewind(providerId) {
      return (
        getRegistration(providerId)?.info.capabilities.supportsSessionRewind ??
        false
      );
    },

    supportsManualCompaction(providerId) {
      return (
        getRegistration(providerId)?.serverCapabilities
          .supportsManualCompaction ?? false
      );
    },

    getExtensionKindSchemas(kind) {
      const { pluginId, name } = parseExtensionKind(kind);
      for (const registration of pluginRegistrations.values()) {
        if (registration.pluginId !== pluginId) {
          continue;
        }
        const declared = registration.extensionKinds[name];
        if (declared !== undefined) {
          return declared;
        }
      }
      return null;
    },

    register(registration) {
      const providerId = registration.info.id;
      if (pluginRegistrations.has(providerId)) {
        throw new Error(providerAlreadyRegisteredMessage(providerId));
      }
      const { installRank, ...entry } = registration;
      pluginRegistrations.set(providerId, entry);
      registrationSequence += 1;
      registrationRanks.set(entry, {
        installRank: installRank ?? null,
        sequence: registrationSequence,
      });
      registrationRevision += 1;
      readiness.invalidateReadiness({ providerId });
      releaseProviderRegistrationWaiters(providerId);
      return {
        dispose() {
          if (pluginRegistrations.get(providerId) === entry) {
            pluginRegistrations.delete(providerId);
            registrationRanks.delete(entry);
            registrationRevision += 1;
            readiness.invalidateReadiness({ providerId });
          }
        },
      };
    },

    async whenProviderRegistered(providerId) {
      if (pluginRegistrations.has(providerId) || settle === null) {
        return;
      }
      let release!: () => void;
      const registered = new Promise<void>((resolve) => {
        release = resolve;
      });
      const waiters = providerRegistrationWaiters.get(providerId) ?? new Set();
      waiters.add(release);
      providerRegistrationWaiters.set(providerId, waiters);
      try {
        await waitUntilSettledOrTimeout(registered);
      } finally {
        const currentWaiters = providerRegistrationWaiters.get(providerId);
        currentWaiters?.delete(release);
        if (currentWaiters?.size === 0) {
          providerRegistrationWaiters.delete(providerId);
        }
      }
    },

    async whenRegistrationsSettled() {
      await waitUntilSettledOrTimeout(settled);
    },

    markRegistrationsSettled() {
      settle?.();
      settle = null;
      releaseAllProviderRegistrationWaiters();
    },
  };
  return service;
}
