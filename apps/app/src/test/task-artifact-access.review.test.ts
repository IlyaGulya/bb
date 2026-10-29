import { describe, expect, it } from "vitest";
import { z } from "zod";
import { taskArtifactSchema, taskArtifactViewSchema } from "../../../../plugins/tasks/shared/artifacts";
import { tasksRpcContract } from "../../../../plugins/tasks/shared/contract";
import { staticReviewImage, withTaskArtifactReviewFixture, type TaskArtifactReviewFixture } from "./task-artifact-review-fixture";

const attachmentList = z.object({ attachments: z.array(z.object({ id: z.string() })) });
const nativeResult = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
  ])),
});
const ACCESS_CASES = [
  { name: "a different Core project", shared: false, deniedThread: "thr_personal_reader", allowedThread: "thr_work_reader" },
  { name: "a different logical context in the same Core project", shared: true, deniedThread: "thr_shared_personal_reader", allowedThread: "thr_shared_work_reader" },
] as const;

describe.each(ACCESS_CASES)("retained-image access from $name", access => {
  it("does not disclose the retained image through legacy attachment list, but keeps the owner's list usable", async () => withTaskArtifactReviewFixture(async f => {
    const retained = await f.retain(access.shared ? { taskId: f.sharedTask.id, sourceThreadId: "thr_shared_work_source" } : {});
    const denied = await f.harness.runCli(["attachment", "list", retained.saved.taskId, "--json"], { threadId: access.deniedThread });
    if (denied.exitCode === 0) expect(attachmentList.parse(JSON.parse(denied.stdout)).attachments.map(file => file.id)).not.toContain(retained.image.attachmentId);
    const allowed = await f.harness.runCli(["attachment", "list", retained.saved.taskId, "--json"], { threadId: access.allowedThread });
    expect(allowed.exitCode, allowed.stderr).toBe(0);
    expect(attachmentList.parse(JSON.parse(allowed.stdout)).attachments.map(file => file.id)).toContain(retained.image.attachmentId);
  }));

  it("refuses a known retained image ID through legacy attachment get before writing bytes", async () => withTaskArtifactReviewFixture(async f => {
    const retained = await f.retain(access.shared ? { taskId: f.sharedTask.id, sourceThreadId: "thr_shared_work_source" } : {});
    const denied = await f.harness.runCli(["attachment", "get", retained.image.attachmentId, "--out", "denied.png", "--json"], { threadId: access.deniedThread, cwd: f.directory });
    expect(denied.exitCode).not.toBe(0);
    await expect(f.readDownload("denied.png")).rejects.toMatchObject({ code: "ENOENT" });
    const allowed = await f.harness.runCli(["attachment", "get", retained.image.attachmentId, "--out", "allowed.png", "--json"], { threadId: access.allowedThread, cwd: f.directory });
    expect(allowed.exitCode, allowed.stderr).toBe(0);
    expect((await f.readDownload("allowed.png")).equals(await f.readImage(retained.image.attachmentId))).toBe(true);
  }));

  it("withholds native-reader images across context boundaries and supplies actual bytes to the compatible context", async () => withTaskArtifactReviewFixture(async f => {
    const retained = await f.retain(access.shared ? { taskId: f.sharedTask.id, sourceThreadId: "thr_shared_work_source" } : {});
    const denied = nativeResult.parse(await f.harness.callAgentTool("bb_task_artifact_read", { artifactId: retained.saved.id }, { threadId: access.deniedThread }));
    expect(denied.isError).toBe(true);
    expect(denied.content.filter(part => part.type === "image")).toEqual([]);
    const allowed = nativeResult.parse(await f.harness.callAgentTool("bb_task_artifact_read", { artifactId: retained.saved.id }, { threadId: access.allowedThread }));
    expect(allowed.isError).not.toBe(true);
    expect(allowed.content.filter(part => part.type === "image")).toEqual([{ type: "image", data: (await f.readImage(retained.image.attachmentId)).toString("base64"), mimeType: retained.image.mime }]);
  }));
});

