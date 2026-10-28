import type { Task } from "../shared/contract.js";
import { Icon } from "@/components/ui/icon";

export function ParentBadge({
  parent,
  onOpen,
}: {
  parent: Task;
  onOpen: (taskKey: string) => void;
}) {
  const label = `${parent.key} · ${parent.title}`;
  return (
    <button
      type="button"
      title={label}
      aria-label={`Open parent ${label}`}
      className="relative flex max-w-48 shrink-0 touch-manipulation items-center gap-1 rounded-md border border-border bg-card px-1.5 py-1 text-xs text-muted-foreground hover:border-input hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-md:min-h-11 max-md:max-w-full max-md:shrink"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(parent.key);
      }}
    >
      <Icon name="GitBranch" className="size-3 shrink-0" />
      <span className="min-w-0 whitespace-normal break-words md:truncate">{label}</span>
    </button>
  );
}
