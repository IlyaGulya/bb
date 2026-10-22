import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { publishTasksChanged, type TasksApiStore } from "../api/index.js";
import {
  jiraRpcContract,
  type JiraChange,
  type JiraOperation,
  type JiraPreview,
  type JiraProposal,
  type JiraSnapshot,
  type JiraSource,
  type JiraTransition,
} from "../shared/jira-contract.js";
import {
  fieldValuesEqual,
  fieldValuesMatch,
  hasRequiredFieldValue,
} from "../shared/jira-fields.js";
import {
  JiraClient,
  JiraRequestError,
  plainDescriptionMatches,
  snapshotFingerprint,
} from "./client.js";
import {
  loadJiraConfiguration,
  publicConnection,
  type JiraConfiguration,
} from "./config.js";
import { JiraStore, type StoredOperation } from "./store.js";

export type JiraHandlers = {
  [K in keyof typeof jiraRpcContract]: (
    input: z.infer<(typeof jiraRpcContract)[K]["input"]>,
  ) => Promise<z.infer<(typeof jiraRpcContract)[K]["output"]>>;
};
export interface JiraSyncOptions {
  configuration?: () => JiraConfiguration;
  fetch?: typeof fetch;
}
function selectedFields(proposal: JiraProposal | null): string[] {
  return proposal?.kind === "transition" ? Object.keys(proposal.fields) : [];
}

function transitionProblem(
  transitions: JiraTransition[],
  proposal: Extract<JiraProposal, { kind: "transition" }>,
  converged: boolean,
): string | null {
  for (const [id, value] of Object.entries(proposal.fields)) {
    if (!hasRequiredFieldValue(value))
      return `Supply a non-empty value for required Jira field ${id} before pushing`;
  }
  const transition = transitions.find(
    (candidate) =>
      candidate.id === proposal.transitionId &&
      candidate.toStatusId === proposal.toStatusId,
  );
  if (!transition)
    return converged
      ? null
      : "The selected Jira transition is no longer available; pull and review again";
  for (const id of Object.keys(proposal.fields)) {
    if (!transition.fields.some((field) => field.id === id))
      return `Field ${id} is not a required field of the selected transition`;
  }
  for (const field of transition.fields) {
    if (field.unsupportedReason) return field.unsupportedReason;
    if (!field.operations.includes("set"))
      return `Required Jira field ${field.name} (${field.id}) does not support set; complete this transition in Jira`;
    const value = proposal.fields[field.id];
    if (!hasRequiredFieldValue(value))
      return `Supply required Jira field ${field.name} (${field.id}) before pushing`;
    if (
      ((field.type === "string" ||
        field.type === "date" ||
        field.type === "datetime") &&
        typeof value !== "string") ||
      (field.type === "number" && typeof value !== "number") ||
      (field.type === "integer" &&
        (typeof value !== "number" || !Number.isInteger(value))) ||
      (field.type === "boolean" && typeof value !== "boolean") ||
      (field.type === "array" && !Array.isArray(value)) ||
      (field.type === "object" &&
        (typeof value !== "object" || Array.isArray(value)))
    )
      return `Supply a ${field.type} value for Jira field ${field.name} (${field.id})`;
    if (field.allowedValues.length > 0) {
      const values =
        field.type === "array" && Array.isArray(value) ? value : [value];
      if (
        values.some(
          (item) =>
            !field.allowedValues.some((allowed) =>
              fieldValuesEqual(item, allowed.value),
            ),
        )
      )
        return `Choose an allowed value for Jira field ${field.name} (${field.id})`;
    }
  }
  return null;
}