it("keeps ordinary unretained same-context attachments and explicit operator recovery usable", async () => withTaskArtifactReviewFixture(async f => {
  const ordinary = await staticReviewImage();
  const attachmentId = await f.upload(f.personalTask.id, ordinary, "ordinary-personal.png");
  const listed = await f.harness.runCli(["attachment", "list", f.personalTask.id, "--json"], { threadId: "thr_personal_reader" });
  expect(listed.exitCode, listed.stderr).toBe(0);
  expect(attachmentList.parse(JSON.parse(listed.stdout)).attachments.map(file => file.id)).toContain(attachmentId);
  const downloaded = await f.harness.runCli(["attachment", "get", attachmentId, "--out", "ordinary.png", "--json"], { threadId: "thr_personal_reader", cwd: f.directory });
  expect(downloaded.exitCode, downloaded.stderr).toBe(0);
  expect((await f.readDownload("ordinary.png")).equals(ordinary.bytes)).toBe(true);
  const retained = await f.retain();
  const operator = await f.harness.runCli(["artifact", "show", f.workTask.id, retained.saved.id, "--context", "Work", "--json"]);
  expect(operator.exitCode, operator.stderr).toBe(0);
  expect(taskArtifactViewSchema.parse(JSON.parse(operator.stdout)).artifact).toEqual(retained.saved);
  const operatorDownload = await f.harness.runCli(["attachment", "get", retained.image.attachmentId, "--out", "operator.png", "--json"], { cwd: f.directory });
  expect(operatorDownload.exitCode, operatorDownload.stderr).toBe(0);
  expect((await f.readDownload("operator.png")).equals(await f.readImage(retained.image.attachmentId))).toBe(true);
}));

async function relocated(
  operation: "move" | "relink",
  run: (fixture: TaskArtifactReviewFixture, retained: Awaited<ReturnType<TaskArtifactReviewFixture["retain"]>>) => Promise<void>,
) {
  await withTaskArtifactReviewFixture(async f => {
    const retained = await f.retain();
    await f.relocate(operation);
    await run(f, retained);
  });
}

