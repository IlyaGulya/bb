import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { z } from "zod";
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
  if (input.template === "bugfix") {
    const reproductionSchema = { type: "object", additionalProperties: false, required: ["summary", "command", "exitCode", "output"], properties: { summary: string, command: string, exitCode: { type: "integer" }, output: string } };
    const fixSchema = { ...buildSchema, required: [...buildSchema.required, "regressionCommand"], properties: { ...buildSchema.properties, regressionCommand: string } };
    return `export const meta = { name: "task-bugfix-review", description: "Real reproduction, retained writer fix and regression, platform smoke, independent review", phases: [{title:"Reproduce"},{title:"Fix, regression and platform smoke"},{title:"Independent review"}] };
phase("Reproduce");
const reproduction = await agent((args.previousReproduction ? "This is a human Return in the SAME retained writer session. Preserve the original genuine failing-before command, nonzero exit code and exact output below; do not pretend the already-fixed bug must fail again. Re-plan the requested changes in summary, retaining the original reproduction fields unchanged. Original evidence: " + JSON.stringify(args.previousReproduction) : "Reproduce the reported bug in this owned workspace BEFORE changing implementation. Run the real failing command and record its exact command, nonzero exit code, observed output and concise root-cause/repair plan. Do not claim a reproduction from source inspection alone. If this cannot be reproduced, stop honestly.") + " Task: " + args.task + "\\nHuman feedback: " + args.feedback, ${options("writer", reproductionSchema)});
if (reproduction.exitCode === 0) throw new Error("Bugfix requires genuine failing-before reproduction evidence");
if (args.previousReproduction && (reproduction.command !== args.previousReproduction.command || reproduction.exitCode !== args.previousReproduction.exitCode || reproduction.output !== args.previousReproduction.output)) throw new Error("Return must retain the original genuine reproduction evidence");
const plan = JSON.stringify(reproduction);
phase("Fix, regression and platform smoke");
const fixed = await agent("Continue in this SAME retained writer session. Fix the reproduced bug, add a meaningful consumer regression, run that regression and rerun the EXACT failing-before command to prove passing-after, then execute every required platform smoke command. Report regressionCommand as an executed command in commands. Include exact exit codes and observed output. Commit only owned changes; no publishing or acceptance. Task: " + args.task + "\\nReproduction: " + plan + "\\nRequired smoke: " + JSON.stringify(args.smokeCommands) + "\\nUI evidence required: " + args.uiRequired + "\\nHuman feedback: " + args.feedback, ${options("writer", fixSchema)});
if (fixed.commands.some(c => c.exitCode !== 0)) throw new Error("Fix/regression/platform smoke failed");
if (!fixed.commands.some(c => c.command === reproduction.command && c.exitCode === 0)) throw new Error("Missing passing-after evidence for the original reproduction");
if (!fixed.commands.some(c => c.command === fixed.regressionCommand && c.exitCode === 0)) throw new Error("Missing executed consumer regression evidence");
if (args.smokeCommands.some(command => !fixed.commands.some(c => c.command === command))) throw new Error("Missing required real smoke command evidence");
if (args.uiRequired && fixed.uiEvidence.length === 0) throw new Error("UI screenshot or preview evidence is required");
const build = fixed;
phase("Independent review");
const review = await agent("Independently inspect the actual fix and consumer regression against the original failing-before and passing-after evidence, actual repository and smoke output. Do not modify files, commit, publish, delegate or accept. Instructions are NOT a read-only security sandbox. Task: " + args.task + "\\nReproduction: " + plan + "\\nBuild: " + JSON.stringify(build), ${options("reviewer", reviewSchema)});
return { plan, build, review };`;
  }
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
        if (previous.template !== input.template) throw new Error("Return must retain the same workflow template");
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
      const priorEvidence = input.template === "bugfix" && group ? db.prepare<[string], { result_json: string }>(
        "SELECT c.result_json FROM workflow_calls c JOIN workflow_build_reviews r ON r.run_id = c.run_id JOIN workflow_runs w ON w.id = c.run_id WHERE r.group_key = ? AND c.call_index = 0 AND c.status = 'succeeded' AND c.result_json IS NOT NULL ORDER BY w.created_at DESC LIMIT 1",
      ).get(input.group) : undefined;
      const previousReproduction = priorEvidence ? z.object({ summary: z.string().min(1), command: z.string().min(1), exitCode: z.number().int().refine(code => code !== 0), output: z.string().min(1) }).strict().parse(JSON.parse(priorEvidence.result_json)) : null;
      await service.start({
        projectId: input.projectId,
        originThreadId: input.originThreadId,
        source: buildReviewSource(input),
        args: {
          task: input.task,
          smokeCommands: input.smokeCommands,
          uiRequired: input.uiRequired,
          feedback: input.feedback,
          previousReproduction,
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