function changesFor(
  base: JiraSnapshot,
  remote: JiraSnapshot,
  proposal: JiraProposal,
): JiraChange[] {
  if (proposal.kind === "comment")
    return [
      {
        field: "comment",
        base: null,
        current: null,
        proposed: proposal.body,
        conflict: false,
      },
    ];
  if (proposal.kind === "transition")
    return [
      {
        field: "status",
        base: base.statusId,
        current: remote.statusId,
        proposed: proposal.toStatusId,
        conflict:
          remote.statusId !== base.statusId &&
          remote.statusId !== proposal.toStatusId,
      },
      ...Object.entries(proposal.fields).map(([field, value]) => {
        const baseline = base.transitionFields[field];
        const current = remote.transitionFields[field];
        return {
          field,
          base: baseline === undefined ? null : JSON.stringify(baseline),
          current: current === undefined ? null : JSON.stringify(current),
          proposed: JSON.stringify(value),
          conflict:
            !fieldValuesMatch(current, value) &&
            !fieldValuesMatch(current, baseline),
        };
      }),
    ];
  const changes: JiraChange[] = [];
  if (proposal.summary !== null)
    changes.push({
      field: "summary",
      base: base.summary,
      current: remote.summary,
      proposed: proposal.summary,
      conflict:
        remote.summary !== base.summary && remote.summary !== proposal.summary,
    });
  if (proposal.description !== null)
    changes.push({
      field: "description",
      base: base.description,
      current: remote.description,
      proposed: proposal.description,
      conflict:
        remote.descriptionDocument !== base.descriptionDocument &&
        !plainDescriptionMatches(remote, proposal.description),
    });
  return changes;
}

function matches(remote: JiraSnapshot, proposal: JiraProposal): boolean {
  if (proposal.kind === "comment") return false;
  if (proposal.kind === "transition")
    return (
      remote.statusId === proposal.toStatusId &&
      Object.entries(proposal.fields).every(([field, value]) =>
        fieldValuesMatch(remote.transitionFields[field], value),
      )
    );
  return (
    (proposal.summary === null || proposal.summary === remote.summary) &&
    (proposal.description === null ||
      plainDescriptionMatches(remote, proposal.description))
  );
}

function writeProposal(
  remote: JiraSnapshot,
  proposal: JiraProposal,
): JiraProposal | null {
  if (matches(remote, proposal)) return null;
  if (proposal.kind !== "fields") return proposal;
  return {
    kind: "fields",
    summary: proposal.summary === remote.summary ? null : proposal.summary,
    description:
      proposal.description !== null &&
      plainDescriptionMatches(remote, proposal.description)
        ? null
        : proposal.description,
  };
}

function safeError(error: unknown): string {
  if (error instanceof z.ZodError)
    return "Jira returned data that does not match the supported API format";
  return error instanceof Error ? error.message : "Jira action failed";
}

