import { useState } from "react";
import { UrlLink, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { DelegationRpcContract } from "../../delegate/contract.js";
import type { TaskExecution, TaskContinuation } from "../../shared/execution.js";
import { ContinuationDialog } from "./execution.js";
import type {
  Preset,
  TaskPullRequest,
  TaskThread,
} from "../../shared/contract.js";
import { errorMessage } from "../../shared/errors.js";
import {
  PR_STATE_META,
  THREAD_STATUS_META,
  formatRelativeTime,
  isActiveThread,
} from "./meta.js";
import { PresetDialog, savePresetDraft } from "../manage/preset-dialog.js";
import {
  ConfirmDeleteDialog,
  ConfirmDeleteDialogContent,
} from "@/components/ui/confirm-delete-dialog";
import { useTasksQuery, useTasksRpc } from "../../shell/data.js";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

function ThreadPullRequestPill({
  pullRequest,
  unavailable,
}: {
  pullRequest: TaskPullRequest | undefined;
  unavailable: boolean;
}) {
  if (pullRequest) {
    const meta = PR_STATE_META[pullRequest.state];
    return (
      <UrlLink
        href={pullRequest.url}
        target="_blank"
        rel="noopener noreferrer"
        title={`${pullRequest.title} (${meta.label})`}
        aria-label={`Pull request #${pullRequest.number}: ${pullRequest.title} (${meta.label})`}
        className="flex shrink-0 items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 text-xs font-medium shadow-2xs hover:border-input"
      >
        <Icon name={meta.icon} className={cn("size-3", meta.textClassName)} />#
        {pullRequest.number}
      </UrlLink>
    );
  }
  if (unavailable) {
    return (
      <span
        title="Couldn't check this thread's pull request"
        className="shrink-0 text-xs text-muted-foreground"
      >
        PR unavailable
      </span>
    );
  }
  return null;
}

function ThreadCard({
  thread,
  pullRequest,
  pullRequestUnavailable,
  busy,
  onDetach,
  onContinue,
  continuedTo,
  continuedFrom,
  continuedToName,
  continuedFromName,
  targetMachineName,
}: {
  thread: TaskThread;
  pullRequest: TaskPullRequest | undefined;
  pullRequestUnavailable: boolean;
  busy: boolean;
  onDetach: () => void;
  onContinue?: () => void;
  continuedTo: TaskContinuation | undefined;
  continuedFrom: TaskContinuation | undefined;
  continuedToName: string;
  continuedFromName: string;
  targetMachineName: string;
}) {
  const navigate = useBbNavigate();
  const meta = THREAD_STATUS_META[thread.liveStatus];
  return (
    <article aria-label={`Agent thread ${thread.title}`} className="mb-2 flex flex-wrap items-center gap-3 rounded-md border border-border bg-card px-3 py-2 shadow-2xs max-sm:[&_button]:min-h-11 max-sm:[&_button]:min-w-11">
      <span
        className={cn(
          "flex shrink-0 items-center gap-1.5 text-xs font-medium",
          meta.textClassName,
        )}
      >
        <span
          aria-hidden
          className={cn("size-1.5 rounded-full", meta.dotClassName)}
        />
        {meta.label}
      </span>
      <div className="min-w-0 flex-1">
        <div className="break-words text-sm font-medium">{thread.title}</div>
        <div className="text-xs text-muted-foreground">
          {thread.presetName} · attached {formatRelativeTime(thread.attachedAt)}
        </div>
        {continuedTo ? (
          <p className="break-words text-xs text-muted-foreground">
            Previous executor · continued to <button type="button" className="underline" onClick={() => { if (continuedTo.threadId) navigate.toThread(continuedTo.threadId); }}>{continuedToName}</button> on {targetMachineName}
          </p>
        ) : continuedFrom ? (
          <p className="break-words text-xs font-medium">
            Current executor · continued from <button type="button" className="underline" onClick={() => navigate.toThread(continuedFrom.sourceThreadId)}>{continuedFromName}</button>
          </p>
        ) : null}
      </div>
      <ThreadPullRequestPill
        pullRequest={pullRequest}
        unavailable={pullRequestUnavailable}
      />
      {thread.liveStatus === "idle" && onContinue && !continuedTo ? (
        <button type="button" disabled={busy} className="text-xs font-medium underline underline-offset-2" onClick={onContinue}>Continue on another machine</button>
      ) : null}
      <button
        type="button"
        className="flex shrink-0 items-center gap-1 text-xs font-medium underline decoration-input underline-offset-2 hover:decoration-current"
        onClick={() => navigate.toThread(thread.threadId)}
      >
        Open thread
        <Icon name="ArrowUpRight" className="size-3" />
      </button>
      <button
        type="button"
        aria-label={`Detach ${thread.title}`}
        title="Detach from task"
        disabled={busy}
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:opacity-70"
        onClick={onDetach}
      >
        <Icon name="X" className="size-3" />
      </button>
    </article>
  );
}

const LAST_PRESET_STORAGE_KEY = "bb-tasks:last-dispatch-preset";

function loadLastPresetId(): string | null {
  try {
    return window.localStorage.getItem(LAST_PRESET_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeLastPresetId(presetId: string): void {
  try {
    window.localStorage.setItem(LAST_PRESET_STORAGE_KEY, presetId);
  } catch {}
}

interface DispatchControlProps {
  taskId: string;
  presets: Preset[] | undefined;
  execution?: TaskExecution;
  onError: (message: string) => void;
  align?: "start" | "end";
  className?: string;
}

export function DispatchControl({
  taskId,
  presets,
  execution,
  onError,
  align = "end",
  className,
}: DispatchControlProps) {
  const rpc = useRpc<DelegationRpcContract>();
  const tasksRpc = useTasksRpc();
  const [dispatching, setDispatching] = useState(false);
  const [lastPresetId, setLastPresetId] = useState(loadLastPresetId);
  const [createDialogKey, setCreateDialogKey] = useState<number | null>(null);

  const dispatch = async (presetId?: string) => {
    setDispatching(true);
    try {
      await rpc.call("delegate", { taskId, ...(presetId ? { presetId } : {}) });
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setDispatching(false);
    }
  };

  const pickPreset = (preset: Preset) => {
    setLastPresetId(preset.id);
    storeLastPresetId(preset.id);
    void dispatch(preset.id);
  };

  const primarySegment = "border border-input bg-transparent text-foreground hover:bg-state-hover";

  if (presets !== undefined && presets.length === 0) {
    return (
      <>
        <Button
          size="sm"
          className={cn("min-h-11 gap-1.5 sm:min-h-8", primarySegment, className)}
          onClick={() => setCreateDialogKey(Date.now())}
        >
          <Icon name="Plus" className="size-3.5 shrink-0" />
          Add single-agent preset…
        </Button>
        {createDialogKey !== null ? (
          <PresetDialog
            key={createDialogKey}
            open
            onOpenChange={(open) => {
              if (!open) setCreateDialogKey(null);
            }}
            editing={null}
            onSave={(draft) => savePresetDraft(tasksRpc, null, draft)}
          />
        ) : null}
      </>
    );
  }

  const current =
    presets?.find((preset) => preset.id === execution?.override?.presetId) ??
    presets?.find((preset) => preset.id === lastPresetId) ??
    (presets
      ? [...presets].sort((a, b) => a.name.localeCompare(b.name))[0]
      : undefined);

  return (
    <>
      <div className={cn("flex min-w-0", className)}>
        <Button
          size="sm"
          disabled={dispatching || !current}
          className={cn(
            "min-h-11 min-w-0 flex-1 gap-1.5 rounded-r-none sm:min-h-8",
            primarySegment,
          )}
          aria-label={current ? `Run single agent with ${current.name}` : "Run single agent"}
          title={current ? `Run single agent · ${current.name}` : "Run single agent"}
          onClick={() => {
            if (execution?.override) void dispatch();
            else if (current) pickPreset(current);
          }}
        >
          <span className="truncate">
            {dispatching ? "Dispatching…" : "Run single agent"}
          </span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={dispatching || !current}>
            <Button
              size="sm"
              aria-label="Choose dispatch preset"
              className={cn(
                "min-h-11 min-w-11 shrink-0 rounded-l-none sm:min-h-8 sm:min-w-8",
                primarySegment,
              )}
            >
              <Icon name="ChevronDown" className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align={align}>
            <DropdownMenuLabel>Run single agent with preset</DropdownMenuLabel>
            {(presets ?? []).map((preset) => (
              <DropdownMenuItem
                key={preset.id}
                onSelect={() => pickPreset(preset)}
              >
                <span className="min-w-0 flex-1 truncate">{preset.name}</span>
                <span className="text-xs text-muted-foreground">
                  {preset.modelId}
                </span>
                {preset.id === current?.id ? (
                  <Icon name="Check" className="size-3.5" />
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}

interface ThreadsSectionProps {
  threads: TaskThread[];
  taskId: string;
  onContinued: () => void;
  pullRequests: TaskPullRequest[] | undefined;
  unavailableThreadIds: string[];
  onDetach: (thread: TaskThread) => Promise<void>;
  onError: (message: string) => void;
}

export function ThreadsSection({
  threads,
  taskId,
  onContinued,
  pullRequests,
  unavailableThreadIds,
  onDetach,
  onError,
}: ThreadsSectionProps) {
  const [confirm, setConfirm] = useState<TaskThread | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const rpc = useRpc<DelegationRpcContract>();
  const continuations = useTasksQuery(async () => (await rpc.call("getTaskContinuations", { taskId })).continuations, ["threads:changed"], [taskId], { relevantTaskIds: [taskId] });
  const machines = useTasksQuery(async query => (await query.call("listMachines", {})).machines, []);
  const machineName = (id: string) => machines.data?.find(machine => machine.id === id)?.name ?? "Machine unavailable";
  const [continuation, setContinuation] = useState<{ thread: TaskThread | null; retry: TaskContinuation | null; key: number } | null>(null);
  const [continuationOpen, setContinuationOpen] = useState(false);
  const changed = () => { continuations.refresh(); onContinued(); };

  const performDetach = async (thread: TaskThread) => {
    setPending((current) => new Set(current).add(thread.id));
    try {
      await onDetach(thread);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(thread.id);
        return next;
      });
    }
  };

  const activeCount = threads.filter(isActiveThread).length;
  const pullRequestByThread = new Map<string, TaskPullRequest>();
  for (const pullRequest of pullRequests ?? []) {
    for (const threadId of pullRequest.threadIds) {
      pullRequestByThread.set(threadId, pullRequest);
    }
  }
  const unavailable = new Set(unavailableThreadIds);
  const continuedBySource = new Map<string, TaskContinuation>();
  const continuedByTarget = new Map<string, TaskContinuation>();
  for (const entry of continuations.data ?? []) {
    if (entry.state !== "started" || !entry.threadId) continue;
    continuedBySource.set(entry.sourceThreadId, entry);
    continuedByTarget.set(entry.threadId, entry);
  }

  return (
    <section>
      <div className="mb-2 flex items-center gap-2 pt-1.5 text-xs font-semibold text-muted-foreground">
        Agent threads
        {activeCount > 0 ? (
          <span className="font-normal">{activeCount} working now</span>
        ) : null}
      </div>
      {threads.map((thread) => (
        <ThreadCard
          key={thread.id}
          thread={thread}
          continuedTo={continuedBySource.get(thread.threadId)}
          continuedFrom={continuedByTarget.get(thread.threadId)}
          continuedToName={threads.find(entry => entry.threadId === continuedBySource.get(thread.threadId)?.threadId)?.title ?? "Unavailable thread"}
          continuedFromName={threads.find(entry => entry.threadId === continuedByTarget.get(thread.threadId)?.sourceThreadId)?.title ?? "Unavailable source thread"}
          targetMachineName={machineName(continuedBySource.get(thread.threadId)?.targetHostId ?? "")}
          pullRequest={pullRequestByThread.get(thread.threadId)}
          pullRequestUnavailable={unavailable.has(thread.threadId)}
          busy={pending.has(thread.id)}
          onDetach={() => setConfirm(thread)}
          onContinue={continuations.data && !continuations.error && !continuedBySource.has(thread.threadId)
            ? () => { setContinuation({ thread, retry: null, key: Date.now() }); setContinuationOpen(true); }
            : undefined}
        />
      ))}
      {continuations.error ? <p role="alert" className="text-sm text-destructive">{continuations.error} <button type="button" className="underline" onClick={continuations.refresh}>Retry</button></p> : null}
      {continuations.data?.map((entry) => (
        <div key={entry.operationId} className="mb-2 break-words rounded-md border border-border p-3 text-xs">
          <p>Continuation · {entry.state.replaceAll("_", " ")}</p>
          <p>{machineName(entry.targetHostId)} · {entry.targetPath}</p>
          <details><summary className="cursor-pointer py-2">Continuation diagnostics</summary><pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(entry, null, 2)}</pre><button type="button" className="min-h-11 underline sm:min-h-8" onClick={() => { void navigator.clipboard.writeText(JSON.stringify(entry, null, 2)).catch(cause => onError(errorMessage(cause))); }}>Copy diagnostics</button></details>
          {entry.lastError ? <p role="alert" className="text-destructive">{entry.lastError}</p> : null}
          {entry.state === "ready" ? <Button type="button" size="sm" variant="outline" onClick={() => { setContinuation({ thread: null, retry: entry, key: Date.now() }); setContinuationOpen(true); }}>Retry prepared continuation</Button> : null}
        </div>
      ))}
      {continuation ? <ContinuationDialog key={continuation.key} taskId={taskId} thread={continuation.thread} retry={continuation.retry} open={continuationOpen} onOpenChange={setContinuationOpen} onChanged={changed} /> : null}
      <ConfirmDeleteDialog
        className="max-w-sm"
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        {confirm ? (
          <ConfirmDeleteDialogContent
            title="Detach thread?"
            description={`"${confirm.title}" will no longer be listed on this task. The thread itself is not deleted; re-attach it with bb tasks attach.`}
            confirmLabel="Detach"
            pending={false}
            size="sm"
            onCancel={() => setConfirm(null)}
            onConfirm={() => {
              setConfirm(null);
              void performDetach(confirm);
            }}
          />
        ) : null}
      </ConfirmDeleteDialog>
    </section>
  );
}
