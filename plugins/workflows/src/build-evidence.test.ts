import { describe, expect, it, vi } from "vitest";
import { buildReviewSource } from "./build-review.js";
import type { BuildReviewStart } from "./build-review-contract.js";
import { parseWorkflowSource } from "./parser.js";
import { executeWorkflowScript } from "./runtime.js";

const role = { provider: "fixture", model: "fixture-model", reasoningLevel: "high", permissionMode: "full" as const, serviceTier: null, instructions: "Owned fixture only" };
const request: BuildReviewStart = {
  key: "video-fixture:1", group: "video-fixture", projectId: "proj_fixture", originThreadId: "thr_fixture",
  task: "Explicit video-required result", template: "development-review", writer: role, reviewer: role,
  smokeCommands: ["platform-smoke"], uiRequired: false, feedback: "", evidenceTaskId: "task_fixture",
  evidencePolicy: { version: 1, requirement: "video" },
};

for (const template of ["development-review", "bugfix"] as const) {
  describe(`${template} video-required evidence`, () => {
    it.each(["missing", "screenshot", "preview"] as const)("blocks %s before independent review even after successful technical smoke", async kind => {
      const build = {
        branch: "owned-fixture", commit: "a".repeat(40), diff: "Owned fixture change", regressionCommand: "consumer-regression",
        commands: [
          { command: "reproduce-consumer", exitCode: 0, output: "Original failure now fixed" },
          { command: "consumer-regression", exitCode: 0, output: "Regression succeeded" },
          { command: "platform-smoke", exitCode: 0, output: "Observed expected result" },
        ],
        uiEvidence: kind === "missing" ? [] : [{ kind, location: "https://example.test/preview", description: "Not video" }],
        limitations: [], nextDecision: "Human review",
      };
      const agent = vi.fn()
        .mockResolvedValueOnce(template === "bugfix" ? { summary: "Observed consumer failure", command: "reproduce-consumer", exitCode: 7, output: "Original consumer failure" } : "Plan")
        .mockResolvedValueOnce(build);
      await expect(executeWorkflowScript({
        body: parseWorkflowSource(buildReviewSource({ ...request, template })).body,
        args: { task: request.task, feedback: "", smokeCommands: request.smokeCommands, previousReproduction: null },
        capabilities: { agent, phase() {}, log() {} },
      })).rejects.toThrow(/Video recording is required/);
      expect(agent).toHaveBeenCalledTimes(2);
    });
  });
}