describe.each(["move", "relink"] as const)("retained history after task/project %s", operation => {
  it("keeps original pinned Work history discoverable and readable through existing RPC", async () => relocated(operation, async (f, retained) => {
    const listed = taskArtifactSchema.array().parse(await f.harness.callRpc("listTaskArtifacts", f.scope));
    expect(listed).toEqual([retained.saved]);
    const viewed = taskArtifactViewSchema.parse(await f.harness.callRpc("getTaskArtifact", f.target(retained.saved)));
    expect(viewed.artifact).toEqual(retained.saved);
    expect(viewed.sourceStatus).toBe("available");
    expect(viewed.sourceUrl).toBe("/projects/proj_work/threads/thr_work_source#msg=7");
    expect(viewed.artifact.bbProjectId).toBe("proj_work");
    expect(viewed.artifact.executionContextId).toBe("context_work");
  }));

  it("lets the original context and explicitly selected operator recover history through the CLI", async () => relocated(operation, async (f, retained) => {
    const listed = await f.harness.runCli(["artifact", "list", retained.saved.taskId, "--json"], { threadId: "thr_work_reader" });
    expect(listed.exitCode, listed.stderr).toBe(0);
    expect(taskArtifactSchema.array().parse(JSON.parse(listed.stdout))).toEqual([retained.saved]);
    const operator = await f.harness.runCli(["artifact", "show", retained.saved.taskId, retained.saved.id, "--context", "Work", "--json"]);
    expect(operator.exitCode, operator.stderr).toBe(0);
    expect(taskArtifactViewSchema.parse(JSON.parse(operator.stdout)).artifact).toEqual(retained.saved);
  }));

  it("still gives the original compatible agent the retained image rather than stranding it", async () => relocated(operation, async (f, retained) => {
    const result = nativeResult.parse(await f.harness.callAgentTool("bb_task_artifact_read", { artifactId: retained.saved.id }, { threadId: "thr_work_reader" }));
    expect(result.isError).not.toBe(true);
    expect(result.content.filter(part => part.type === "image")).toEqual([{ type: "image", data: (await f.readImage(retained.image.attachmentId)).toString("base64"), mimeType: retained.image.mime }]);
  }));

  it("allows original-scope artifact removal and releases its image reference without reversing the move", async () => relocated(operation, async (f, retained) => {
    const before = await f.readImage(retained.image.attachmentId);
    const blocked = tasksRpcContract.deleteAttachment.output.parse(await f.harness.callRpc("deleteAttachment", { attachmentId: retained.image.attachmentId }));
    expect(blocked).toMatchObject({ ok: false, error: { code: "attachment_referenced" } });
    expect((await f.readImage(retained.image.attachmentId)).equals(before)).toBe(true);
    expect(await f.harness.callRpc("deleteTaskArtifact", f.target(retained.saved))).toEqual({ deleted: true });
    const removed = tasksRpcContract.deleteAttachment.output.parse(await f.harness.callRpc("deleteAttachment", { attachmentId: retained.image.attachmentId }));
    expect(removed).toMatchObject({ ok: true, deleted: true });
    const response = await f.harness.fetchHttp("GET", `/attachments/download?${new URLSearchParams({ attachmentId: retained.image.attachmentId })}`);
    expect(response.status).toBe(404);
  }));

  it("does not relabel original Work evidence as Personal history", async () => relocated(operation, async (f, retained) => {
    const personalScope = { taskId: retained.saved.taskId, executionContextId: "context_personal" };
    expect(taskArtifactSchema.array().parse(await f.harness.callRpc("listTaskArtifacts", personalScope))).toEqual([]);
    await expect(f.harness.callRpc("getTaskArtifact", { ...personalScope, artifactId: retained.saved.id })).rejects.toThrow();
    const result = nativeResult.parse(await f.harness.callAgentTool("bb_task_artifact_read", { artifactId: retained.saved.id }, { threadId: "thr_personal_reader" }));
    expect(result.isError).toBe(true);
    expect(result.content.filter(part => part.type === "image")).toEqual([]);
  }));

  it("still admits a new Personal decision without adopting the task's older Work snapshot", async () => relocated(operation, async (f, retained) => {
    const request = { ...f.request(null, { sourceThreadId: "thr_personal_reader" }), executionContextId: "context_personal", decision: "Retain a new Personal decision" };
    const personal = taskArtifactSchema.parse(await f.harness.callRpc("createTaskArtifact", request));
    expect(personal.bbProjectId).toBe("proj_personal");
    expect(personal.executionContextId).toBe("context_personal");
    const visible = taskArtifactSchema.array().parse(await f.harness.callRpc("listTaskArtifacts", { taskId: retained.saved.taskId, executionContextId: "context_personal" }));
    expect(visible).toEqual([personal]);
    expect(visible.map(artifact => artifact.id)).not.toContain(retained.saved.id);
    expect(personal.source.threadId).toBe("thr_personal_reader");
  }));

  it("does not inherit original retained images through the target context's legacy attachment list", async () => relocated(operation, async (f, retained) => {
    const result = await f.harness.runCli(["attachment", "list", retained.saved.taskId, "--json"], { threadId: "thr_personal_reader" });
    if (result.exitCode === 0) expect(attachmentList.parse(JSON.parse(result.stdout)).attachments.map(file => file.id)).not.toContain(retained.image.attachmentId);
  }));

  it("refuses target-context fallback downloads even when the task now belongs to that context's project", async () => relocated(operation, async (f, retained) => {
    const result = await f.harness.runCli(["attachment", "get", retained.image.attachmentId, "--out", "moved-work.png", "--json"], { threadId: "thr_personal_reader", cwd: f.directory });
    expect(result.exitCode).not.toBe(0);
    await expect(f.readDownload("moved-work.png")).rejects.toMatchObject({ code: "ENOENT" });
  }));
});
