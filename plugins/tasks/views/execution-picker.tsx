import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from "@/components/ui/command";
import { Icon } from "@/components/ui/icon";

export function ExecutionPicker({ label, value, options, onChange, dialogOpen, disabled = false }: {
  label: string;
  value: string | null;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  onChange: (value: string) => void;
  dialogOpen: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => { if (!dialogOpen) setOpen(false); }, [dialogOpen]);
  const selected = options.find(entry => entry.value === value);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <Button type="button" variant="outline" role="combobox" aria-label={label} aria-expanded={open} disabled={disabled} className="h-auto min-h-11 w-full justify-between py-2 text-left font-normal sm:min-h-9">
        <span className="min-w-0 whitespace-normal break-words">{selected?.label ?? (value ? "Saved selection unavailable — choose again" : `Choose ${label.toLowerCase()}`)}</span>
        <Icon name="ChevronDown" className="size-4 shrink-0 opacity-50" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" className="w-80 max-w-full p-0">
      <Command>
        <CommandInput aria-label={`Search ${label.toLowerCase()}`} placeholder={`Search ${label.toLowerCase()}…`} />
        <CommandList>
          <CommandEmpty>No matching choices. Check project and machine configuration.</CommandEmpty>
          <CommandGroup>
            {options.map(option => <CommandItem key={option.value} value={option.value || "inherit"} keywords={[option.label]} disabled={option.disabled} onSelect={() => { onChange(option.value); setOpen(false); }} className="min-h-11 sm:min-h-9">
              <span className="min-w-0 flex-1 whitespace-normal break-words">{option.label}</span>
              {value === option.value && <Icon name="Check" className="size-4 shrink-0" />}
            </CommandItem>)}
          </CommandGroup>
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>;
}
