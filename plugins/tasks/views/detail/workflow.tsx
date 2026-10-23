import { useEffect, useRef, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type {
  TaskWorkflow,
  TaskWorkflowRpcContract,
} from "../../shared/workflow-contract.js";
import { Button } from "@/components/ui/button";

export function TaskWorkflowPanel({
  taskId,
  profiles,
  originThreadId = "",
}: {
  taskId: string;
  profiles: Array<{ id: string; name: string }>;
  originThreadId?: string;
}) {
  const rpc = useRpc<TaskWorkflowRpcContract>();
  const navigate = useBbNavigate();
  const [runs, setRuns] = useState<TaskWorkflow[]>([]);
  const [origin, setOrigin] = useState(originThreadId);
  const [writer, setWriter] = useState("");
  const [reviewer, setReviewer] = useState("");
  const [smoke, setSmoke] = useState("");
  const [uiRequired, setUiRequired] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const launch = useRef<string | null>(null);
  const locked = useRef(false);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const result = await rpc.call("taskWorkflows", { taskId });
        if (!disposed) {
          setRuns(result.runs);
          setError(null);
        }
      } catch (cause) {
        if (!disposed)
          setError(cause instanceof Error ? cause.message : String(cause));
      }
      if (!disposed) timer = setTimeout(refresh, 5000);
    };
    launch.current = null;
    setRuns([]);
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [rpc, taskId]);
  async function act(action: () => Promise<unknown>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
      setRuns((await rpc.call("taskWorkflows", { taskId })).runs);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  const field =
    "w-full rounded-md border border-input bg-background p-2 text-sm";
  const active = runs.some((run) => run.state !== "accepted");
  return (
    <section className="space-y-3 rounded-lg border border-border p-4">
      <h3 className="font-medium">Build → review</h3>
      <p className="text-sm text-muted-foreground">
        One retained writer plans, builds and executes platform smoke. Another
        allowed runtime/model reviews independently. Human acceptance is
        separate. Provider permission modes are not a read-only sandbox.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!active && (
        <div className="space-y-2">
          <label className="block text-sm">
            Idle origin thread in the linked project workspace
            <input
              className={field}
              value={origin}
              onChange={(event) => {
                setOrigin(event.target.value);
                launch.current = null;
              }}
            />
          </label>
          <label className="block text-sm">
            Writer profile
            <select
              className={field}
              value={writer}
              onChange={(event) => {
                setWriter(event.target.value);
                launch.current = null;
              }}
            >
              <option value="">Select allowed profile</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            Independent reviewer profile
            <select
              className={field}
              value={reviewer}
              onChange={(event) => {
                setReviewer(event.target.value);
                launch.current = null;
              }}
            >
              <option value="">Select another runtime/model</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            Actual platform smoke commands (one per line)
            <textarea
              className={field}
              value={smoke}
              onChange={(event) => {
                setSmoke(event.target.value);
                launch.current = null;
              }}
            />
          </label>
          <label className="flex gap-2 text-sm">
            <input
              type="checkbox"
              checked={uiRequired}
              onChange={(event) => {
                setUiRequired(event.target.checked);
                launch.current = null;
              }}
            />
            UI task: require screenshot or preview evidence
          </label>
          <Button
            disabled={busy || !origin || !writer || !reviewer || !smoke.trim()}
            onClick={() =>
              void act(() => {
                launch.current ??= crypto.randomUUID();
                return rpc.call("launchTaskWorkflow", {
                  taskId,
                  launchKey: launch.current,
                  originThreadId: origin,
                  writerPresetId: writer,
                  reviewerPresetId: reviewer,
                  smokeCommands: smoke
                    .split("\n")
                    .map((command) => command.trim())
                    .filter(Boolean),
                  uiRequired,
                });
              })
            }
          >
            Start bounded workflow
          </Button>
        </div>
      )}
      {runs.map((run) => (
        <article key={run.id} className="space-y-2 border-t border-border pt-3">
          <p className="text-sm">
            Revision {run.revision} · {run.state}{" "}
            {run.native?.phase && `· ${run.native.phase}`}
          </p>
          {run.error && (
            <p role="alert" className="text-sm text-destructive">
              {run.error}
            </p>
          )}
          {run.state === "launching" && run.error && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void act(() => rpc.call("taskWorkflows", { taskId }))
              }
            >
              Retry same launch
            </Button>
          )}
          {run.state === "failed" && run.native?.contextStarted === false && (
            <p className="text-sm text-muted-foreground">
              No writer session was created. Repair the selected execution
              profiles, then return this run to retry its first writer launch.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {run.native?.workers.map((worker) => (
              <Button
                key={worker.threadId}
                variant="outline"
                size="sm"
                onClick={() => navigate.toThread(worker.threadId)}
              >
                Inspect {worker.role}
              </Button>
            ))}
          </div>
          {run.native?.result && (
            <>
              <p className="text-sm">
                Independent review: {run.native.result.review.verdict} ·{" "}
                {run.native.result.review.summary}
              </p>
              <details open>
                <summary className="text-sm">Result package</summary>
                <pre className="overflow-auto whitespace-pre-wrap break-words text-xs">
                  {JSON.stringify(run.native.result, null, 2)}
                </pre>
              </details>
            </>
          )}
          {run.native?.policyLimitations.map((limit) => (
            <p key={limit} className="text-xs text-muted-foreground">
              {limit}
            </p>
          ))}
          {run.state === "in_review" && (
            <Button
              disabled={busy}
              onClick={() =>
                void act(() =>
                  rpc.call("acceptTaskWorkflow", {
                    id: run.id,
                    revision: run.revision,
                  }),
                )
              }
            >
              Accept result
            </Button>
          )}
          {["in_review", "failed"].includes(run.state) && (
            <div className="space-y-2">
              <label className="block text-sm">
                Return feedback
                <textarea
                  className={field}
                  value={feedback}
                  onChange={(event) => setFeedback(event.target.value)}
                />
              </label>
              <Button
                variant="outline"
                disabled={busy || !feedback.trim()}
                onClick={() =>
                  void act(() =>
                    rpc.call("returnTaskWorkflow", {
                      id: run.id,
                      revision: run.revision,
                      feedback,
                    }),
                  )
                }
              >
                {run.native?.contextStarted === false
                  ? "Retry first writer with feedback"
                  : "Return to same writer"}
              </Button>
            </div>
          )}
        </article>
      ))}
    </section>
  );
}
