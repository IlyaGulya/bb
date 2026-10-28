import { useEffect, useState } from "react";
import { experimental_ProviderModelPicker as ProviderModelPicker, experimental_PermissionModePicker as PermissionModePicker, type ExecutionContext, type ModelConnection } from "@get-bb/plugin-sdk/app";
import type { Preset } from "../../shared/contract.js";
import { EMPTY_WORKFLOW_ROLE, type WorkflowSelection } from "../../shared/workflow-preparation.js";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from "@/components/ui/command";
import { Icon } from "@/components/ui/icon";

export function WorkflowPicker({ label, value, options, onChange, dialogOpen, disabled = false }: {
  label: string; value: string | null; options: Array<{ value: string; label: string; disabled?: boolean }>; onChange: (value: string) => void; dialogOpen: boolean; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => { if (!dialogOpen) setOpen(false); }, [dialogOpen]);
  const selected = options.find(entry => entry.value === value);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><Button type="button" variant="outline" role="combobox" aria-label={label} aria-expanded={open} disabled={disabled} className="w-full justify-between font-normal">
      <span className="truncate">{selected?.label ?? (value ? "Selection unavailable — choose again" : `Choose ${label.toLowerCase()}`)}</span><Icon name="ChevronDown" className="size-4 shrink-0 opacity-50" />
    </Button></PopoverTrigger>
    <PopoverContent align="start" className="w-80 max-w-full p-0"><Command><CommandInput aria-label={`Search ${label.toLowerCase()}`} placeholder={`Search ${label.toLowerCase()}…`} /><CommandList><CommandEmpty>No matching choices. Check project and machine configuration.</CommandEmpty><CommandGroup>
      {options.map(option => <CommandItem key={option.value} value={option.value} keywords={[option.label]} disabled={option.disabled} onSelect={() => { onChange(option.value); setOpen(false); }}><span className="min-w-0 flex-1 whitespace-normal break-words">{option.label}</span>{value === option.value && <Icon name="Check" className="size-4 shrink-0" />}</CommandItem>)}
    </CommandGroup></CommandList></Command></PopoverContent>
  </Popover>;
}

type Role = NonNullable<WorkflowSelection["writer"]>;
export function WorkflowRoleFields({ label, role, onChange, profiles, contexts, connections, hostId, projectId, open, disabled, error }: {
  label: string; role: Role | null; onChange: (value: Role) => void; profiles: Preset[]; contexts: ExecutionContext[]; connections: ModelConnection[]; hostId: string | null; projectId: string | null; open: boolean; disabled: boolean; error?: string;
}) {
  const value = role ?? EMPTY_WORKFLOW_ROLE;
  const connection = connections.find(entry => entry.id === value.modelConnectionId);
  const context = contexts.find(entry => entry.id === value.executionContextId);
  const [expanded, setExpanded] = useState(!role?.model || !role.executionContextId || !role.modelConnectionId);
  const routing = hostId ? { kind: "host" as const, hostId } : undefined;
  const availableConnections = connections.map(entry => ({ value: entry.id, label: `${entry.name} · ${entry.provider}${entry.revoked ? " · revoked" : !entry.enabled ? " · disabled" : ""}`, disabled: entry.revoked || !entry.enabled || !!hostId && (entry.gateway ? !entry.gateway.allowedHostIds.includes(hostId) : entry.hostId !== hostId) }));
  return <fieldset disabled={disabled} className="min-w-0 space-y-3 border-t border-border pt-4">
    <legend className="px-0 pt-4 text-sm font-medium">{label}</legend>
    <details open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary className="cursor-pointer space-y-1 text-sm">
        <span className="font-medium">{value.model ? value.model.replace(/^bb-cpa\/[^/]+\//, "") : "Choose execution profile"}</span>
        <span className="ml-2 text-muted-foreground">{connection?.name ?? (value.modelConnectionId ? "Account unavailable" : "Choose account")} · {context?.name ?? (value.executionContextId ? "Context unavailable" : "Choose context")}</span>
      </summary>
      <div className="mt-3 space-y-3">
    {profiles.length > 0 && <WorkflowPicker label={`${label} profile`} value={null} options={profiles.map(profile => ({ value: profile.id, label: profile.name }))} dialogOpen={open} disabled={disabled} onChange={id => {
      const preset = profiles.find(entry => entry.id === id);
      if (preset) onChange({ provider: preset.providerId, model: preset.modelId, executionContextId: preset.executionContextId ?? "", modelConnectionId: preset.modelConnectionId ?? "", reasoningLevel: preset.reasoningLevel, permissionMode: preset.permissionMode, serviceTier: preset.serviceTier, instructions: preset.instructions });
    }} />}
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="min-w-0 space-y-1 text-sm"><span>Context</span><WorkflowPicker label={`${label} context`} value={value.executionContextId} options={contexts.map(entry => ({ value: entry.id, label: `${entry.name}${!entry.enabled ? " · disabled" : projectId && !entry.projectIds.includes(projectId) ? " · not in this project" : ""}`, disabled: !entry.enabled || !!projectId && !entry.projectIds.includes(projectId) }))} dialogOpen={open} disabled={disabled} onChange={id => onChange({ ...value, executionContextId: id })} /></label>
      <label className="min-w-0 space-y-1 text-sm"><span>Model account</span><WorkflowPicker label={`${label} account`} value={value.modelConnectionId} options={availableConnections} dialogOpen={open} disabled={disabled} onChange={id => {
        const account = connections.find(entry => entry.id === id);
        onChange({ ...value, modelConnectionId: id, provider: account?.provider ?? value.provider, model: account?.provider === value.provider ? value.model : "" });
      }} /></label>
    </div>
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <ProviderModelPicker value={{ providerId: value.provider, model: value.model, reasoningLevel: value.reasoningLevel, ...(value.serviceTier === null ? {} : { serviceTier: value.serviceTier }) }} onChange={picked => onChange({ ...value, provider: picked.providerId, model: picked.model, reasoningLevel: picked.reasoningLevel, serviceTier: picked.serviceTier ?? null })} {...(routing ? { routing } : {})} {...(connection ? { modelConnectionId: connection.id } : {})} className="max-w-full" />
      <PermissionModePicker providerId={value.provider} value={value.permissionMode} onChange={mode => onChange({ ...value, permissionMode: mode })} {...(routing ? { routing } : {})} className="max-w-full" />
    </div>
    <p className="break-words text-xs text-muted-foreground">{value.provider && value.model ? `${value.provider} · ${value.model.replace(/^bb-cpa\/[^/]+\//, "")} · ${value.reasoningLevel} · ${value.permissionMode}` : "Choose an account and an actual provider/model version."} Context never silently selects the payer.</p>
      </div>
    </details>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </fieldset>;
}
