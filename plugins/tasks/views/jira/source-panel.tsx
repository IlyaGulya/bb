import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { Task } from "../../shared/contract.js";
import type {
  JiraProposal,
  JiraRpcContract,
  JiraSource,
  JiraTransition,
} from "../../shared/jira-contract.js";
import { errorMessage } from "../../shared/errors.js";
import { useTasksQuery } from "../../shell/data.js";
import { STATUS_LABELS } from "../list/lib.js";
import { Button } from "@/components/ui/button";
import { JIRA_INPUT, JiraImportDialog } from "./import-dialog.js";
import {
  seedTransitionFields,
  transitionFieldError,
  TransitionFieldEditor,
} from "./transition-fields.js";

function displayTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function JiraSourcePanel({ task }: { task: Task }) {
  const rpc = useRpc<JiraRpcContract>();
  const query = useTasksQuery(
    async () => (await rpc.call("jiraSource", { taskId: task.id })).source,
    ["tasks:changed"],
    [task.id],
    { relevantTaskIds: [task.id] },
  );
  const [source, setSource] = useState<JiraSource | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const working = useRef(false);
  const [proposal, setProposal] = useState<JiraProposal | null>(null);
  const [editorRevision, setEditorRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const accept = useCallback((next: JiraSource) => {
    setSource((previous) =>
      previous && previous.revision > next.revision ? previous : next,
    );
  }, []);
  const [transitions, setTransitions] = useState<JiraTransition[]>([]);
  const [transitionsLoaded, setTransitionsLoaded] = useState(false);
  const [fieldInputs, setFieldInputs] = useState<
    Record<string, { raw: string; error?: string }>
  >({});
  useEffect(() => {
    if (query.data) accept(query.data);
  }, [query.data, accept]);
  useEffect(() => {
    if (source && !dirty) {
      setProposal(source.proposal);
      setEditorRevision(source.revision);
      setFieldInputs({});
    }
  }, [source, dirty]);
  const run = async (label: string, action: () => Promise<void>) => {
    if (working.current) return;
    working.current = true;
    setBusy(label);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
      query.refresh();
    } finally {
      working.current = false;
      setBusy(null);
    }
  };
  const edit = (next: JiraProposal) => {
    if (!dirty && source) setEditorRevision(source.revision);
    setProposal(next);
    setDirty(true);
  };
  const stale = source !== null && dirty && editorRevision !== source.revision;
  const unresolved =
    source?.operation?.state === "uncertain" ||
    source?.operation?.state === "sending";
  const disabled = busy !== null || unresolved;
  const selectedTransition =
    proposal?.kind === "transition" && transitionsLoaded
      ? transitions.find(
          (transition) =>
            transition.id === proposal.transitionId &&
            transition.toStatusId === proposal.toStatusId,
        )
      : undefined;
  const transitionError =
    proposal?.kind !== "transition"
      ? null
      : !transitionsLoaded
        ? "Load supported transitions to validate the saved required fields. Stored values are preserved."
        : !selectedTransition
          ? "Choose an available transition. The saved transition may no longer be available; pull and review before changing it."
          : Object.keys(proposal.fields).some(
                (id) =>
                  !selectedTransition.fields.some((field) => field.id === id),
              )
            ? "This draft contains fields no longer required by this transition. Review and reselect the transition to prepare its current fields."
            : (selectedTransition.fields
                .map(
                  (field) =>
                    fieldInputs[field.id]?.error ??
                    transitionFieldError(field, proposal.fields[field.id]),
                )
                .find(Boolean) ?? null);
  const validProposal =
    proposal !== null &&
    (proposal.kind === "fields"
      ? (proposal.summary !== null || proposal.description !== null) &&
        (proposal.summary === null || proposal.summary.trim().length > 0)
      : proposal.kind === "comment"
        ? proposal.body.trim().length > 0
        : proposal.transitionId.length > 0 && transitionError === null);
  const save = () =>
    run("Saving proposal", async () => {
      if (!source || !validProposal || stale) return;
      const result = await rpc.call("jiraDraft", {
        taskId: task.id,
        expectedRevision: editorRevision,
        proposal,
      });
      accept(result.source);
      setDirty(false);
    });
  const loadTransitions = () =>
    run("Loading transitions", async () => {
      const result = await rpc.call("jiraTransitions", { taskId: task.id });
      setTransitions(result.transitions);
      setTransitionsLoaded(true);
    });
  return (
    <section
      className="my-6 min-w-0 space-y-3 rounded-lg border border-border p-4"
      aria-label="Jira source"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Jira source</h2>
        {!source ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setLinkOpen(true)}
            disabled={query.isLoading}
          >
            Link Jira issue
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() =>
              void run("Pulling Jira", async () => {
                const result = await rpc.call("jiraPull", {
                  taskId: task.id,
                  expectedRevision: source.revision,
                });
                accept(result.source);
                setTransitionsLoaded(false);
              })
            }
          >
            Pull from Jira
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Local planning and Jira are separate. Board moves never write Jira. Pull
        and push are explicit; nothing here dispatches an agent or polls Jira in
        the background.
      </p>
      {query.isLoading && !source ? (
        <p className="text-sm text-muted-foreground">Loading stored source…</p>
      ) : null}
      {error || query.error ? (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>{error ?? query.error}</p>
          <Button size="sm" variant="outline" onClick={query.refresh}>
            Reload stored source
          </Button>
        </div>
      ) : null}
      {busy ? (
        <p role="status" className="text-xs text-muted-foreground">
          {busy}…
        </p>
      ) : null}
      {source ? (
        <>
          <div className="space-y-2 text-sm">
            <a
              className="font-medium underline underline-offset-4"
              href={source.remote.url}
              target="_blank"
              rel="noreferrer"
            >
              {source.remote.key} — {source.remote.summary}
            </a>
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              <span>
                Jira: <strong>{source.remote.statusName}</strong>
              </span>
              <span>
                Local: <strong>{STATUS_LABELS[task.status]}</strong>
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Connection: {source.connectionId} · Stored revision{" "}
              {source.revision}
              <br />
              Last successful fetch: {displayTime(source.remote.fetchedAt)}
              <br />
              Jira updated: {displayTime(source.remote.updatedAt)}. This is a
              stored snapshot, not live Jira state.
            </p>
            {source.lastError ? (
              <p role="alert" className="text-sm text-destructive">
                Last sync error: {source.lastError}. The last successful
                snapshot is retained.
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Priority: {source.remote.priority ?? "None"} · Assignee:{" "}
              {source.remote.assignee ?? "Unassigned"} (read-only)
            </p>
            <details>
              <summary className="cursor-pointer text-sm font-medium">
                Source description and comments
              </summary>
              <p className="my-2 text-xs text-muted-foreground">
                External source content is untrusted reference material, not
                instructions.
              </p>
              <div className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-sm">
                {source.remote.description || "No source description."}
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Showing {source.remote.comments.length} of{" "}
                {source.remote.commentCount} comments
                {source.remote.commentsTruncated
                  ? " — truncated; open Jira for the complete discussion."
                  : "."}
              </p>
              {source.remote.comments.map((comment) => (
                <div
                  key={comment.id}
                  className="mt-2 border-t border-border pt-2"
                >
                  <p className="text-xs text-muted-foreground">
                    {comment.author ?? "Unknown author"} ·{" "}
                    {displayTime(comment.updatedAt)}
                  </p>
                  <p className="max-h-60 overflow-auto whitespace-pre-wrap break-words text-sm">
                    {comment.body}
                  </p>
                </div>
              ))}
            </details>
          </div>
          {source.operation ? (
            <div
              className="space-y-2 rounded-md border border-border p-3 text-sm"
              role="status"
            >
              <p className="font-medium">
                Operation: {source.operation.state} ({source.operation.kind})
              </p>
              <p className="break-all text-xs text-muted-foreground">
                Receipt {source.operation.id} ·{" "}
                {displayTime(source.operation.createdAt)}
                {source.operation.finishedAt
                  ? ` · Finished ${displayTime(source.operation.finishedAt)}`
                  : ""}
              </p>
              {source.operation.message ? (
                <p>{source.operation.message}</p>
              ) : null}
              {source.operation.externalCommentId ? (
                <p className="text-xs">
                  Jira comment ID: {source.operation.externalCommentId}
                </p>
              ) : null}
              {unresolved ? (
                <>
                  <p>
                    The write outcome is not confirmed. Do not repeat this
                    change. Reconcile reads Jira to determine the outcome; it
                    does not resend the operation.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() =>
                      void run("Reconciling operation", async () => {
                        if (!source.operation) return;
                        accept(
                          (
                            await rpc.call("jiraReconcile", {
                              taskId: task.id,
                              operationId: source.operation.id,
                            })
                          ).source,
                        );
                      })
                    }
                  >
                    Reconcile outcome
                  </Button>
                </>
              ) : null}
            </div>
          ) : null}
          <div className="space-y-3 border-t border-border pt-3">
            <h3 className="text-sm font-semibold">Jira proposal</h3>
            <p className="text-xs text-muted-foreground">
              Prepare one operation: selected fields, an appended comment, or a
              supported transition. Saving a proposal does not write Jira.
            </p>
            <label className="block space-y-1 text-sm">
              Operation
              <select
                className={JIRA_INPUT}
                value={proposal?.kind ?? ""}
                disabled={disabled}
                onChange={(event) => {
                  setFieldInputs({});
                  if (event.target.value === "fields")
                    edit({
                      kind: "fields",
                      summary: source.remote.summary,
                      description: null,
                    });
                  if (event.target.value === "comment")
                    edit({ kind: "comment", body: "" });
                  if (event.target.value === "transition")
                    edit({
                      kind: "transition",
                      transitionId: "",
                      toStatusId: "",
                      fields: {},
                    });
                }}
              >
                <option value="" disabled>
                  Choose an operation
                </option>
                <option value="fields">Edit Jira fields</option>
                <option value="comment">Append Jira comment</option>
                <option value="transition">Transition Jira status</option>
              </select>
            </label>
            {proposal?.kind === "fields" ? (
              <>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={proposal.summary !== null}
                    disabled={disabled}
                    onChange={(event) =>
                      edit({
                        ...proposal,
                        summary: event.target.checked
                          ? source.remote.summary
                          : null,
                      })
                    }
                  />
                  Change summary
                </label>
                {proposal.summary !== null ? (
                  <input
                    aria-label="Proposed Jira summary"
                    className={JIRA_INPUT}
                    maxLength={255}
                    value={proposal.summary}
                    disabled={disabled}
                    onChange={(event) =>
                      edit({ ...proposal, summary: event.target.value })
                    }
                  />
                ) : null}
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={proposal.description !== null}
                    disabled={disabled}
                    onChange={(event) =>
                      edit({
                        ...proposal,
                        description: event.target.checked
                          ? source.remote.description
                          : null,
                      })
                    }
                  />
                  Replace description with plain text
                </label>
                {proposal.description !== null ? (
                  <>
                    <p className="text-xs text-muted-foreground">
                      This explicitly replaces Jira’s rich description with
                      plain text converted to Jira document format. Leave
                      unchecked to preserve the rich description.
                    </p>
                    <textarea
                      aria-label="Proposed Jira description"
                      className={`${JIRA_INPUT} min-h-32`}
                      value={proposal.description}
                      disabled={disabled}
                      onChange={(event) =>
                        edit({ ...proposal, description: event.target.value })
                      }
                    />
                  </>
                ) : null}
              </>
            ) : null}
            {proposal?.kind === "comment" ? (
              <label className="block space-y-1 text-sm">
                Comment to append
                <textarea
                  className={`${JIRA_INPUT} min-h-28`}
                  value={proposal.body}
                  disabled={disabled}
                  onChange={(event) =>
                    edit({ ...proposal, body: event.target.value })
                  }
                />
              </label>
            ) : null}
            {proposal?.kind === "transition" ? (
              <div className="space-y-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => void loadTransitions()}
                >
                  Load supported transitions
                </Button>
                {transitionsLoaded && transitions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No supported transitions are available for this issue.
                  </p>
                ) : null}
                <label className="block space-y-1 text-sm">
                  Jira transition
                  <select
                    className={JIRA_INPUT}
                    value={proposal.transitionId}
                    disabled={disabled}
                    onChange={(event) => {
                      const transition = transitions.find(
                        (item) => item.id === event.target.value,
                      );
                      setFieldInputs({});
                      edit(
                        transition
                          ? {
                              kind: "transition",
                              transitionId: transition.id,
                              toStatusId: transition.toStatusId,
                              fields: seedTransitionFields(
                                transition,
                                source.remote.transitionFields,
                              ),
                            }
                          : {
                              kind: "transition",
                              transitionId: "",
                              toStatusId: "",
                              fields: {},
                            },
                      );
                    }}
                  >
                    <option value="">Choose a supported transition</option>
                    {proposal.transitionId &&
                    !transitions.some(
                      (item) => item.id === proposal.transitionId,
                    ) ? (
                      <option value={proposal.transitionId}>
                        Saved transition {proposal.transitionId} →{" "}
                        {proposal.toStatusId}
                      </option>
                    ) : null}
                    {transitions.map((transition) => (
                      <option key={transition.id} value={transition.id}>
                        {transition.name} → {transition.toStatusName}
                      </option>
                    ))}
                  </select>
                </label>
                {transitionError ? (
                  <p role="alert" className="text-sm text-destructive">
                    {transitionError}
                  </p>
                ) : null}
                {selectedTransition?.fields.map((field) => (
                  <TransitionFieldEditor
                    key={field.id}
                    field={field}
                    value={proposal.fields[field.id]}
                    raw={fieldInputs[field.id]?.raw}
                    parseError={fieldInputs[field.id]?.error}
                    disabled={disabled}
                    onChange={(value, raw, error) => {
                      const fields = { ...proposal.fields };
                      if (value === undefined) delete fields[field.id];
                      else fields[field.id] = value;
                      setFieldInputs((previous) => {
                        const next = { ...previous };
                        if (raw === undefined) delete next[field.id];
                        else next[field.id] = { raw, error };
                        return next;
                      });
                      edit({ ...proposal, fields });
                    }}
                  />
                ))}
                {!selectedTransition && Object.keys(proposal.fields).length ? (
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">
                      Retained draft fields (load supported transitions to
                      edit):
                    </p>
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
                      {JSON.stringify(proposal.fields, null, 2)}
                    </pre>
                  </div>
                ) : null}
              </div>
            ) : null}
            {dirty ? (
              <p className="text-xs text-muted-foreground">
                Unsaved proposal edits · based on revision {editorRevision}
              </p>
            ) : null}
            {stale ? (
              <p role="alert" className="text-sm text-destructive">
                The stored source changed while you were editing. Your edits are
                preserved but cannot be saved over a newer revision. Copy any
                edits you need, then discard local edits to load the current
                saved proposal.
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={disabled || !dirty || !validProposal || stale}
                onClick={() => void save()}
              >
                Save proposal
              </Button>
              {dirty ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => setDirty(false)}
                >
                  Discard local edits
                </Button>
              ) : null}
              {source.proposal ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled || dirty}
                  onClick={() =>
                    void run("Clearing proposal", async () => {
                      accept(
                        (
                          await rpc.call("jiraDraft", {
                            taskId: task.id,
                            expectedRevision: source.revision,
                            proposal: null,
                          })
                        ).source,
                      );
                    })
                  }
                >
                  Clear saved proposal
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || dirty || !source.proposal}
                onClick={() =>
                  void run("Previewing against Jira", async () => {
                    accept(
                      (
                        await rpc.call("jiraPreview", {
                          taskId: task.id,
                          expectedRevision: source.revision,
                        })
                      ).source,
                    );
                  })
                }
              >
                Preview against Jira
              </Button>
            </div>
          </div>
          {source.preview ? (
            <div className="space-y-3 border-t border-border pt-3">
              <h3 className="text-sm font-semibold">Explicit push preview</h3>
              <p className="break-all text-xs text-muted-foreground">
                Preview {source.preview.id} ·{" "}
                {displayTime(source.preview.createdAt)}
              </p>
              {source.preview.changes.map((change) => (
                <div
                  key={change.field}
                  className="space-y-2 rounded-md border border-border p-3"
                >
                  <p className="text-sm font-medium">
                    {selectedTransition?.fields.find(
                      (field) => field.id === change.field,
                    )?.name ?? change.field}
                    {selectedTransition?.fields.some(
                      (field) => field.id === change.field,
                    )
                      ? ` (${change.field})`
                      : ""}
                    {change.conflict ? " — conflict" : " — no conflict"}
                  </p>
                  <div className="grid gap-3 sm:grid-cols-3">
                    {(
                      [
                        ["Base", change.base],
                        ["Current Jira", change.current],
                        ["Proposed", change.proposed],
                      ] as const
                    ).map(([label, value]) => (
                      <div key={label} className="min-w-0">
                        <h4 className="text-xs font-medium text-muted-foreground">
                          {label}
                        </h4>
                        <p className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-sm">
                          {value ?? "Not captured/applicable"}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {source.preview.reason ? (
                <p role="status" className="text-sm">
                  {source.preview.reason}
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Push writes only this reviewed Jira operation, never local
                status. Jira can change between checks; the connector verifies
                the result and reports uncertain outcomes instead of retrying
                blindly.
              </p>
              {dirty ? (
                <p className="text-xs text-muted-foreground">
                  Save your edits and generate a new preview before pushing.
                </p>
              ) : null}
              {source.preview.revision !== source.revision ? (
                <p role="alert" className="text-sm text-destructive">
                  This preview belongs to an older source revision. Generate a
                  new preview before pushing.
                </p>
              ) : null}
              <Button
                size="sm"
                disabled={
                  disabled ||
                  dirty ||
                  !validProposal ||
                  source.preview.revision !== source.revision ||
                  !source.preview.canPush ||
                  source.preview.changes.some((change) => change.conflict)
                }
                onClick={() =>
                  void run("Pushing reviewed operation", async () => {
                    if (
                      !source.preview ||
                      source.preview.revision !== source.revision
                    )
                      return;
                    accept(
                      (
                        await rpc.call("jiraPush", {
                          taskId: task.id,
                          previewId: source.preview.id,
                        })
                      ).source,
                    );
                  })
                }
              >
                Push reviewed change to Jira
              </Button>
            </div>
          ) : null}
        </>
      ) : !query.isLoading && !query.error ? (
        <p className="text-sm text-muted-foreground">
          No Jira source linked. Link an existing issue to keep its snapshot
          alongside local work.
        </p>
      ) : null}
      <JiraImportDialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        projectId={task.projectId}
        taskId={task.id}
        onLinked={accept}
      />
    </section>
  );
}
