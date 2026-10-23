import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { Db } from "./data.js";
import type { WorkflowService } from "./service.js";
import {
  managedContextStarted,
  managedRequest,
  managedRunId,
} from "./build-review-policy.js";
import {
  BUILD_REVIEW_POLICY_LIMITATIONS,
  buildReviewResultSchema,
  buildReviewStartSchema,
  buildReviewRpcContract,
  type BuildReviewStart,
} from "./build-review-contract.js";

const string = { type: "string", minLength: 1 };
const strings = { type: "array", items: string };
const buildSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "branch",
    "commit",
    "diff",
    "commands",
    "uiEvidence",
    "limitations",
    "nextDecision",
  ],
  properties: {
    branch: string,
    commit: string,
    diff: string,
    limitations: strings,
    nextDecision: string,
    commands: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["command", "exitCode", "output"],
        properties: {
          command: string,
          exitCode: { type: "integer" },
          output: string,
        },
      },
    },
    uiEvidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "location", "description"],
        properties: {
          kind: { type: "string", enum: ["screenshot", "preview"] },
          location: string,
          description: string,
        },
      },
    },
  },
};
const reviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "findings", "summary"],
  properties: {
    verdict: { type: "string", enum: ["ready", "changes_requested"] },
    findings: strings,
    summary: string,
  },
};

export function buildReviewSource(input: BuildReviewStart): string {
  const options = (role: "writer" | "reviewer", outputSchema: object) =>
    JSON.stringify({
      provider: input[role].provider,
      model: input[role].model,
      reasoningLevel: input[role].reasoningLevel,
      title: role === "writer" ? "Task writer" : "Independent task reviewer",
      outputSchema,
    });
  return `export const meta = { name: "task-build-review", description: "Bounded task plan, one retained writer, platform smoke, independent review", phases: [{title:"Plan"},{title:"Build and platform smoke"},{title:"Independent review"}] };
phase("Plan");
const plan = await agent("Plan this bounded task. Do not change files yet. Return the concrete plan, real platform smoke commands, and acceptance criteria. Task: " + args.task + "\\nHuman return feedback: " + args.feedback, ${options("writer", string)});
phase("Build and platform smoke");
const build = await agent("Continue in this same writer session. Implement the plan and execute the actual platform smoke commands; do not substitute unit tests for platform smoke. Capture exact commands, exit codes and real output. Commit only the owned task changes and report branch, full commit and diff summary. For UI tasks capture screenshot/preview evidence. Do not publish externally or accept the task. Never invent evidence. Task: " + args.task + "\\nPlan: " + plan + "\\nRequired smoke commands: " + JSON.stringify(args.smokeCommands) + "\\nUI evidence required: " + args.uiRequired + "\\nHuman feedback: " + args.feedback, ${options("writer", buildSchema)});
if (build.commands.some(c => c.exitCode !== 0)) throw new Error("Platform smoke failed; task remains unaccepted");
if (args.smokeCommands.some(command => !build.commands.some(c => c.command === command))) throw new Error("Missing required real smoke command evidence");
if (args.uiRequired && build.uiEvidence.length === 0) throw new Error("UI screenshot or preview evidence is required");
phase("Independent review");
const review = await agent("Independently inspect the actual repository changes and smoke evidence against the task. Do not modify files, commit, publish, delegate or accept the task. These are role instructions, NOT a read-only security sandbox. Report defects and limitations honestly. Task: " + args.task + "\\nPlan: " + plan + "\\nBuild evidence: " + JSON.stringify(build), ${options("reviewer", reviewSchema)});
return { plan, build, review };`;
}

export function registerBuildReview(
  bb: BbPluginApi,
  db: Db,
  service: WorkflowService,
) {
  function inspect(key: string) {
    const id = managedRunId(db, key);
    const run = id ? service.inspect(id) : null;
    if (!run) return null;
    const request = managedRequest(db, run.id)!;
    const parsed =
      run.resultJson === null
        ? null
        : buildReviewResultSchema.parse(JSON.parse(run.resultJson));
    const workers = db
      .prepare<[string], { threadId: string; role: "writer" | "reviewer" }>(
        "SELECT thread_id AS threadId, role FROM workflow_build_review_workers WHERE group_key = ?",
      )
      .all(request.group)
      .map((worker) => ({
        ...worker,
        callIndex: worker.role === "writer" ? 1 : 2,
      }));
    return {
      runId: run.id,
      key: request.key,
      contextStarted: managedContextStarted(db, request.group),
      status: run.status,
      phase: run.phase,
      error: run.error,
      result: parsed,
      workers,
      policyLimitations: BUILD_REVIEW_POLICY_LIMITATIONS,
    };
  }
  const handlers: PluginRpcHandlers<typeof buildReviewRpcContract> = {
    async startBuildReview(input) {
      if (
        input.writer.provider === input.reviewer.provider &&
        input.writer.model === input.reviewer.model
      )
        throw new Error(
          "Independent review requires another allowed runtime/provider or model",
        );
      const existing = managedRunId(db, input.key);
      if (existing) {
        if (
          JSON.stringify(managedRequest(db, existing)) !== JSON.stringify(input)
        )
          throw new Error("Launch key already has different input");
        return inspect(input.key)!;
      }
      const group = db
        .prepare<
          [string],
          { request_json: string; status: string; released: number }
        >(
          "SELECT r.request_json, w.status, r.released FROM workflow_build_reviews r JOIN workflow_runs w ON w.id = r.run_id WHERE r.group_key = ? ORDER BY w.created_at DESC LIMIT 1",
        )
        .get(input.group);
      if (group) {
        const previous = buildReviewStartSchema.parse(
          JSON.parse(group.request_json),
        );
        if (group.released)
          throw new Error("Accepted workflow context was released");
        if (["queued", "running"].includes(group.status))
          throw new Error("Workflow group already has active work");
        if (
          previous.originThreadId !== input.originThreadId ||
          previous.projectId !== input.projectId
        )
          throw new Error("Return must retain the same origin and workspace");
        if (
          managedContextStarted(db, input.group) &&
          (JSON.stringify(previous.writer) !== JSON.stringify(input.writer) ||
            JSON.stringify(previous.reviewer) !==
              JSON.stringify(input.reviewer))
        )
          throw new Error(
            "Return must retain the execution profiles of the existing writer/context",
          );
        if (!input.feedback.trim())
          throw new Error("Return requires explicit human feedback");
      }
      await service.start({
        projectId: input.projectId,
        originThreadId: input.originThreadId,
        source: buildReviewSource(input),
        args: {
          task: input.task,
          smokeCommands: input.smokeCommands,
          uiRequired: input.uiRequired,
          feedback: input.feedback,
        },
        resumedFromRunId: null,
        buildReview: input,
      });
      return inspect(input.key)!;
    },
    inspectBuildReview: ({ key }) => inspect(key),
    releaseBuildReviewContexts({ groups }) {
      return db.transaction(() => {
        const active = db.prepare(
          "SELECT 1 FROM workflow_build_reviews r JOIN workflow_runs w ON w.id = r.run_id WHERE r.group_key = ? AND w.status IN ('queued', 'running')",
        );
        for (const group of groups) {
          if (active.get(group))
            throw new Error(
              "Cannot release active workflow workers; no contexts in this deletion set were released",
            );
        }
        const release = db.prepare(
          "UPDATE workflow_build_reviews SET released = 1 WHERE group_key = ?",
        );
        let released = false;
        for (const group of groups) {
          if (release.run(group).changes > 0) released = true;
        }
        return { released };
      })();
    },
  };
  bb.rpc.register(buildReviewRpcContract, handlers);
  return handlers;
}