export function registerJiraSync(
  bb: BbPluginApi,
  tasks: TasksApiStore,
  options: JiraSyncOptions = {},
): JiraHandlers {
  const repository = new JiraStore(bb.storage.database(), tasks);
  repository.recoverInterrupted();
  const configuration = options.configuration ?? loadJiraConfiguration;

  function connection(id: string, projectId: string) {
    const config = configuration();
    if (config.error) throw new Error(config.error);
    const result = config.connections.find((candidate) => candidate.id === id);
    if (!result)
      throw new Error(
        "Jira connection is not configured; ask the operator to check the connections file",
      );
    if (!result.projectIds.includes(projectId))
      throw new Error(
        "This Jira connection is not enabled for the task's current project",
      );
    return result;
  }

  function sourceFor(taskId: string): JiraSource {
    const task = tasks.tasks.getTask(taskId);
    if (!task) throw new Error("Task not found");
    const source = repository.source(taskId);
    if (!source) throw new Error("Task has no linked Jira source");
    connection(source.connectionId, task.projectId);
    return source;
  }

  function clientFor(source: JiraSource): JiraClient {
    const task = tasks.tasks.getTask(source.taskId);
    if (!task) throw new Error("Task not found");
    return new JiraClient(
      connection(source.connectionId, task.projectId),
      options.fetch,
    );
  }

  function checkRevision(source: JiraSource, expected: number): void {
    if (source.revision !== expected)
      throw new Error("Jira source changed; refresh before editing or syncing");
  }

  function checkIdle(source: JiraSource): void {
    if (
      source.operation &&
      ["prepared", "sending", "uncertain"].includes(source.operation.state)
    ) {
      throw new Error(
        "A Jira write has an unresolved outcome; reconcile it before preparing or sending another change",
      );
    }
  }

  function notify(taskId: string): void {
    const task = tasks.tasks.getTask(taskId);
    if (task) publishTasksChanged(bb, taskId, task.projectId);
  }

  function rememberError(source: JiraSource, error: unknown): void {
    tasks.transaction(() => {
      const current = repository.source(source.taskId);
      if (current && current.revision === source.revision)
        repository.save({
          ...current,
          preview: null,
          lastError: safeError(error),
        });
    });
    notify(source.taskId);
  }

  async function readRemote(source: JiraSource): Promise<JiraSnapshot> {
    try {
      return await clientFor(source).snapshot(source.remote.id, [
        ...Object.keys(source.remote.transitionFields),
        ...selectedFields(source.proposal),
      ]);
    } catch (error) {
      rememberError(source, error);
      throw new Error(safeError(error));
    }
  }

  function operationResult(source: JiraSource, stored: StoredOperation) {
    if (stored.taskId !== source.taskId)
      throw new Error("Operation does not belong to this task");
    return { source, operation: stored.receipt };
  }

  function finish(
    taskId: string,
    receipt: JiraOperation,
    remote: JiraSnapshot | null,
  ): JiraSource {
    const result = tasks.transaction(() => {
      const source = repository.source(taskId);
      if (!source)
        throw new Error(
          "Task source was removed while Jira was processing the operation",
        );
      const persisted = repository.operation(receipt.id);
      if (
        persisted?.receipt.state === "applied" ||
        persisted?.receipt.state === "failed"
      )
        return source;
      if (source.operation?.id !== receipt.id)
        throw new Error(
          "The task's current operation changed; refresh its source",
        );
      repository.updateOperation(receipt);
      return repository.save({
        ...source,
        operation: receipt,
        preview: null,
        remote: remote ?? source.remote,
        baseline:
          receipt.state === "applied" && remote ? remote : source.baseline,
        proposal: receipt.state === "applied" ? null : source.proposal,
        lastError: receipt.state === "applied" ? null : receipt.message,
      });
    });
    notify(taskId);
    return result;
  }

  function finishedResult(
    taskId: string,
    receipt: JiraOperation,
    remote: JiraSnapshot | null,
  ) {
    const source = finish(taskId, receipt, remote);
    return {
      source,
      operation: repository.operation(receipt.id)?.receipt ?? receipt,
    };
  }

  const handlers: JiraHandlers = {
    async jiraConnections(input) {
      jiraRpcContract.jiraConnections.input.parse(input);
      const config = configuration();
      if (config.error) throw new Error(config.error);
      return { connections: config.connections.map(publicConnection) };
    },

    async jiraSource(input) {
      const { taskId } = jiraRpcContract.jiraSource.input.parse(input);
      const source = repository.source(taskId);
      if (!source) return { source: null };
      return { source: sourceFor(taskId) };
    },

    async jiraImport(input) {
      const { connectionId, issue, projectId, taskId } =
        jiraRpcContract.jiraImport.input.parse(input);
      const config = connection(connectionId, projectId);
      if (!tasks.tasks.getProject(projectId))
        throw new Error("Project not found");
      if (taskId && tasks.tasks.getTask(taskId)?.projectId !== projectId)
        throw new Error("The selected task does not belong to this project");
      const snapshot = await new JiraClient(config, options.fetch).snapshot(
        issue,
      );
      const result = tasks.transaction(() => {
        connection(connectionId, projectId);
        const existing = repository.byIssue(connectionId, snapshot.id);
        if (existing) {
          if (taskId && existing.taskId !== taskId)
            throw new Error(
              "This Jira issue is already linked to another task",
            );
          const existingTask = tasks.tasks.getTask(existing.taskId);
          if (existingTask?.projectId !== projectId)
            throw new Error(
              "This Jira issue is already linked in another project",
            );
          return { source: sourceFor(existing.taskId), created: false };
        }
        if (taskId) {
          const task = tasks.tasks.getTask(taskId);
          if (!task || task.projectId !== projectId)
            throw new Error(
              "The selected task no longer belongs to this project",
            );
          if (repository.source(taskId))
            throw new Error("The selected task already has a Jira source");
        }
        const task = taskId
          ? tasks.tasks.getTask(taskId)
          : tasks.tasks.createTask({
              projectId,
              title: snapshot.summary,
              description: "",
            });
        if (!task) throw new Error("Task not found");
        repository.insert(task.id, connectionId, snapshot);
        return { source: sourceFor(task.id), created: taskId === null };
      });
      notify(result.source.taskId);
      return result;
    },

    async jiraPull(input) {
      const { taskId, expectedRevision } =
        jiraRpcContract.jiraPull.input.parse(input);
      const source = sourceFor(taskId);
      checkRevision(source, expectedRevision);
      const remote = await readRemote(source);
      const result = tasks.transaction(() => {
        const current = sourceFor(taskId);
        checkRevision(current, expectedRevision);
        return repository.save({
          ...current,
          remote,
          baseline:
            current.proposal ||
            (current.operation &&
              ["sending", "uncertain", "prepared"].includes(
                current.operation.state,
              ))
              ? current.baseline
              : remote,
          preview: null,
          lastError: null,
        });
      });
      notify(taskId);
      return { source: result };
    },

    async jiraDraft(input) {
      const { taskId, expectedRevision, proposal } =
        jiraRpcContract.jiraDraft.input.parse(input);
      const source = tasks.transaction(() => {
        const current = sourceFor(taskId);
        checkRevision(current, expectedRevision);
        checkIdle(current);
        return repository.save({
          ...current,
          baseline:
            current.proposal && proposal ? current.baseline : current.remote,
          proposal,
          preview: null,
          lastError: null,
        });
      });
      notify(taskId);
      return { source };
    },

    async jiraTransitions(input) {
      const { taskId } = jiraRpcContract.jiraTransitions.input.parse(input);
      const source = sourceFor(taskId);
      try {
        const transitions = await clientFor(source).transitions(
          source.remote.id,
        );
        sourceFor(taskId);
        return { transitions };
      } catch (error) {
        rememberError(source, error);
        throw new Error(safeError(error));
      }
    },

    async jiraPreview(input) {
      const { taskId, expectedRevision } =
        jiraRpcContract.jiraPreview.input.parse(input);
      const source = sourceFor(taskId);
      checkRevision(source, expectedRevision);
      checkIdle(source);
      if (!source.proposal)
        throw new Error("Prepare a Jira proposal before previewing");
      const proposal = source.proposal;
      const remote = await readRemote(source);
      const changes = changesFor(source.baseline, remote, source.proposal);
      let reason: string | null = changes.some((change) => change.conflict)
        ? "A selected Jira field changed or its baseline was not captured; clear the proposal, pull, and review before preparing it again"
        : null;
      if (proposal.kind === "transition") {
        try {
          const transitions = await clientFor(source).transitions(remote.id);
          reason =
            transitionProblem(
              transitions,
              proposal,
              matches(remote, proposal),
            ) ?? reason;
        } catch (error) {
          rememberError(source, error);
          throw new Error(safeError(error));
        }
      }
      const preview: JiraPreview = {
        id: randomUUID(),
        revision: expectedRevision + 1,
        createdAt: new Date().toISOString(),
        changes,
        canPush: reason === null,
        reason,
      };
      const result = tasks.transaction(() => {
        const current = sourceFor(taskId);
        checkRevision(current, expectedRevision);
        checkIdle(current);
        return repository.save(
          { ...current, remote, preview, lastError: null },
          snapshotFingerprint(remote),
        );
      });
      notify(taskId);
      return { source: result, preview };
    },

    async jiraPush(input) {
      const { taskId, previewId } = jiraRpcContract.jiraPush.input.parse(input);
      const source = sourceFor(taskId);
      const existing = repository.operationForPreview(previewId);
      if (existing) return operationResult(source, existing);
      checkIdle(source);
      if (
        !source.proposal ||
        !source.preview ||
        source.preview.id !== previewId ||
        source.preview.revision !== source.revision ||
        !source.preview.canPush
      )
        throw new Error(
          "Preview is missing, stale, or conflicted; preview the proposal again",
        );
      const proposal = source.proposal;
      const client = clientFor(source);
      const remote = await readRemote(source);
      const concurrentlyClaimed = repository.operationForPreview(previewId);
      if (concurrentlyClaimed)
        return operationResult(sourceFor(taskId), concurrentlyClaimed);
      if (snapshotFingerprint(remote) !== repository.fingerprint(taskId)) {
        rememberError(
          source,
          new Error(
            "Jira changed after preview; review a fresh preview before pushing",
          ),
        );
        throw new Error(
          "Jira changed after preview; review a fresh preview before pushing",
        );
      }
      if (proposal.kind === "transition") {
        try {
          const transitions = await client.transitions(remote.id);
          const problem = transitionProblem(
            transitions,
            proposal,
            matches(remote, proposal),
          );
          if (problem) throw new Error(problem);
        } catch (error) {
          rememberError(source, error);
          throw new Error(safeError(error));
        }
      }
      const claimed = tasks.transaction(() => {
        const current = sourceFor(taskId);
        const prior = repository.operationForPreview(previewId);
        if (prior)
          return { owner: false, source: current, operation: prior.receipt };
        checkRevision(current, source.revision);
        checkIdle(current);
        if (!current.preview || current.preview.id !== previewId)
          throw new Error("Preview changed; preview again");
        const operation: JiraOperation = {
          id: randomUUID(),
          kind: proposal.kind,
          state: "prepared",
          createdAt: new Date().toISOString(),
          finishedAt: null,
          message: null,
          externalCommentId: null,
        };
        repository.insertOperation(current, current.preview, operation);
        operation.state = "sending";
        repository.updateOperation(operation);
        const saved = repository.save({ ...current, operation, preview: null });
        return { owner: true, source: saved, operation };
      });
      if (!claimed.owner)
        return { source: claimed.source, operation: claimed.operation };
      notify(taskId);
      let operation = claimed.operation;
      let writeAccepted = false;
      try {
        const payload = writeProposal(remote, proposal);
        if (payload) {
          const externalCommentId = await client.write(
            remote.id,
            payload,
            operation.id,
          );
          writeAccepted = true;
          operation = { ...operation, externalCommentId };
          repository.updateOperation(operation);
        } else {
          writeAccepted = true;
        }
        const readback = await client.snapshot(remote.id, [
          ...Object.keys(remote.transitionFields),
          ...selectedFields(proposal),
        ]);
        const commentId =
          proposal.kind === "comment"
            ? await client.findComment(
                remote.id,
                operation.id,
                operation.externalCommentId,
              )
            : null;
        const applied =
          proposal.kind === "comment"
            ? commentId !== null
            : matches(readback, proposal);
        operation = {
          ...operation,
          state: applied ? "applied" : "uncertain",
          finishedAt: applied ? new Date().toISOString() : null,
          externalCommentId: commentId ?? operation.externalCommentId,
          message: applied
            ? "Requested Jira state verified by readback"
            : "Jira accepted the request but the intended result could not be verified; reconcile, do not replay",
        };
        return finishedResult(taskId, operation, readback);
      } catch (error) {
        const rejected =
          !writeAccepted && error instanceof JiraRequestError && error.rejected;
        operation = {
          ...operation,
          state: rejected ? "failed" : "uncertain",
          finishedAt: rejected ? new Date().toISOString() : null,
          message: `${safeError(error)}${rejected ? "; prepare a new preview after correcting the error" : "; outcome unknown: reconcile before any further write"}`,
        };
        return finishedResult(taskId, operation, null);
      }
    },

    async jiraReconcile(input) {
      const { taskId, operationId } =
        jiraRpcContract.jiraReconcile.input.parse(input);
      const source = sourceFor(taskId);
      const stored = repository.operation(operationId);
      if (!stored || stored.taskId !== taskId)
        throw new Error("Operation not found for this task");
      if (
        stored.receipt.state === "applied" ||
        stored.receipt.state === "failed"
      )
        return operationResult(source, stored);
      if (source.operation?.id !== operationId)
        throw new Error("This is not the task's current operation");
      if (stored.receipt.state === "sending")
        return {
          source,
          operation: {
            ...stored.receipt,
            message:
              "The write is still running; wait for its result before reconciling",
          },
        };
      const client = clientFor(source);
      try {
        const remote = await client.snapshot(source.remote.id, [
          ...Object.keys(source.remote.transitionFields),
          ...selectedFields(stored.proposal),
        ]);
        const commentId =
          stored.proposal.kind === "comment"
            ? await client.findComment(
                remote.id,
                operationId,
                stored.receipt.externalCommentId,
              )
            : null;
        const applied =
          stored.proposal.kind === "comment"
            ? commentId !== null
            : matches(remote, stored.proposal);
        sourceFor(taskId);
        const operation: JiraOperation = {
          ...stored.receipt,
          state: applied ? "applied" : "uncertain",
          finishedAt: applied ? new Date().toISOString() : null,
          externalCommentId: commentId ?? stored.receipt.externalCommentId,
          message: applied
            ? "Intended Jira result observed during reconciliation; no request replayed"
            : "Outcome remains unknown; no replay performed. Comment lookup is limited to the latest 500 comments",
        };
        return finishedResult(taskId, operation, remote);
      } catch (error) {
        const operation: JiraOperation = {
          ...stored.receipt,
          state: "uncertain",
          message: `${safeError(error)}; outcome remains unknown; no replay performed`,
        };
        return finishedResult(taskId, operation, null);
      }
    },
  };
  bb.rpc.register(jiraRpcContract, handlers);
  return handlers;
}
