import { useState } from "react";
import { experimental_ProviderModelPicker as ProviderModelPicker, experimental_PermissionModePicker as PermissionModePicker, type ExecutionContext, type ModelConnection } from "@get-bb/plugin-sdk/app";
import type { Preset } from "../../shared/contract.js";
import { EMPTY_WORKFLOW_ROLE, type WorkflowSelection } from "../../shared/workflow-preparation.js";
import { ExecutionPicker } from "../execution-picker.js";
import { contextUnavailable, connectionUnavailable } from "../execution-selection.js";

type Role = NonNullable<WorkflowSelection["writer"]>;
export function WorkflowRoleFields({ label, role, onChange, profiles, contexts, connections, hostId, projectId, open, disabled, error }: {
  label: string; role: Role | null; onChange: (value: Role) => void; profiles: Preset[]; contexts: ExecutionContext[]; connections: ModelConnection[]; hostId: string | null; projectId: string | null; open: boolean; disabled: boolean; error?: string;
}) {
  const value = role ?? EMPTY_WORKFLOW_ROLE;
  const connection = connections.find(entry => entry.id === value.modelConnectionId);
  const context = contexts.find(entry => entry.id === value.executionContextId);
  const [expanded, setExpanded] = useState(!role?.model || !role.executionContextId || !role.modelConnectionId);
  const routing = hostId ? { kind: "host" as const, hostId } : undefined;
  const availableConnections = connections.map(entry => {
    const reason = connectionUnavailable(entry, undefined, hostId ?? undefined);
    return { value: entry.id, label: `${entry.name}${entry.gateway ? ` · CPA account: ${entry.gateway.accountPrefix}` : " · native login"}${reason ? ` · ${reason}` : ""}`, disabled: !!reason };
  });
  const unavailable = value.executionContextId && (!context || contextUnavailable(context, projectId ?? undefined))
    ? "The selected context is unavailable for this project. Its selection is retained."
    : value.modelConnectionId && (!connection || connectionUnavailable(connection, value.provider, hostId ?? undefined))
      ? "The selected model account is unavailable on this machine/provider. Its selection is retained."
      : null;
  return <fieldset disabled={disabled} className="min-w-0 space-y-3 border-t border-border pt-4">
    <legend className="px-0 pt-4 text-sm font-medium">{label}</legend>
    <details open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary className="cursor-pointer space-y-1 py-3 text-sm">
        <span className="font-medium">{value.model ? value.model.replace(/^bb-cpa\/[^/]+\//, "") : "Choose execution profile"}</span>
        <span className="ml-2 text-muted-foreground">{connection?.name ?? (value.modelConnectionId ? "Account unavailable" : "Choose account")} · {context?.name ?? (value.executionContextId ? "Context unavailable" : "Choose context")}</span>
      </summary>
      <div className="mt-3 space-y-3">
    {profiles.length > 0 && <ExecutionPicker label={`${label} profile`} value={null} options={profiles.map(profile => ({ value: profile.id, label: profile.name }))} dialogOpen={open} disabled={disabled} onChange={id => {
      const preset = profiles.find(entry => entry.id === id);
      if (preset) onChange({ provider: preset.providerId, model: preset.modelId, executionContextId: preset.executionContextId ?? "", modelConnectionId: preset.modelConnectionId ?? "", reasoningLevel: preset.reasoningLevel, permissionMode: preset.permissionMode, serviceTier: preset.serviceTier, instructions: preset.instructions });
    }} />}
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="min-w-0 space-y-1 text-sm"><span>Context</span><ExecutionPicker label={`${label} context`} value={value.executionContextId} options={contexts.map(entry => ({ value: entry.id, label: `${entry.name}${!entry.enabled ? " · disabled" : projectId && !entry.projectIds.includes(projectId) ? " · not in this project" : ""}`, disabled: !entry.enabled || !!projectId && !entry.projectIds.includes(projectId) }))} dialogOpen={open} disabled={disabled} onChange={id => onChange({ ...value, executionContextId: id })} /></label>
      <label className="min-w-0 space-y-1 text-sm"><span>Model account</span><ExecutionPicker label={`${label} account`} value={value.modelConnectionId} options={availableConnections} dialogOpen={open} disabled={disabled} onChange={id => {
        const account = connections.find(entry => entry.id === id);
        onChange({ ...value, modelConnectionId: id, provider: account?.provider ?? value.provider, model: account?.provider === value.provider ? value.model : "" });
      }} /></label>
    </div>
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <ProviderModelPicker value={{ providerId: value.provider, model: value.model, reasoningLevel: value.reasoningLevel, ...(value.serviceTier === null ? {} : { serviceTier: value.serviceTier }) }} onChange={picked => onChange({ ...value, provider: picked.providerId, model: picked.model, reasoningLevel: picked.reasoningLevel, serviceTier: picked.serviceTier ?? null })} {...(routing ? { routing } : {})} {...(value.modelConnectionId ? { modelConnectionId: value.modelConnectionId } : {})} allowProviderChange={!value.modelConnectionId} disabled={disabled || !hostId || !connection || connection.revoked || !connection.enabled} className="max-w-full" />
      <PermissionModePicker providerId={value.provider} value={value.permissionMode} onChange={mode => onChange({ ...value, permissionMode: mode })} {...(routing ? { routing } : {})} className="max-w-full" />
    </div>
    <p className="break-words text-xs text-muted-foreground">{value.provider && value.model ? `Model: ${value.model.replace(/^bb-cpa\/[^/]+\//, "")} · ${value.reasoningLevel} · ${value.permissionMode}` : "Choose an account and an actual provider/model version."} Context never silently selects the payer.</p>
      </div>
    </details>
    {unavailable && <p role="status" className="text-sm text-warning-text">{unavailable} Choose an available entry; no fallback is used.</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </fieldset>;
}
