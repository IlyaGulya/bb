import type { ReactNode } from "react";
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type TaskPriority,
  type TaskStatus,
  type Task,
} from "../../shared/contract.js";
import { TASK_SORTS, type TaskSort } from "../../shared/pagination.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { PriorityIcon, StatusIcon } from "./icons.js";
import {
  PRIORITY_LABELS,
  SORT_LABELS,
  STATUS_LABELS,
  type LabelFilterOption,
} from "./lib.js";

function toggled<T>(values: readonly T[], value: T, checked: boolean): T[] {
  if (checked) return values.includes(value) ? [...values] : [...values, value];
  return values.filter((existing) => existing !== value);
}

function chipTriggerClass(active: boolean): string {
  return cn(
    "flex min-h-11 shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs sm:min-h-6",
    active
      ? "border-border bg-secondary text-foreground"
      : "border-dashed border-border text-muted-foreground hover:border-input hover:text-foreground",
  );
}

function FilterChip({
  icon,
  label,
  selectedNames,
  children,
}: {
  icon: IconName;
  label: string;
  selectedNames: readonly string[];
  children: ReactNode;
}) {
  const active = selectedNames.length > 0;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={chipTriggerClass(active)}>
          <Icon name={icon} className="size-3" />
          {label}
          {active ? (
            <span className="max-w-48 whitespace-normal break-words font-medium sm:truncate">
              {selectedNames.join(", ")}
            </span>
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44" mobileTitle={`Filter by ${label}`}>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SortChip({
  sort,
  onChange,
}: {
  sort: TaskSort;
  onChange: (sort: TaskSort) => void;
}) {
  const active = sort !== "manual";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={chipTriggerClass(active)}>
          <Icon name="Sort" className="size-3" />
          Sort
          {active ? (
            <span className="font-medium">{SORT_LABELS[sort]}</span>
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-44"
        mobileTitle="Sort tasks"
      >
        {TASK_SORTS.map((option) => (
          <DropdownMenuCheckboxItem
            key={option}
            checked={sort === option}
            onCheckedChange={(checked) => {
              if (checked === true) onChange(option);
            }}
          >
            {SORT_LABELS[option]}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface ListFilterState {
  statuses: TaskStatus[];
  priorities: TaskPriority[];
  labelNames: string[];
  parentTaskId?: string;
}

export const EMPTY_FILTERS: ListFilterState = {
  statuses: [],
  priorities: [],
  labelNames: [],
};

export function hasActiveFilters(filters: ListFilterState): boolean {
  return (
    filters.statuses.length > 0 ||
    filters.priorities.length > 0 ||
    filters.labelNames.length > 0 ||
    filters.parentTaskId !== undefined
  );
}

export function ListFilterBar({
  filters,
  onChange,
  sort,
  onSortChange,
  labelOptions,
  parents,
  taskCount,
}: {
  filters: ListFilterState;
  onChange: (filters: ListFilterState) => void;
  sort: TaskSort;
  onSortChange: (sort: TaskSort) => void;
  labelOptions: readonly LabelFilterOption[];
  parents: readonly Task[];
  taskCount: number | undefined;
}) {
  const keepOpen = (event: Event) => event.preventDefault();
  const showLabelChip =
    labelOptions.length > 0 || filters.labelNames.length > 0;
  const selectedParent = parents.find((parent) => parent.id === filters.parentTaskId);
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-hairline px-3.5 py-2">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 max-sm:basis-full sm:flex-nowrap sm:overflow-x-auto">
        <FilterChip
          icon="Circle"
          label="Status"
          selectedNames={filters.statuses.map(
            (status) => STATUS_LABELS[status],
          )}
        >
          {TASK_STATUSES.map((status) => (
            <DropdownMenuCheckboxItem
              key={status}
              checked={filters.statuses.includes(status)}
              onSelect={keepOpen}
              onCheckedChange={(checked) =>
                onChange({
                  ...filters,
                  statuses: toggled(filters.statuses, status, checked === true),
                })
              }
            >
              <span className="flex items-center gap-2">
                <StatusIcon status={status} className="size-3" />
                {STATUS_LABELS[status]}
              </span>
            </DropdownMenuCheckboxItem>
          ))}
        </FilterChip>
        <FilterChip
          icon="ArrowUpDown"
          label="Priority"
          selectedNames={filters.priorities.map(
            (priority) => PRIORITY_LABELS[priority],
          )}
        >
          {TASK_PRIORITIES.map((priority) => (
            <DropdownMenuCheckboxItem
              key={priority}
              checked={filters.priorities.includes(priority)}
              onSelect={keepOpen}
              onCheckedChange={(checked) =>
                onChange({
                  ...filters,
                  priorities: toggled(
                    filters.priorities,
                    priority,
                    checked === true,
                  ),
                })
              }
            >
              <span className="flex items-center gap-2">
                <PriorityIcon priority={priority} className="size-3" />
                {PRIORITY_LABELS[priority]}
              </span>
            </DropdownMenuCheckboxItem>
          ))}
        </FilterChip>
        {showLabelChip ? (
          <FilterChip
            icon="ListTodo"
            label="Label"
            selectedNames={filters.labelNames}
          >
            {labelOptions.map((option) => (
              <DropdownMenuCheckboxItem
                key={option.name}
                checked={filters.labelNames.includes(option.name)}
                onSelect={keepOpen}
                onCheckedChange={(checked) =>
                  onChange({
                    ...filters,
                    labelNames: toggled(
                      filters.labelNames,
                      option.name,
                      checked === true,
                    ),
                  })
                }
              >
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="size-2 rounded-full"
                    style={{ backgroundColor: option.color }}
                  />
                  {option.name}
                </span>
              </DropdownMenuCheckboxItem>
            ))}
            {filters.labelNames
              .filter(
                (name) => !labelOptions.some((option) => option.name === name),
              )
              .map((name) => (
                <DropdownMenuCheckboxItem
                  key={`stale:${name}`}
                  checked
                  onSelect={keepOpen}
                  onCheckedChange={(checked) =>
                    onChange({
                      ...filters,
                      labelNames: toggled(
                        filters.labelNames,
                        name,
                        checked === true,
                      ),
                    })
                  }
                >
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <span
                      aria-hidden
                      className="size-2 rounded-full bg-muted-foreground/40"
                    />
                    {name}
                    <span className="text-xs">(unavailable)</span>
                  </span>
                </DropdownMenuCheckboxItem>
              ))}
          </FilterChip>
        ) : null}
        <FilterChip
          icon="GitBranch"
          label={filters.parentTaskId === undefined ? "Parent/Epic: All" : "Parent/Epic"}
          selectedNames={filters.parentTaskId === undefined ? [] : [
            selectedParent ? `${selectedParent.key} · ${selectedParent.title}` : "Unavailable parent",
          ]}
        >
          <DropdownMenuCheckboxItem
            checked={filters.parentTaskId === undefined}
            onCheckedChange={() => onChange({ ...filters, parentTaskId: undefined })}
          >
            All
          </DropdownMenuCheckboxItem>
          {parents.map((parent) => (
            <DropdownMenuCheckboxItem
              key={parent.id}
              checked={filters.parentTaskId === parent.id}
              onCheckedChange={() => onChange({ ...filters, parentTaskId: parent.id })}
            >
              <span className="max-w-72 whitespace-normal break-words" title={`${parent.key} · ${parent.title}`}>
                {parent.key} · {parent.title}
              </span>
            </DropdownMenuCheckboxItem>
          ))}
        </FilterChip>
        {hasActiveFilters(filters) ? (
          <button
            type="button"
            onClick={() => onChange(EMPTY_FILTERS)}
            className="flex min-h-11 shrink-0 items-center gap-1 rounded-md border border-dashed border-border px-2.5 text-xs text-muted-foreground hover:border-input hover:text-foreground sm:min-h-6"
          >
            <Icon name="X" className="size-3" />
            Clear
          </button>
        ) : null}
      </div>
      <SortChip sort={sort} onChange={onSortChange} />
      <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-subtle-foreground">
        {taskCount === undefined
          ? ""
          : `${taskCount} ${taskCount === 1 ? "task" : "tasks"}`}
      </span>
    </div>
  );
}
