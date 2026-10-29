import type { BbPluginApi, PluginProviderPermissionMode } from "@get-bb/plugin-sdk";

export async function validateTaskExecutionSelection(bb: BbPluginApi, input: {
  projectId: string; hostId: string; provider: string; model: string; reasoningLevel: string;
  executionContextId: string; modelConnectionId: string; permissionMode: PluginProviderPermissionMode;
}, inspectCatalog: boolean) {
  const [hosts, contexts, connections, project, providers] = await Promise.all([
    bb.sdk.hosts.list(), bb.sdk.experimental_executionContexts.list(),
    bb.sdk.experimental_modelConnections.list(), bb.sdk.projects.get({ projectId: input.projectId }),
    bb.sdk.providers.list({ hostId: input.hostId, providerId: input.provider }),
  ]);
  const host = hosts.find(entry => entry.id === input.hostId);
  if (!host) throw new Error("Machine: selected machine is no longer enrolled");
  if (host.status !== "connected") throw new Error("Machine: reconnect the selected execution host before applying routing choices");
  if (!project.sources.some(source => source.hostId === input.hostId)) throw new Error("Code project has no prepared source on the selected machine");
  const context = contexts.find(entry => entry.id === input.executionContextId);
  if (!context?.enabled || !context.projectIds.includes(input.projectId)) throw new Error("Context is unavailable or does not include this code project");
  const connection = connections.find(entry => entry.id === input.modelConnectionId);
  if (!connection?.enabled || connection.revoked || connection.provider !== input.provider || (connection.gateway ? !connection.gateway.allowedHostIds.includes(input.hostId) : connection.hostId !== input.hostId)) throw new Error("Account is missing, revoked, disabled or incompatible with the selected provider/machine; choose an account explicitly");
  const provider = providers.find(entry => entry.id === input.provider);
  if (!provider?.available || !provider.capabilities.permissionModes.includes(input.permissionMode)) throw new Error("Selected runtime or permission mode is unavailable on this machine; no provider fallback was selected");
  if (inspectCatalog) {
    const catalog = await bb.sdk.providers.models({ hostId: input.hostId, projectId: input.projectId, providerId: input.provider, modelConnectionId: connection.id });
    if (catalog.modelLoadError) throw new Error(`Selected account model catalog is unavailable (${catalog.modelLoadError.code})`);
    const model = [...catalog.models, ...catalog.selectedOnlyModels].find(entry => entry.model === input.model || entry.id === input.model);
    if (!model) throw new Error("Selected model is no longer offered by this account");
    if (!model.supportedReasoningEfforts.some(entry => entry.reasoningEffort === input.reasoningLevel)) throw new Error("Selected reasoning level is unavailable");
  }
  return `${project.name} · ${host.name} · ${context.name} · ${connection.name} · ${input.provider}/${input.model}${inspectCatalog ? "" : " · registry selection only; native readiness and live model availability are not proven"}`;
}
