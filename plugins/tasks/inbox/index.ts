import { createHash, randomUUID } from "node:crypto";
import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { TasksApiStore } from "../api/index.js";
import { inboxRpcContract } from "../shared/inbox-contract.js";
import { errorMessage } from "../shared/errors.js";
import { InboxStore, type InboxSource } from "./store.js";
import { buildReviewInspectionSchema } from "../../workflows/src/build-review-contract.js";
import { linkTaskFromInbox, createTaskFromInbox } from "./actions.js";

export type InboxHandlers = PluginRpcHandlers<typeof inboxRpcContract>;
type WorkingItem = z.infer<
  typeof inboxRpcContract.listWorking.output
>["items"][number];
interface Snapshot {
  items: WorkingItem[];
  warnings: string[];
}
export function registerInbox(
  bb: BbPluginApi,
  store: TasksApiStore,
  options: { now?: () => string; background?: boolean } = {},
): InboxHandlers {
  const db = store.database;
  const inbox = new InboxStore(db, options.now);
  const publish = (id: string) => bb.realtime.publish("inbox:changed", { id });
  const upsert = (source: InboxSource) => {
    const result = inbox.upsert(source);
    if (result.changed) publish(result.item.id);
    return result;
  };
  let inFlight: Promise<Snapshot> | null = null;
  async function reconcile(): Promise<Snapshot> {
    for (const id of inbox.wake()) publish(id);
    const warnings: string[] = [];
    const items: WorkingItem[] = [];
    const seen = new Set<string>();
    const checkedInteractions = new Set<string>();
    const checkedFailures = new Set<string>();
    const retired = new Set(
      db
        .prepare<[], { source_thread_id: string }>(
          "SELECT source_thread_id FROM task_continuations WHERE state = 'started' AND thread_id IS NOT NULL",
        )
        .all()
        .map((row) => row.source_thread_id),
    );
    for (const threadId of retired) {
      checkedInteractions.add(threadId);
      checkedFailures.add(threadId);
    }
    const workflowViews = db
      .prepare<
        [],
        {
          id: string;
          taskId: string;
          revision: number;
          state: string;
          error: string | null;
          workersJson: string | null;
        }
      >(`SELECT id, task_id AS taskId, revision, state,
      json_extract(view_json, '$.error') AS error,
      json_extract(view_json, '$.native.workers') AS workersJson
      FROM task_workflow_runs WHERE state <> 'accepted'`)
      .all()
      .map((row) => ({
        ...row,
        workers: buildReviewInspectionSchema.shape.workers.parse(
          JSON.parse(row.workersJson ?? "[]"),
        ),
      }));
    const linked = db
      .prepare<
        [],
        {
          task_id: string;
          thread_id: string;
          live_status: string;
          executor_rank: number;
        }
      >(
        `SELECT tt.task_id, tt.thread_id, tt.live_status,
        ROW_NUMBER() OVER (PARTITION BY tt.task_id ORDER BY tt.attached_at DESC, tt.rowid DESC) AS executor_rank
      FROM task_threads tt JOIN tasks t ON t.id = tt.task_id
      WHERE NOT EXISTS (SELECT 1 FROM task_continuations c
        WHERE c.source_thread_id = tt.thread_id AND c.state = 'started' AND c.thread_id IS NOT NULL)
      ORDER BY CASE WHEN t.status IN ('done', 'canceled') THEN 1 ELSE 0 END, executor_rank, tt.task_id`,
      )
      .all();
    for (const workflow of workflowViews) {
      for (const worker of workflow.workers) {
        if (
          linked.some(
            (link) =>
              link.task_id === workflow.taskId &&
              link.thread_id === worker.threadId,
          )
        )
          continue;
        linked.push({
          task_id: workflow.taskId,
          thread_id: worker.threadId,
          live_status: workflow.state === "running" ? "working" : "idle",
          executor_rank: 0,
        });
      }
    }
    const currentExecutors = new Map(
      linked
        .filter((link) => link.executor_rank === 1)
        .map((link) => [link.task_id, link.thread_id]),
    );
    for (const workflow of workflowViews) {
      const writer = workflow.workers.find(
        (worker) => worker.role === "writer",
      );
      if (writer && workflow.state === "in_review")
        currentExecutors.set(workflow.taskId, writer.threadId);
      if (!workflow.error && workflow.state !== "failed") continue;
      const task = store.tasks.getTask(workflow.taskId);
      if (!task || ["done", "canceled"].includes(task.status)) continue;
      const sourceKey = workflow.id;
      seen.add(`task_workflow:${sourceKey}`);
      upsert({
        sourceKind: "task_workflow",
        sourceKey,
        revision: `${workflow.revision}:${createHash("sha256")
          .update(workflow.error ?? workflow.state)
          .digest("hex")}`,
        title: `${task.key}: workflow needs attention`,
        body: `${workflow.error ?? "Workflow failed before producing a reviewable result."}\n\nOpen the task's Build → review card. Failed runs can be returned with concrete feedback; launch errors retry the same durable launch receipt after their prerequisite is repaired. No new writer replaces an existing session.`,
        context: inbox.taskContext(task.id),
        lane: "needs_input",
        reason:
          workflow.state === "launching"
            ? "Workflow launch is blocked; no completed result"
            : "Workflow requires correction before human review",
        active: true,
        taskId: task.id,
        threadId: writer?.threadId ?? null,
      });
    }
    const running = new Set<string>();
    if (linked.length > 0) {
      try {
        for (const thread of await bb.sdk.threads.listRunning())
          running.add(thread.id);
      } catch (error) {
        warnings.push(
          `Native running-thread discovery unavailable (${errorMessage(error)})`,
        );
      }
    }
    const reviews = db
      .prepare<[], { id: string }>(
        "SELECT id FROM tasks WHERE status = 'in_review'",
      )
      .all();
    for (const { id } of reviews) {
      const task = store.tasks.getTask(id)!;
      const threadId = currentExecutors.get(id) ?? null;
      const latest = store.tasks
        .listComments(id)
        .filter(
          (comment) =>
            comment.kind === "agent" &&
            (!comment.threadId || comment.threadId === threadId),
        )
        .at(-1);
      const previous = db
        .prepare<[string], { revision: string; active: number }>(
          "SELECT revision, active FROM inbox_entries WHERE source_kind = 'task_review' AND source_key = ?",
        )
        .get(id);
      const attachments = store.tasks
        .listAttachmentsForTask(id)
        .map((attachment) => attachment.id);
      const resultAttachments = latest
        ? store.tasks
            .listAttachmentsForComment(latest.id)
            .map((attachment) => attachment.id)
        : [];
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify([
            task.title,
            task.description,
            latest?.id,
            latest?.body,
            threadId,
            attachments,
            resultAttachments,
          ]),
        )
        .digest("hex");
      const episode = previous?.active
        ? previous.revision.split(":")[1]
        : randomUUID();
      const source: InboxSource = {
        sourceKind: "task_review",
        sourceKey: id,
        revision: `${fingerprint}:${episode}`,
        title: `${task.key}: ${task.title}`,
        body: latest?.body ?? task.description,
        context: inbox.taskContext(id),
        lane: "review",
        reason: "Task is in review — acceptance is still yours",
        active: true,
        taskId: id,
        threadId,
      };
      seen.add(`task_review:${id}`);
      upsert(source);
    }
    const inspected = new Set<string>();
    for (const link of linked) {
      const task = store.tasks.getTask(link.task_id);
      if (!task || inspected.has(link.thread_id)) continue;
      inspected.add(link.thread_id);
      const context = inbox.taskContext(task.id);
      const currentFailureCandidate =
        link.executor_rank === 1 &&
        task.status !== "done" &&
        task.status !== "canceled";
      if (!currentFailureCandidate) checkedFailures.add(link.thread_id);
      if (link.live_status === "completed" && !running.has(link.thread_id)) {
        checkedInteractions.add(link.thread_id);
        checkedFailures.add(link.thread_id);
        continue;
      }
      let pending = false;
      try {
        const interactions = await bb.sdk.threads.interactions.list({
          threadId: link.thread_id,
        });
        checkedInteractions.add(link.thread_id);
        for (const interaction of interactions) {
          if (
            interaction.status !== "pending" &&
            interaction.status !== "resolving"
          )
            continue;
          pending = true;
          seen.add(`native_interaction:${interaction.id}`);
          const title =
            "title" in interaction.payload
              ? interaction.payload.title
              : interaction.payload.kind === "user_question"
                ? (interaction.payload.questions[0]?.prompt ?? "Agent question")
                : "Agent approval";
          upsert({
            sourceKind: "native_interaction",
            sourceKey: interaction.id,
            revision: interaction.id,
            title: `${task.key}: ${title}`,
            body: "Answer or approve in the original interactive thread. Resolving this inbox reminder does not answer the agent.",
            context,
            active: true,
            taskId: task.id,
            threadId: link.thread_id,
            lane: "needs_input",
            reason:
              interaction.status === "resolving"
                ? "Native response is being applied"
                : "Native question or approval awaits your response",
          });
        }
      } catch (error) {
        warnings.push(
          `${task.key} · ${link.thread_id}: native questions unavailable (${errorMessage(error)})`,
        );
      }
      if (
        !currentFailureCandidate &&
        !pending &&
        !running.has(link.thread_id) &&
        link.live_status !== "starting" &&
        link.live_status !== "working"
      )
        continue;
      let thread;
      try {
        thread = await bb.sdk.threads.get({ threadId: link.thread_id });
      } catch (error) {
        warnings.push(
          `${task.key} · ${link.thread_id}: native thread state unavailable (${errorMessage(error)})`,
        );
        continue;
      }
      if (
        currentFailureCandidate &&
        thread.deletedAt === null &&
        thread.status === "error"
      ) {
        try {
          const [event] = await bb.sdk.threads.events.list({
            threadId: thread.id,
            order: "desc",
            limit: "1",
            types: [
              "system/error",
              "client/turn/requested",
              "client/turn/rejected",
            ],
          });
          if (!event) {
            warnings.push(
              `${task.key} · ${thread.id}: native failure attempt unavailable; inspect the thread`,
            );
          } else {
            checkedFailures.add(thread.id);
            seen.add(`native_failure:${thread.id}`);
            upsert({
              sourceKind: "native_failure",
              sourceKey: thread.id,
              revision: `${event.id}:${event.seq}`,
              title: `${task.key}: agent needs attention`,
              body:
                event.type === "system/error"
                  ? event.data.message
                  : "The current native execution attempt failed. Open the thread to inspect and choose whether to resume.",
              context,
              active: true,
              taskId: task.id,
              threadId: thread.id,
              lane: "needs_input",
              reason: "Current native execution failed; not a pending question",
            });
          }
        } catch (error) {
          warnings.push(
            `${task.key} · ${thread.id}: native failure attempt unavailable (${errorMessage(error)})`,
          );
        }
      } else {
        checkedFailures.add(thread.id);
      }
      if (
        !pending &&
        checkedInteractions.has(thread.id) &&
        thread.deletedAt === null &&
        ["pending", "starting", "active", "stopping"].includes(thread.status)
      ) {
        items.push({
          taskId: task.id,
          taskKey: task.key,
          title: task.title,
          threadId: thread.id,
          status:
            thread.status === "pending" || thread.status === "starting"
              ? "starting"
              : "working",
          context,
        });
      }
    }
    for (const item of inbox.nativeEntries()) {
      if (seen.has(`${item.sourceKind}:${item.sourceKey}`)) continue;
      const checked =
        item.sourceKind === "task_review" ||
        item.sourceKind === "task_workflow" ||
        item.taskId === null ||
        !linked.some(
          (link) =>
            link.task_id === item.taskId && link.thread_id === item.threadId,
        ) ||
        (item.threadId !== null &&
          (item.sourceKind === "native_interaction"
            ? checkedInteractions
            : checkedFailures
          ).has(item.threadId));
      if (checked) upsert({ ...item, active: false });
    }
    return { items, warnings };
  }
  function refresh(): Promise<Snapshot> {
    if (!inFlight)
      inFlight = reconcile().finally(() => {
        inFlight = null;
      });
    return inFlight;
  }
  const handlers: InboxHandlers = {
    async listInbox(raw) {
      const input = inboxRpcContract.listInbox.input.parse(raw);
      const snapshot = await refresh();
      return {
        items: inbox.list(input.state, input.context),
        warnings: snapshot.warnings,
      };
    },
    async listWorking() {
      return refresh();
    },
    createInbox(raw) {
      const input = inboxRpcContract.createInbox.input.parse(raw);
      return {
        item: upsert({
          ...input,
          sourceKind: "manual",
          sourceKey: randomUUID(),
          revision: "1",
          active: true,
          lane: "new",
          reason: "Manual incoming — not yet a task",
        }).item,
      };
    },
    upsertInboxSource(raw) {
      const input = inboxRpcContract.upsertInboxSource.input.parse(raw);
      return upsert({
        ...input,
        lane: "new",
        reason: `Source attention: ${input.sourceKind}`,
      });
    },
    decideInbox(raw) {
      const input = inboxRpcContract.decideInbox.input.parse(raw);
      const before = inbox.get(input.id);
      const item = inbox.decide(input.id, input.action, input.until);
      if (
        before.state !== item.state ||
        before.snoozedUntil !== item.snoozedUntil
      )
        publish(item.id);
      return { item };
    },
    linkInboxTask(raw) {
      const input = inboxRpcContract.linkInboxTask.input.parse(raw);
      return linkTaskFromInbox(bb, store, inbox, input.id, input.taskId);
    },
    createInboxTask(raw) {
      const input = inboxRpcContract.createInboxTask.input.parse(raw);
      return createTaskFromInbox(bb, store, inbox, input.id, input.projectId);
    },
    inboxHistory(raw) {
      const input = inboxRpcContract.inboxHistory.input.parse(raw);
      return { decisions: inbox.history(input.id) };
    },
  };
  bb.rpc.register(inboxRpcContract, handlers);
  if (options.background !== false) {
    const tick = () => {
      void refresh().catch((error: unknown) =>
        bb.log.warn(`Inbox reconciliation unavailable: ${errorMessage(error)}`),
      );
    };
    const timer = setInterval(tick, 15000);
    timer.unref?.();
    bb.onDispose(async () => {
      clearInterval(timer);
      await inFlight?.catch(() => undefined);
    });
    bb.events.on("interaction.pending", tick);
    bb.events.on("thread.active", tick);
    bb.events.on("thread.idle", tick);
    bb.events.on("thread.failed", tick);
    bb.events.on("thread.deleted", tick);
    tick();
  }
  return handlers;
}
