import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore } from "../api/index.js";
import { registerAttachments, saveAttachmentFromBytes } from "../attachments/index.js";
import { registerTaskWorkflows } from "./index.js";
import { buildEvidenceSchema, taskBuildEvidenceContract, type BuildReviewResult, type BuildReviewStart } from "../../workflows/src/build-review-contract.js";
import type { TaskWorkflow } from "../shared/workflow-contract.js";
import { TaskWorkflowStore, taskWorkflowVideoLineageMigration } from "./store.js";

const hosts: FakePluginHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.dispose(); });

function setup() {
  const host = createFakePluginHost({ pluginId: "tasks" });
  hosts.push(host);
  const store = createStore(host.bb);
  registerAttachments(host.bb, store.tasks);
  registerTaskWorkflows(host.bb, store, { background: false });
  const project = store.tasks.createProject({ name: "Video fixture", prefix: "VID", color: "blue" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Owned video result" });
  const other = store.tasks.createTask({ projectId: project.id, title: "Other owner" });
  const database = store.database.prepare<[], { name: string; file: string }>("PRAGMA database_list").all().find(row => row.name === "main")!;
  const build: BuildReviewResult["build"] = {
    branch: "owned-video-fixture", commit: "a".repeat(40), diff: "Owned task change",
    commands: [{ command: "consumer-smoke", exitCode: 0, output: "Observed fixture response" }],
    uiEvidence: [], limitations: [], nextDecision: "Human Accept or Return",
  };
  const validate = (candidate = build, policy: "video" | "ui" | "technical" | null = "video", uiRequired = false) => host.harness.callRpc("validateTaskBuildEvidence", taskBuildEvidenceContract.validateTaskBuildEvidence.input.parse({
    taskId: task.id, uiRequired, ...(policy ? { evidencePolicy: { version: 1, requirement: policy } } : {}), build: candidate,
  }));
  const withVideo = (attachmentId: string): BuildReviewResult["build"] => ({ ...build, uiEvidence: [{
    kind: "video", attachmentId, description: "Committed repository video fixture",
    recording: { commit: build.commit, runId: "owned-fixture-run", scenario: "Public recorded UI interaction", sourceAttachmentId: attachmentId, transformation: null },
  }] });
  return { ...host, store, task, other, root: dirname(database.file), build, validate, withVideo };
}

const fixtureUrl = new URL("../../../apps/web/public/blog/tweets/tiling.mp4", import.meta.url);

function publishRecordingLineage(fixture: ReturnType<typeof setup>, build: BuildReviewResult["build"]) {
  const workflows = new TaskWorkflowStore(fixture.store);
  const role: BuildReviewStart["writer"] = { provider: "fixture", model: "fixture-model", reasoningLevel: "high", permissionMode: "full", serviceTier: null, instructions: "Owned fixture" };
  const request: BuildReviewStart = {
    key: "twf_video_lineage:1", group: "twf_video_lineage", projectId: "proj_video_fixture", originThreadId: "thr_video_origin",
    task: fixture.task.title, template: "development-review", writer: role, reviewer: role,
    smokeCommands: ["consumer-smoke"], uiRequired: false, evidencePolicy: { version: 1, requirement: "video" }, evidenceTaskId: fixture.task.id, feedback: "",
  };
  const native: NonNullable<TaskWorkflow["native"]> = {
    runId: "owned-fixture-run", key: request.key, contextStarted: true, status: "succeeded", phase: "Independent review", error: null,
    result: { plan: "Recorded fixture lineage", build, review: { verdict: "ready", findings: [], summary: "Fixture review" } },
    workers: [{ threadId: "thr_video_writer", role: "writer", callIndex: 1 }, { threadId: "thr_video_reviewer", role: "reviewer", callIndex: 2 }],
    policyLimitations: [], evidencePolicy: request.evidencePolicy, uiRequired: false,
  };
  workflows.create("video-lineage-launch", fixture.task.id, request, "{}");
  expect(workflows.publish(request.group, native).state).toBe("in_review");
  return { workflows, request, native };
}

describe("video-required task artifact admission", () => {
  it.each(["missing", "screenshot", "preview"] as const)("refuses %s evidence without publishing a reviewable package", async kind => {
    const fixture = setup();
    const build = { ...fixture.build, uiEvidence: kind === "missing" ? [] : [{ kind, location: "https://example.test/preview", description: "Not a recording" }] };
    await expect(fixture.validate(buildEvidenceSchema.parse(build))).rejects.toThrow(/Video is required/);
    expect(fixture.store.tasks.getTask(fixture.task.id)?.status).toBe("backlog");
  });

  it("keeps legacy UI screenshot/preview policy distinct from explicit video policy", async () => {
    const fixture = setup();
    const screenshot = buildEvidenceSchema.parse({ ...fixture.build, uiEvidence: [{ kind: "screenshot", location: "legacy.png", description: "Legacy screenshot" }] });
    expect(await fixture.validate(screenshot, null, true)).toEqual({ verified: true });
    await expect(fixture.validate(screenshot, "video", true)).rejects.toThrow(/Video is required/);
    expect(await fixture.validate(fixture.build, null, false)).toEqual({ verified: true });
    await expect(fixture.validate(fixture.build, null, true)).rejects.toThrow(/UI screenshot or preview/);
  });

  it("requires an accessible task-owned video and rejects disappearance, corruption and foreign ownership", async () => {
    const fixture = setup();
    const bytes = await readFile(fixtureUrl);
    const attachment = await saveAttachmentFromBytes(fixture.store.tasks, bytes, { taskId: fixture.task.id, fileName: "fixture.mp4" });
    const foreign = await saveAttachmentFromBytes(fixture.store.tasks, bytes, { taskId: fixture.other.id, fileName: "foreign.mp4" });
    expect(await fixture.validate(fixture.withVideo(attachment.id))).toEqual({ verified: true });
    await expect(fixture.validate(fixture.withVideo(foreign.id))).rejects.toThrow(/another task/);
    const truncated = await saveAttachmentFromBytes(fixture.store.tasks, bytes.subarray(0, 32), { taskId: fixture.task.id, fileName: "truncated.mp4", mime: "video/mp4" });
    await expect(fixture.validate(fixture.withVideo(truncated.id))).rejects.toThrow(/truncated|no recorded/);
    const path = join(fixture.root, attachment.blobPath);
    await writeFile(path, bytes.subarray(0, 32));
    await expect(fixture.validate(fixture.withVideo(attachment.id))).rejects.toThrow(/changed|unsupported|truncated/);
    await rm(path);
    await expect(fixture.validate(fixture.withVideo(attachment.id))).rejects.toThrow();
  });

  it("checks reviewed commit and retains an accessible original for edited clips", async () => {
    const fixture = setup();
    const bytes = await readFile(fixtureUrl);
    const original = await saveAttachmentFromBytes(fixture.store.tasks, bytes, { taskId: fixture.task.id, fileName: "original.mp4" });
    const edited = await saveAttachmentFromBytes(fixture.store.tasks, bytes, { taskId: fixture.task.id, fileName: "edited.mp4" });
    const build = fixture.withVideo(edited.id);
    const evidence = build.uiEvidence[0]!;
    if (evidence.kind !== "video") throw new Error("Expected video fixture");
    evidence.recording.commit = "b".repeat(40);
    await expect(fixture.validate(build)).rejects.toThrow(/exact reviewed commit/);
    evidence.recording.commit = build.commit;
    evidence.recording.sourceAttachmentId = original.id;
    await expect(fixture.validate(build)).rejects.toThrow(/disclose/);
    evidence.recording.transformation = "2× speed; original retained from the same fixture run";
    evidence.recording.sourceAttachmentId = edited.id;
    await expect(fixture.validate(build)).rejects.toThrow(/separate original/);
    evidence.recording.sourceAttachmentId = original.id;
    expect(await fixture.validate(build)).toEqual({ verified: true });
    await rm(join(fixture.root, original.blobPath));
    await expect(fixture.validate(build)).rejects.toThrow();
  });

  it("rejects relabelling a previously published C1 recording as C2 and a fabricated run after Return", async () => {
    const fixture = setup();
    const attachment = await saveAttachmentFromBytes(fixture.store.tasks, await readFile(fixtureUrl), { taskId: fixture.task.id, fileName: "recorded-at-c1.mp4" });
    const recorded = fixture.withVideo(attachment.id);
    expect(await fixture.validate(recorded)).toEqual({ verified: true });
    const { workflows, request, native } = publishRecordingLineage(fixture, recorded);
    const reopened = new TaskWorkflowStore(fixture.store);
    const returned = reopened.return(request.group, 1, "Show the corrected result on C2 without rewriting old recording lineage");
    reopened.save({ ...returned, state: "running", native: { ...native, runId: "wfr_c2_attempt", key: reopened.request(request.group).key, status: "running", result: null } });
    expect(await fixture.validate(recorded)).toEqual({ verified: true });
    const evidence = recorded.uiEvidence[0]!;
    if (evidence.kind !== "video") throw new Error("Expected video fixture");
    const relabelled = buildEvidenceSchema.parse({
      ...recorded, commit: "b".repeat(40),
      uiEvidence: [{ ...evidence, recording: { ...evidence.recording, commit: "b".repeat(40), runId: "wfr_nonexistent_recording" } }],
    });
    await expect(fixture.validate(relabelled)).rejects.toThrow();
    expect(workflows.get(request.group).revision).toBe(2);
    expect(workflows.get(request.group).state).toBe("running");
    expect(fixture.store.tasks.getTask(fixture.task.id)?.status).toBe("in_progress");
  });

  it("preserves a retained published recording claim through a schema upgrade and Return", async () => {
    const fixture = setup();
    const attachment = await saveAttachmentFromBytes(fixture.store.tasks, await readFile(fixtureUrl), { taskId: fixture.task.id, fileName: "before-upgrade.mp4" });
    const recorded = fixture.withVideo(attachment.id);
    const { request } = publishRecordingLineage(fixture, recorded);
    fixture.store.database.exec("ALTER TABLE task_workflow_runs DROP COLUMN video_lineage_json");
    fixture.store.database.exec(taskWorkflowVideoLineageMigration);
    const reopened = new TaskWorkflowStore(fixture.store);
    reopened.return(request.group, 1, "Retain the published original across upgrade");
    expect(await fixture.validate(recorded)).toEqual({ verified: true });
    const evidence = recorded.uiEvidence[0]!;
    if (evidence.kind !== "video") throw new Error("Expected video fixture");
    const substituted = buildEvidenceSchema.parse({
      ...recorded,
      uiEvidence: [{ ...evidence, recording: { ...evidence.recording, runId: "unrelated-upgrade-run" } }],
    });
    await expect(fixture.validate(substituted)).rejects.toThrow();
    expect(reopened.get(request.group).revision).toBe(2);
    expect(fixture.store.tasks.getTask(fixture.task.id)?.status).toBe("in_progress");
  });

  it("rejects relabelling a recording Returned before the lineage upgrade while admitting a fresh recording", async () => {
    const fixture = setup();
    const bytes = await readFile(fixtureUrl);
    const original = await saveAttachmentFromBytes(fixture.store.tasks, bytes, { taskId: fixture.task.id, fileName: "published-before-upgrade.mp4" });
    const recorded = fixture.withVideo(original.id);
    const { workflows, request, native } = publishRecordingLineage(fixture, recorded);
    const publication = fixture.store.tasks.listComments(fixture.task.id).find(comment => comment.kind === "agent");
    if (!publication) throw new Error("Expected retained published result");
    fixture.store.database.exec("ALTER TABLE task_workflow_runs DROP COLUMN video_lineage_json");
    const returned = workflows.return(request.group, 1, "Show the real C2 result after upgrading");
    expect(returned.revision).toBe(2);
    expect(returned.native).toBeNull();
    fixture.store.database.exec(taskWorkflowVideoLineageMigration);
    const reopened = new TaskWorkflowStore(fixture.store);
    const runId = "wfr_after_upgrade_c2";
    reopened.save({ ...returned, state: "running", native: { ...native, runId, key: reopened.request(request.group).key, status: "running", result: null } });
    const freshAttachment = await saveAttachmentFromBytes(fixture.store.tasks, bytes, { taskId: fixture.task.id, fileName: "fresh-after-upgrade-c2.mp4" });
    const fresh = fixture.withVideo(freshAttachment.id);
    const freshEvidence = fresh.uiEvidence[0]!;
    if (freshEvidence.kind !== "video") throw new Error("Expected fresh video fixture");
    fresh.commit = "b".repeat(40);
    freshEvidence.recording.commit = fresh.commit;
    freshEvidence.recording.runId = runId;
    expect(await fixture.validate(fresh)).toEqual({ verified: true });
    expect(fixture.store.tasks.listComments(fixture.task.id).find(comment => comment.id === publication.id)?.body).toBe(publication.body);
    const originalEvidence = recorded.uiEvidence[0]!;
    if (originalEvidence.kind !== "video") throw new Error("Expected original video fixture");
    const relabelled = buildEvidenceSchema.parse({
      ...fresh,
      uiEvidence: [{ ...originalEvidence, recording: { ...originalEvidence.recording, commit: fresh.commit, runId } }],
    });
    await expect(fixture.validate(relabelled)).rejects.toThrow();
    expect(reopened.get(request.group).revision).toBe(2);
    expect(fixture.store.tasks.getTask(fixture.task.id)?.status).toBe("in_progress");
  });

  it("rejects substituting an unrelated same-task upload for an edited recording's persisted original", async () => {
    const fixture = setup();
    const bytes = await readFile(fixtureUrl);
    const original = await saveAttachmentFromBytes(fixture.store.tasks, bytes, { taskId: fixture.task.id, fileName: "captured-original.mp4" });
    const edited = await saveAttachmentFromBytes(fixture.store.tasks, bytes, { taskId: fixture.task.id, fileName: "edited-recording.mp4" });
    const unrelated = await saveAttachmentFromBytes(fixture.store.tasks, bytes, { taskId: fixture.task.id, fileName: "unrelated-upload.mp4" });
    const recording = fixture.withVideo(edited.id);
    const evidence = recording.uiEvidence[0]!;
    if (evidence.kind !== "video") throw new Error("Expected video fixture");
    evidence.recording.sourceAttachmentId = original.id;
    evidence.recording.transformation = "Edited fixture; the original attachment is retained";
    expect(await fixture.validate(recording)).toEqual({ verified: true });
    publishRecordingLineage(fixture, recording);
    expect(await fixture.validate(recording)).toEqual({ verified: true });
    const substituted = buildEvidenceSchema.parse({ ...recording, uiEvidence: [{ ...evidence, recording: { ...evidence.recording, sourceAttachmentId: unrelated.id } }] });
    await expect(fixture.validate(substituted)).rejects.toThrow();
    expect(fixture.store.tasks.getTask(fixture.task.id)?.status).toBe("in_review");
  });
});
