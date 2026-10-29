import { useEffect, useRef, useState } from "react";
import { Markdown, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type {
  InboxEntry,
  InboxRpcContract,
} from "../../shared/inbox-contract.js";
import { useProjects, useTasksQuery, useTasksRpc } from "../../shell/data.js";
import { useTasksNavigation } from "../../shell/routes.js";
import { errorMessage } from "../../shared/errors.js";
import { Button } from "@/components/ui/button";
import { InboxRoutingControl } from "./routing.js";

const field =
  "min-h-11 min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm sm:min-h-9";
const contexts = ["unknown", "work", "personal"] as const;

function InboxCard({
  item,
  refresh,
}: {
  item: InboxEntry;
  refresh: () => void;
}) {
  const rpc = useRpc<InboxRpcContract>();
  const tasks = useTasksRpc();
  const navigation = useTasksNavigation();
  const navigate = useBbNavigate();
  const projects = useProjects();
  const [projectId, setProjectId] = useState("");
  const [taskKey, setTaskKey] = useState("");
  const [until, setUntil] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const locked = useRef(false);
  const [history, setHistory] = useState<Array<{
    revision: string;
    decision: string;
    at: string;
  }> | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
      refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  return (
    <article className="space-y-3 rounded-lg border border-border p-4 max-sm:[&_button]:min-h-11">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="min-w-0 break-words font-medium">{item.title}</h3>
        <span className="text-xs text-muted-foreground">
          {item.context === "unknown"
            ? "Unclassified"
            : item.context === "work"
              ? "Work"
              : "Personal"}{" "}
          · {item.sourceKind}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">{item.reason}</p>
      {item.body && (
        <details onToggle={(event) => setContextOpen(event.currentTarget.open)}>
          <summary className="cursor-pointer text-sm">Context</summary>
          {contextOpen && (
            <Markdown
              content={item.body}
              className="mt-2 min-w-0 break-words text-sm"
            />
          )}
        </details>
      )}
      {item.snoozedUntil && (
        <p className="text-sm">
          Returns {new Date(item.snoozedUntil).toLocaleString()}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {item.taskKey && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              navigation.go({ kind: "task", taskKey: item.taskKey! })
            }
          >
            {item.taskKey}
          </Button>
        )}
        {item.threadId && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => navigate.toThread(item.threadId!)}
          >
            Open interactive thread
          </Button>
        )}
        {item.sourceUrl && (
          <a
            className="self-center text-sm underline"
            href={item.sourceUrl}
            target="_blank"
            rel="noreferrer"
          >
            Original source
          </a>
        )}
        {item.state !== "resolved" && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(() =>
                rpc.call("decideInbox", { id: item.id, action: "resolve" }),
              )
            }
          >
            Resolve reminder
          </Button>
        )}
        {item.state !== "open" && item.active && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(() =>
                rpc.call("decideInbox", { id: item.id, action: "unsnooze" }),
              )
            }
          >
            Return now
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void run(async () =>
              setHistory(
                (await rpc.call("inboxHistory", { id: item.id })).decisions,
              ),
            )
          }
        >
          History
        </Button>
      </div>
      {item.active && item.state !== "resolved" && (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() =>
              rpc.call("decideInbox", {
                id: item.id,
                action: "snooze",
                until: new Date(until).toISOString(),
              }),
            );
          }}
        >
          <label className="flex min-w-0 flex-col gap-1 text-sm">Snooze until (local time)
            <input className={`${field} max-w-full`} type="datetime-local" aria-label={`Snooze ${item.title} until`} value={until} required onChange={(event) => setUntil(event.target.value)} />
          </label>
          <Button size="sm" variant="outline" disabled={busy}>
            Snooze
          </Button>
        </form>
      )}
      <InboxRoutingControl item={item} refresh={refresh} />
      {!item.taskId && item.sourceKind !== "task_route" && (
        <details>
          <summary className="cursor-pointer text-sm">
            Create or link a task
          </summary>
          <p className="my-2 text-xs text-muted-foreground">
            Creates one native task, never dispatches. Set execution and
            dispatch from its task page. Linking resolves only this incoming
            reminder.
          </p>
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const result = await rpc.call("createInboxTask", {
                  id: item.id,
                  projectId,
                });
                if (result.item.taskKey)
                  navigation.go({ kind: "task", taskKey: result.item.taskKey });
              });
            }}
          >
            <select
              aria-label="Task project"
              className={field}
              value={projectId}
              required
              onChange={(event) => setProjectId(event.target.value)}
            >
              <option value="">Choose project</option>
              {projects.data?.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.prefix} · {project.name}
                </option>
              ))}
            </select>
            <Button size="sm" disabled={busy || !projectId}>
              Create task once
            </Button>
          </form>
          <form
            className="mt-2 flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const result = await tasks.call("getTaskByKey", {
                  taskKey: taskKey.trim().toUpperCase(),
                });
                if (!result.task) throw new Error("Task not found");
                await rpc.call("linkInboxTask", {
                  id: item.id,
                  taskId: result.task.id,
                });
              });
            }}
          >
            <input
              aria-label="Existing task key"
              className={field}
              placeholder="Existing task key"
              value={taskKey}
              required
              onChange={(event) => setTaskKey(event.target.value)}
            />
            <Button size="sm" variant="outline" disabled={busy}>
              Link existing
            </Button>
          </form>
        </details>
      )}
      {history && (
        <ol className="space-y-1 text-xs text-muted-foreground">
          {history.map((decision, index) => (
            <li key={index}>
              {new Date(decision.at).toLocaleString()} · {decision.decision}
            </li>
          ))}
        </ol>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </article>
  );
}

