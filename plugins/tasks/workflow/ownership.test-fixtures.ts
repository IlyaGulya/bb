import type { TasksApiStore } from "../api/index.js";
import type { BuildReviewStart } from "./remote-contract.js";
import type { TaskWorkflow } from "../shared/workflow-contract.js";
import { TaskWorkflowStore } from "./store.js";

export const HELD_WORKFLOW_STATES = ["sending", "uncertain", "queued", "in_review"] as const;

export function seedWorkflowOwnership(
  store: TasksApiStore,
  taskId: string,
  projectId: string,
  state: typeof HELD_WORKFLOW_STATES[number] | "released",
) {
  const task = store.tasks.getTask(taskId);
  if (!task) throw new Error("Missing owned test task");
  const profile = {
    provider: "acp-omp", model: "bb-cpa/personal-codex/gpt-6.1-sol",
    executionContextId: "owned-context", modelConnectionId: "owned-account",
    reasoningLevel: "high", permissionMode: "full" as const,
    serviceTier: null, instructions: "Owned role",
  };
  const request: BuildReviewStart = {
    key: "owned-workflow:1", group: "owned-workflow", projectId,
    originThreadId: "thr_ownedpreparedcontext", task: task.title,
    template: "development-review", writer: profile,
    reviewer: { ...profile, instructions: "Independent fresh reviewer" },
    smokeCommands: ["owned-platform-smoke"], uiRequired: false, feedback: "",
  };
  const workflows = new TaskWorkflowStore(store);
  const created = workflows.create("owned-preparation", taskId, request, JSON.stringify({ taskId, preparationId: "owned-preparation" }));
  if (state === "uncertain") workflows.save({ ...created, error: "Native Start acknowledgement lost; ownership retained" });
  if (state === "queued") workflows.publish(request.group, {
    runId: "owned-native-run", key: request.key, contextStarted: false,
    status: "queued", phase: null, error: null, result: null, workers: [], policyLimitations: [],
  });
  if (state === "in_review" || state === "released") {
    const native: NonNullable<TaskWorkflow["native"]> = {
      runId: "owned-native-run", key: request.key, contextStarted: true,
      status: "succeeded", phase: "Independent review", error: null,
      workers: [
        { role: "writer", threadId: "thr_ownedretainedwriter", callIndex: 1 },
        { role: "reviewer", threadId: "thr_ownedretainedreviewer", callIndex: 2 },
      ],
      result: {
        plan: "Owned consumer change",
        build: {
          branch: "owned-workflow", commit: "a".repeat(40), diff: "Owned consumer fix",
          commands: [{ command: "owned-platform-smoke", exitCode: 0, output: "Owned fixture result" }],
          uiEvidence: [], limitations: [], nextDecision: "Human Accept or Return",
        },
        review: { verdict: "ready", findings: [], summary: "Owned independent review" },
      },
      policyLimitations: [],
    };
    workflows.publish(request.group, native);
    for (const worker of native.workers) store.tasks.upsertTaskThread({
      taskId, threadId: worker.threadId, presetName: worker.role,
      title: worker.role, liveStatus: "idle",
    });
    if (state === "released") {
      workflows.accept(request.group, 1);
      store.database.prepare("UPDATE task_workflow_runs SET released = 1 WHERE id = ?").run(request.group);
      store.tasks.updateTask(taskId, { status: "todo" });
    }
  }
  return { request, workflows, view: workflows.get(request.group) };
}
