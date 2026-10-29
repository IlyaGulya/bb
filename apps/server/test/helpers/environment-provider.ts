import {
  providerOperations,
  type TestEnvironmentProviderContext,
  type TestProviderDecision,
} from "./provider-decisions.js";
import { gitBranchSelectionSchema } from "@bb/domain";
import type { PluginEnvironmentValidateDecision } from "@get-bb/plugin-sdk";
import type {
  PluginEnvironmentProviderAvailability,
  PluginEnvironmentProviderValidateContext,
} from "@get-bb/plugin-sdk/environment-provider";
import { expect, onTestFinished, vi } from "vitest";
import {
  validatePluginEnvironmentProviderDeclaration,
  type NormalizedPluginEnvironmentProvider,
} from "@get-bb/plugin-sdk/internal/host-policy";
import { z } from "zod";
import {
  setPluginEnvironmentProviderBridge,
  type PluginEnvironmentProviderRecord,
} from "../../src/services/plugins/plugin-environment-provider-registry.js";
import { DEFAULT_ENVIRONMENT_PROVIDER_ID } from "../../src/services/environments/environment-provider-ids.js";
import { invokePluginInline } from "../../src/services/plugins/plugin-hook-registry.js";
import { clearAllThreadProvisionSchedules } from "../../src/services/threads/thread-startup-store.js";

export interface FakeEnvironmentProvider {
  contexts: TestEnvironmentProviderContext[];
  waitForProvision(): Promise<TestEnvironmentProviderContext>;
}

export interface InstallFakeEnvironmentProviderArgs {
  id: string;
  pluginId: string;
  displayName: string;
  requires: NormalizedPluginEnvironmentProvider["requires"];
  inputs?: z.ZodType;
  validate?: (
    context: PluginEnvironmentProviderValidateContext,
  ) => PluginEnvironmentValidateDecision;
  availability?: () => PluginEnvironmentProviderAvailability;
  decide: (context: TestEnvironmentProviderContext) => TestProviderDecision;
}

export const worktreeProviderInputsSchema = z.object({
  branch: gitBranchSelectionSchema,
});


export function installFakeEnvironmentProvider(
  args: InstallFakeEnvironmentProviderArgs,
): FakeEnvironmentProvider {
  const contexts: TestEnvironmentProviderContext[] = [];
  const normalized = validatePluginEnvironmentProviderDeclaration({
    id: args.id,
    displayName: args.displayName,
    description: "Prepare a workspace for this thread.",
    icon: "Folder",
    requires: args.requires,
    ...(args.inputs === undefined ? {} : { inputs: args.inputs }),
    ...(args.validate === undefined ? {} : { validate: args.validate }),
    ...(args.availability === undefined
      ? {}
      : { availability: args.availability }),
    ...providerOperations((context) => {
      contexts.push(context);
      return args.decide(context);
    }),
  });
  const record: PluginEnvironmentProviderRecord = {
    pluginId: args.pluginId,
    provider: normalized,
  };
  setPluginEnvironmentProviderBridge({
    listEnvironmentProviders: () => [record],
    getEnvironmentProvider: (id) => (id === args.id ? record : undefined),
    invokeProvider: (_pluginId, _label, run) => invokePluginInline(run),
    decisionTimeoutMs: 10_000,
  });
  onTestFinished(() => {
    clearAllThreadProvisionSchedules();
    setPluginEnvironmentProviderBridge(undefined);
  });

  return {
    contexts,
    async waitForProvision() {
      await vi.waitFor(() => {
        expect(contexts.length).toBeGreaterThan(0);
      });
      const context = contexts[0];
      if (context === undefined) {
        throw new Error(`Expected the ${args.id} provider to be asked`);
      }
      return context;
    },
  };
}

export function installFakeGitWorktreeProvider(
  decide: (
    context: TestEnvironmentProviderContext,
  ) => TestProviderDecision = () => ({
    action: "wait",
    reason: "Creating worktree…",
  }),
): FakeEnvironmentProvider {
  return installFakeEnvironmentProvider({
    id: DEFAULT_ENVIRONMENT_PROVIDER_ID.gitWorktree,
    pluginId: "environment-git-worktree",
    displayName: "Worktree",
    requires: {
      projectCheckout: true,
      gitCheckout: true,
      gitRemote: false,
      projectless: false,
    },
    inputs: worktreeProviderInputsSchema,
    decide,
  });
}

export function installFakePersonalWorkspaceProvider(
  decide: (
    context: TestEnvironmentProviderContext,
  ) => TestProviderDecision = () => ({
    action: "wait",
    reason: "Preparing personal workspace",
  }),
): FakeEnvironmentProvider {
  return installFakeEnvironmentProvider({
    id: DEFAULT_ENVIRONMENT_PROVIDER_ID.personalWorkspace,
    pluginId: "environment-personal-workspace",
    displayName: "Personal workspace",
    requires: {
      projectCheckout: false,
      gitCheckout: false,
      gitRemote: false,
      projectless: true,
    },
    decide,
  });
}