export function InboxView() {
  const rpc = useRpc<InboxRpcContract>();
  const [state, setState] = useState<"open" | "snoozed" | "resolved" | "all">(
    "open",
  );
  const [context, setContext] = useState<InboxEntry["context"] | "all">("all");
  const query = useTasksQuery(
    async () =>
      rpc.call("listInbox", {
        state,
        ...(context === "all" ? {} : { context }),
      }),
    ["inbox:changed", "tasks:changed", "threads:changed", "comments:changed"],
    [state, context],
  );
  useEffect(() => {
    const timer = setInterval(query.refresh, 15000);
    return () => clearInterval(timer);
  }, [query.refresh]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [intakeContext, setIntakeContext] =
    useState<InboxEntry["context"]>("unknown");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  return (
    <section className="mx-auto max-w-5xl space-y-5 p-4 max-sm:[&_button]:min-h-11">
      <p className="text-sm text-muted-foreground">
        Incoming is not a task. A task is not a thread. Resolve dismisses a
        reminder, not a question or a result. Work/Personal organize attention;
        they are not access controls.
      </p>
      <form
        className="space-y-2 rounded-lg border border-border p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (locked.current) return;
          locked.current = true;
          setBusy(true);
          setError(null);
          void rpc
            .call("createInbox", {
              title,
              body,
              context: intakeContext,
              ...(sourceUrl ? { sourceUrl } : {}),
            })
            .then(() => {
              setTitle("");
              setBody("");
              setSourceUrl("");
              query.refresh();
            })
            .catch((cause: unknown) => setError(errorMessage(cause)))
            .finally(() => {
              locked.current = false;
              setBusy(false);
            });
        }}
      >
        <label className="block text-sm font-medium" htmlFor="incoming-title">
          Manual incoming
        </label>
        <input
          id="incoming-title"
          className={`${field} w-full`}
          placeholder="What needs attention?"
          required
          maxLength={2000}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <textarea
          aria-label="Incoming context"
          className={`${field} w-full`}
          placeholder="Context"
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
        <input
          aria-label="Incoming source URL"
          type="url"
          className={`${field} w-full`}
          placeholder="Optional original source URL"
          value={sourceUrl}
          onChange={(event) => setSourceUrl(event.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <select
            aria-label="Incoming organization"
            className={field}
            value={intakeContext}
            onChange={(event) => {
              const value = contexts.find(
                (candidate) => candidate === event.target.value,
              );
              if (value) setIntakeContext(value);
            }}
          >
            {contexts.map((value) => (
              <option key={value} value={value}>
                {value === "unknown"
                  ? "Unclassified"
                  : value === "work"
                    ? "Work"
                    : "Personal"}
              </option>
            ))}
          </select>
          <Button disabled={busy}>Add incoming</Button>
        </div>
      </form>
      <div className="flex flex-wrap gap-2">
        <select
          aria-label="Inbox state"
          className={field}
          value={state}
          onChange={(event) => {
            const value = ["open", "snoozed", "resolved", "all"] as const;
            const selected = value.find(
              (candidate) => candidate === event.target.value,
            );
            if (selected) setState(selected);
          }}
        >
          <option value="open">Attention</option>
          <option value="snoozed">Snoozed</option>
          <option value="resolved">Resolved</option>
          <option value="all">All history</option>
        </select>
        <select
          aria-label="Organization filter"
          className={field}
          value={context}
          onChange={(event) => {
            const value = [...contexts, "all"] as const;
            const selected = value.find(
              (candidate) => candidate === event.target.value,
            );
            if (selected) setContext(selected);
          }}
        >
          <option value="all">All contexts</option>
          {contexts.map((value) => (
            <option key={value} value={value}>
                {value === "unknown" ? "Unclassified" : value === "work" ? "Work" : "Personal"}
            </option>
          ))}
        </select>
        <Button variant="outline" onClick={query.refresh}>
          Refresh
        </Button>
      </div>
      {(error || query.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error ?? query.error}
        </p>
      )}
      {query.data?.warnings.map((warning) => (
        <p
          key={warning}
          role="status"
          className="text-sm text-muted-foreground"
        >
          {warning}
        </p>
      ))}
      {!query.data && query.isLoading && (
        <p role="status">Loading attention…</p>
      )}
      {(
        [
          ["new", "New"],
          ["needs_input", "Needs input"],
          ["review", "Review"],
        ] as const
      ).map(([lane, label]) => {
        const items =
          query.data?.items.filter((item) => item.lane === lane) ?? [];
        return (
          <section key={lane} className="space-y-3">
            <h2 className="text-sm font-semibold">
              {label} · {items.length}
            </h2>
            {items.map((item) => (
              <InboxCard key={item.id} item={item} refresh={query.refresh} />
            ))}
            {query.data && items.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No {label.toLowerCase()} items.
              </p>
            )}
          </section>
        );
      })}
    </section>
  );
}

