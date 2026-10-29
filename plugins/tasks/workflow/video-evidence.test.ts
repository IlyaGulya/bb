import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore } from "../api/index.js";
import { registerAttachments, saveAttachmentFromBytes } from "../attachments/index.js";
import { registerTaskWorkflows } from "./index.js";
import { buildEvidenceSchema, taskBuildEvidenceContract, type BuildReviewResult } from "../../workflows/src/build-review-contract.js";

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
});
