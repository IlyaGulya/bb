import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Db, WorkflowRunRow } from "./data.js";
import { buildEvidenceSchema } from "./build-review-contract.js";

export async function verifyBuildReviewWorkspace(
  bb: BbPluginApi,
  db: Db,
  run: WorkflowRunRow,
): Promise<void> {
  const row = db
    .prepare<[string], { result_json: string | null }>(
      "SELECT result_json FROM workflow_calls WHERE run_id = ? AND call_index = 1",
    )
    .get(run.id);
  if (!row?.result_json)
    throw new Error("Writer has no durable build evidence");
  const build = buildEvidenceSchema.parse(JSON.parse(row.result_json));
  const status = await bb.sdk.environments.status({
    environmentId: run.environmentId,
  });
  if (status.outcome !== "available")
    throw new Error(
      "Authoritative repository status is unavailable; result cannot enter review",
    );
  if (
    status.workspace.checkout.kind !== "branch" ||
    status.workspace.checkout.headSha !== build.commit ||
    status.workspace.checkout.branchName !== build.branch
  )
    throw new Error(
      "Reported branch/commit does not match the authoritative workspace checkout; result cannot enter review",
    );
  if (status.workspace.workingTree.hasUncommittedChanges)
    throw new Error(
      "Workspace contains uncommitted changes; commit/result identity is not stable",
    );
}
