import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TaskArtifactStore } from "../../../../plugins/tasks/artifacts/store";
import { tasksRpcContract } from "../../../../plugins/tasks/shared/contract";
import { staticReviewImage, withTaskArtifactReviewFixture } from "./task-artifact-review-fixture";

const shownTask = z.object({
  task: z.object({ id: z.string(), projectId: z.string(), title: z.string() }),
  attachments: z.array(z.object({ id: z.string(), fileName: z.string() })),
});

const nativeResult = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.string() }).passthrough()),
});

describe.each(["move", "relink"] as const)("partial retained access after %s", operation => {
  it("shows the permitted task and ordinary attachments without disclosing its historical retained image", async () => withTaskArtifactReviewFixture(async fixture => {
    const retained = await fixture.retain();
    const task = await fixture.relocate(operation);
    const ordinary = await staticReviewImage();
    const ordinaryId = await fixture.upload(task.id, ordinary, "personal-control.png");
    const denied = await fixture.harness.runCli([
      "attachment", "get", retained.image.attachmentId, "--out", "still-private.png", "--json",
    ], { threadId: "thr_personal_reader", cwd: fixture.directory });
    expect(denied.exitCode).not.toBe(0);
    await expect(fixture.readDownload("still-private.png")).rejects.toMatchObject({ code: "ENOENT" });
    const shown = await fixture.harness.runCli(["show", task.id, "--json"], { threadId: "thr_personal_reader" });
    expect(shown.exitCode, shown.stderr).toBe(0);
    const result = shownTask.parse(JSON.parse(shown.stdout));
    expect(result.task).toMatchObject({ id: task.id, projectId: task.projectId, title: task.title });
    expect(result.attachments.map(file => file.id)).toContain(ordinaryId);
    expect(result.attachments.map(file => file.id)).not.toContain(retained.image.attachmentId);
    const download = await fixture.harness.runCli([
      "attachment", "get", ordinaryId, "--out", "personal-control.png", "--json",
    ], { threadId: "thr_personal_reader", cwd: fixture.directory });
    expect(download.exitCode, download.stderr).toBe(0);
    expect((await fixture.readDownload("personal-control.png")).equals(ordinary.bytes)).toBe(true);
  }));
});

it("keeps operator attachment enumeration usable after one original context is revoked", async () => withTaskArtifactReviewFixture(async fixture => {
  const retained = await fixture.retain();
  const task = await fixture.relocate("move");
  const ordinary = await staticReviewImage();
  const ordinaryId = await fixture.upload(task.id, ordinary, "operator-control.png");
  const before = tasksRpcContract.listAttachments.output.parse(await fixture.harness.callRpc("listAttachments", { taskId: task.id }));
  expect(before.attachments.map(file => file.id)).toEqual(expect.arrayContaining([retained.image.attachmentId, ordinaryId]));
  const original = fixture.contexts.get("context_work");
  if (!original) throw new Error("Original synthetic context is missing");
  original.enabled = false;
  const blocked = await fixture.harness.fetchHttp("GET", `/attachments/download?${new URLSearchParams({ attachmentId: retained.image.attachmentId })}`);
  expect(blocked.status).toBe(404);
  const taskResult = tasksRpcContract.getTask.output.parse(await fixture.harness.callRpc("getTask", { taskId: task.id }));
  expect(taskResult.task).toMatchObject({ id: task.id, title: task.title });
  const listed = tasksRpcContract.listAttachments.output.parse(await fixture.harness.callRpc("listAttachments", { taskId: task.id }));
  expect(listed.attachments.map(file => file.id)).toContain(ordinaryId);
  expect(listed.attachments.map(file => file.id)).not.toContain(retained.image.attachmentId);
  expect((await fixture.readImage(ordinaryId)).equals(ordinary.bytes)).toBe(true);
}));

it("allows an operator to erase one retained artifact after its original context is deleted without deleting its task", async () => withTaskArtifactReviewFixture(async fixture => {
  const retained = await fixture.retain();
  const taskBefore = fixture.store.tasks.getTask(retained.saved.taskId);
  fixture.contexts.delete("context_work");
  const denied = nativeResult.parse(await fixture.harness.callAgentTool("bb_task_artifact_read", { artifactId: retained.saved.id }, { threadId: "thr_work_reader" }));
  expect(denied.isError).toBe(true);
  expect(denied.content.filter(part => part.type === "image")).toEqual([]);
  const blockedImage = await fixture.harness.fetchHttp("GET", `/attachments/download?${new URLSearchParams({ attachmentId: retained.image.attachmentId })}`);
  expect(blockedImage.status).toBe(404);
  expect(await fixture.harness.callRpc("deleteTaskArtifact", fixture.target(retained.saved))).toEqual({ deleted: true });
  expect(new TaskArtifactStore(fixture.store).get(retained.saved.id)).toBeNull();
  expect(fixture.store.tasks.getTask(retained.saved.taskId)).toEqual(taskBefore);
  expect(fixture.store.tasks.getAttachment(retained.image.attachmentId)?.id).toBe(retained.image.attachmentId);
  const removed = tasksRpcContract.deleteAttachment.output.parse(await fixture.harness.callRpc("deleteAttachment", { attachmentId: retained.image.attachmentId }));
  expect(removed).toMatchObject({ ok: true, deleted: true });
  const missingImage = await fixture.harness.fetchHttp("GET", `/attachments/download?${new URLSearchParams({ attachmentId: retained.image.attachmentId })}`);
  expect(missingImage.status).toBe(404);
  expect(fixture.store.tasks.getTask(retained.saved.taskId)).toEqual(taskBefore);
}));

it("allows explicit operator CLI erasure after read permission is revoked without reopening retained bytes", async () => withTaskArtifactReviewFixture(async fixture => {
  const retained = await fixture.retain();
  const taskBefore = fixture.store.tasks.getTask(retained.saved.taskId);
  const original = fixture.contexts.get("context_work");
  if (!original) throw new Error("Original synthetic context is missing");
  original.enabled = false;
  const denied = await fixture.harness.runCli([
    "attachment", "get", retained.image.attachmentId, "--out", "revoked.png", "--json",
  ], { cwd: fixture.directory });
  expect(denied.exitCode).not.toBe(0);
  await expect(fixture.readDownload("revoked.png")).rejects.toMatchObject({ code: "ENOENT" });
  const removed = await fixture.harness.runCli([
    "artifact", "remove", retained.saved.taskId, retained.saved.id, "--context", "Work", "--json",
  ]);
  expect(removed.exitCode, removed.stderr).toBe(0);
  expect(JSON.parse(removed.stdout)).toEqual({ deleted: true });
  expect(new TaskArtifactStore(fixture.store).get(retained.saved.id)).toBeNull();
  expect(fixture.store.tasks.getTask(retained.saved.taskId)).toEqual(taskBefore);
}));

it("keeps whole-task erasure as a positive control when the original context has been deleted", async () => withTaskArtifactReviewFixture(async fixture => {
  const retained = await fixture.retain();
  fixture.contexts.delete("context_work");
  const result = tasksRpcContract.deleteTask.output.parse(await fixture.harness.callRpc("deleteTask", { taskId: retained.saved.taskId }));
  expect(result).toEqual({ deleted: true });
  expect(fixture.store.tasks.getTask(retained.saved.taskId)).toBeUndefined();
  expect(new TaskArtifactStore(fixture.store).get(retained.saved.id)).toBeNull();
  expect(fixture.store.tasks.getAttachment(retained.image.attachmentId)).toBeUndefined();
}));