export function WorkingView() {
  const rpc = useRpc<InboxRpcContract>();
  const navigate = useBbNavigate();
  const navigation = useTasksNavigation();
  const query = useTasksQuery(
    async () => rpc.call("listWorking", {}),
    ["inbox:changed", "threads:changed", "tasks:changed"],
    [],
  );
  useEffect(() => {
    const timer = setInterval(query.refresh, 15000);
    return () => clearInterval(timer);
  }, [query.refresh]);
  return (
    <section className="mx-auto max-w-5xl space-y-4 p-4 max-sm:[&_button]:min-h-11">
      <p className="text-sm text-muted-foreground">
        Native agents starting or working now. Pending questions belong in
        Inbox. Idle and completed threads are not accepted results.
      </p>
      {!query.data && query.isLoading && <p role="status">Loading active agents…</p>}
      {query.error && <p role="alert">{query.error} <button type="button" className="underline" onClick={query.refresh}>Retry</button></p>}
      {query.data?.warnings.map((warning) => (
        <p
          key={warning}
          role="status"
          className="text-sm text-muted-foreground"
        >
          {warning}
        </p>
      ))}
      {query.data?.items.map((item) => (
        <article
          key={`${item.taskId}:${item.threadId}`}
          className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-4"
        >
          <span className="min-w-0 flex-1 break-words text-sm">
            {item.title} · {item.status} · {item.context}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              navigation.go({ kind: "task", taskKey: item.taskKey })
            }
          >
            {item.taskKey}
          </Button>
          <Button size="sm" onClick={() => navigate.toThread(item.threadId)}>
            Open thread
          </Button>
        </article>
      ))}
      {query.data?.items.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No linked agents working now.
        </p>
      )}
    </section>
  );
}
