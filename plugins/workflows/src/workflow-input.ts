import type { BbPluginApi, PluginProvidersState } from "@get-bb/plugin-sdk";
import { requireWorkflowProviderReadiness } from "./provider-readiness.js";
import {
  resolveWorkflowSource,
  type ResolvedWorkflowSource,
  type WorkflowSourceContext,
  type WorkflowSourceInput,
} from "./source-resolution.js";
import {
  validateWorkflowSource,
  type WorkflowValidationSummary,
} from "./workflow-validation.js";

interface PreparedWorkflowSource extends ResolvedWorkflowSource {
  validation: WorkflowValidationSummary;
}

export async function prepareWorkflowSource(
  bb: BbPluginApi,
  context: WorkflowSourceContext,
  input: WorkflowSourceInput,
): Promise<PreparedWorkflowSource> {
  const resolved = await resolveWorkflowSource(input, context, {
    async getThreadEnvironmentId(threadId) {
      const thread = await bb.sdk.threads.get({ threadId });
      return thread.environmentId;
    },
    async getEnvironment(environmentId) {
      const environment = await bb.sdk.environments.get({ environmentId });
      return {
        id: environment.id,
        projectId: environment.projectId,
        hostId: environment.hostId,
        path: environment.path,
      };
    },
    readFile(input) {
      return bb.sdk.files.read(input);
    },
  });
  const providersById = new Map<
    string,
    PluginProvidersState["providers"][number]
  >();
  const validation = await validateWorkflowSource(
    resolved.source,
    resolved.environmentId,
    {
      async listProviders(environmentId) {
        const providers = await bb.sdk.providers.list({ environmentId });
        for (const provider of providers)
          providersById.set(provider.id, provider);
        return providers;
      },
      async loadModels(environmentId, providerId) {
        const provider = providersById.get(providerId);
        if (provider === undefined)
          throw new Error(`Provider ${providerId} is not registered.`);
        await requireWorkflowProviderReadiness(bb, environmentId, provider);
        return bb.sdk.providers.models({ environmentId, providerId });
      },
    },
  );
  return { ...resolved, validation };
}
