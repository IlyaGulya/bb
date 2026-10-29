import Database from "better-sqlite3";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineCli } from "@get-bb/plugin-sdk";
import { AttachmentReferencedError, deleteAttachmentById, readAttachmentContent } from "../attachments/index.js";
import { taskArtifactSchema, taskArtifactViewSchema } from "../shared/artifacts.js";
import { artifactCommands } from "../cli/artifacts.js";
import { createArtifactFixture, FAKE_QUOTE, FAKE_SCREENSHOT } from "./test-fixtures.js";

async function withFixture(run: (fixture: Awaited<ReturnType<typeof createArtifactFixture>>) => Promise<void>) {
  const fixture = await createArtifactFixture();
  try { await run(fixture); } finally { await fixture.harness.dispose(); }
}

describe("retained task artifacts", () => {
  it("round-trips an explicit image selection through RPC and returns actual image bytes to the current agent", async () => withFixture(async f => {
    const input = f.input();
    const saved = taskArtifactSchema.parse(await f.harness.callRpc("createTaskArtifact", input));
    const view = taskArtifactViewSchema.parse(await f.harness.callRpc("getTaskArtifact", { ...f.scope, artifactId: saved.id }));
    expect(view).toMatchObject({ artifact: { id: saved.id, source: { threadId: "thr_source", eventSeq: 7, quote: FAKE_QUOTE }, annotation: { image: f.image, region: { x: 0, y: 0, width: 1, height: 1 }, coordinateFrame: "decoded-image-pixels" } }, sourceStatus: "available", sourceUrl: "/projects/proj_fixture/threads/thr_source#msg=7" });
    const result = await f.harness.callAgentTool("bb_task_artifact_read", { artifactId: saved.id }, { threadId: "thr_agent", projectId: "proj_fixture" });
    expect(result).toMatchObject({ content: [
      { type: "text", text: JSON.stringify(view) },
      { type: "image", data: FAKE_SCREENSHOT.toString("base64"), mimeType: "image/png" },
    ] });
    expect(f.store.tasks.getTask(f.task.id)?.status).toBe(f.task.status);
  }));

  it("keeps personal-project source bookmarks on the projectless message route", async () => withFixture(async f => {
    f.state.projectId = "proj_personal";
    f.store.tasks.updateProject(f.project.id, { linkedBbProjectId: "proj_personal" });
    const saved = await f.service.handlers.createTaskArtifact(f.input(false));
    expect(await f.service.handlers.getTaskArtifact({ ...f.scope, artifactId: saved.id })).toMatchObject({ sourceStatus: "available", sourceUrl: "/threads/thr_source#msg=7" });
  }));

  it("retains bounded snapshots and images after SQLite close/reopen and source deletion", async () => withFixture(async f => {
    const saved = await f.service.handlers.createTaskArtifact(f.input());
    const database = f.store.database.prepare<[], { file: string; name: string }>("PRAGMA database_list").all().find(entry => entry.name === "main");
    if (!database) throw new Error("File-backed fixture database is missing");
    f.store.database.close();
    const reopened = new Database(database.file);
    let restarted: Awaited<ReturnType<typeof createArtifactFixture>> | undefined;
    try {
      restarted = await createArtifactFixture(reopened);
      restarted.state.sourceMissing = true;
      const result = await restarted.service.readForThread(saved.id, "thr_agent");
      expect(result.view).toMatchObject({ artifact: saved, sourceStatus: "deleted", sourceUrl: null });
      expect(result.image?.content.equals(FAKE_SCREENSHOT)).toBe(true);
      expect(await restarted.service.handlers.listTaskArtifacts(restarted.scope)).toEqual([saved]);
    } finally {
      await restarted?.harness.dispose();
      reopened.close();
    }
  }));

  it("distinguishes archived, edited and deleted sources without replacing the retained decision", async () => withFixture(async f => {
    const saved = await f.service.handlers.createTaskArtifact(f.input(false));
    const target = { ...f.scope, artifactId: saved.id };
    f.state.sourceArchived = true;
    expect(await f.service.handlers.getTaskArtifact(target)).toMatchObject({ artifact: saved, sourceStatus: "archived", sourceUrl: "/projects/proj_fixture/threads/thr_source#msg=7" });
    f.state.sourceText = "A later revision replaced this decision";
    expect(await f.service.handlers.getTaskArtifact(target)).toEqual({ artifact: saved, sourceStatus: "changed", sourceUrl: null });
    f.state.sourceDeleted = true;
    expect(await f.service.handlers.getTaskArtifact(target)).toEqual({ artifact: saved, sourceStatus: "deleted", sourceUrl: null });
  }));

  it("uses logical context rather than payer and fails closed on revocation or membership removal", async () => withFixture(async f => {
    const saved = await f.service.handlers.createTaskArtifact(f.input());
    f.state.modelConnectionId = "connection-work";
    expect((await f.service.readForThread(saved.id, "thr_agent")).image?.content.equals(FAKE_SCREENSHOT)).toBe(true);
    f.state.agentContextId = "context-work";
    await expect(f.service.readForThread(saved.id, "thr_agent")).rejects.toThrow("unavailable");
    f.state.agentContextId = "context-personal";
    f.state.contextEnabled = false;
    await expect(f.service.handlers.listTaskArtifacts(f.scope)).rejects.toThrow("unavailable");
    f.state.contextEnabled = true;
    f.state.projectMember = false;
    await expect(f.service.readForThread(saved.id, "thr_agent")).rejects.toThrow("unavailable");
  }));

  it("rejects foreign source context, foreign task images and quotes absent from the real message", async () => withFixture(async f => {
    const otherTask = f.store.tasks.createTask({ projectId: f.project.id, title: "Other task" });
    await expect(f.service.handlers.inspectTaskArtifactImage({ ...f.scope, taskId: otherTask.id, attachmentId: f.image.attachmentId })).rejects.toThrow("unavailable");
    await expect(f.service.handlers.createTaskArtifact({ ...f.input(), executionContextId: "context-work" })).rejects.toThrow("unavailable");
    const request = f.input(false);
    await expect(f.service.handlers.createTaskArtifact({ ...request, source: { ...request.source, quote: "Not in the selected message" } })).rejects.toThrow("actual source");
    expect(await f.service.handlers.listTaskArtifacts(f.scope)).toEqual([]);
  }));

  it("accepts the final pixel and rejects zero-area, fractional, nonfinite and out-of-frame selections", async () => withFixture(async f => {
    for (const region of [
      { x: 1, y: 0, width: 1, height: 1 },
      { x: 0, y: 0, width: 0, height: 1 },
      { x: 0.5, y: 0, width: 1, height: 1 },
      { x: 0, y: 0, width: 1, height: Number.POSITIVE_INFINITY },
    ]) {
      const request = f.input();
      if (!request.annotation) throw new Error("Annotated fixture is missing");
      await expect(f.service.handlers.createTaskArtifact({ ...request, annotation: { ...request.annotation, region } })).rejects.toThrow();
    }
    const saved = await f.service.handlers.createTaskArtifact(f.input());
    expect(saved.annotation?.region).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  }));

  it("rejects forged dimensions or image hashes without publishing a retained artifact", async () => withFixture(async f => {
    const request = f.input();
    if (!request.annotation) throw new Error("Annotated fixture is missing");
    for (const image of [{ ...f.image, width: 2 }, { ...f.image, sha256: "0".repeat(64) }]) {
      await expect(f.service.handlers.createTaskArtifact({ ...request, annotation: { ...request.annotation, image } })).rejects.toThrow("changed");
    }
    expect(await f.service.handlers.listTaskArtifacts(f.scope)).toEqual([]);
  }));

  it("deduplicates concurrent save retries but refuses to reuse an ID for a different decision", async () => withFixture(async f => {
    const request = f.input();
    const [first, second] = await Promise.all([f.service.handlers.createTaskArtifact(request), f.service.handlers.createTaskArtifact(request)]);
    expect(first).toEqual(second);
    expect(await f.service.handlers.listTaskArtifacts(f.scope)).toEqual([first]);
    await expect(f.service.handlers.createTaskArtifact({ ...request, decision: "A different decision" })).rejects.toThrow("already used");
  }));

  it("does not remove retained screenshot bytes and releases the guard only after explicit artifact removal", async () => withFixture(async f => {
    const saved = await f.service.handlers.createTaskArtifact(f.input());
    await expect(deleteAttachmentById(f.bb, f.store.tasks, f.image.attachmentId)).rejects.toBeInstanceOf(AttachmentReferencedError);
    expect((await readAttachmentContent(f.store.tasks, f.image.attachmentId)).content.equals(FAKE_SCREENSHOT)).toBe(true);
    await f.service.handlers.deleteTaskArtifact({ ...f.scope, artifactId: saved.id });
    expect(await deleteAttachmentById(f.bb, f.store.tasks, f.image.attachmentId)).toMatchObject({ id: f.image.attachmentId });
  }));

  it("never reports a successful annotation when a racing deletion wins", async () => withFixture(async f => {
    let release!: () => void;
    let removing!: () => void;
    const entered = new Promise<void>(resolve => { removing = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const deleting = deleteAttachmentById(f.bb, f.store.tasks, f.image.attachmentId, { removeBlobs: async () => { removing(); await gate; } });
    await entered;
    const creating = f.service.handlers.createTaskArtifact(f.input());
    release();
    await deleting;
    await expect(creating).rejects.toThrow("unavailable");
    expect(await f.service.handlers.listTaskArtifacts(f.scope)).toEqual([]);
  }));

  it("detects retained image tampering before giving an agent an image", async () => withFixture(async f => {
    const saved = await f.service.handlers.createTaskArtifact(f.input());
    const database = f.store.database.prepare<[], { file: string; name: string }>("PRAGMA database_list").all().find(entry => entry.name === "main");
    if (!database) throw new Error("File-backed fixture database is missing");
    const path = join(dirname(database.file), f.imageAttachment.blobPath);
    const changed = Buffer.from(await readFile(path));
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    await writeFile(path, changed);
    await expect(f.service.readForThread(saved.id, "thr_agent")).rejects.toThrow("integrity");
  }));

  it("does not obstruct explicit task deletion through image-reference cascades", async () => withFixture(async f => {
    const saved = await f.service.handlers.createTaskArtifact(f.input());
    expect(f.store.tasks.deleteTask(f.task.id)).toBe(true);
    expect(f.store.tasks.getAttachment(f.image.attachmentId)).toBeUndefined();
    await expect(f.service.readForThread(saved.id, "thr_agent")).rejects.toThrow("unavailable");
  }));

  it("exposes retained coordinates through CLI without accepting a forged context override in an agent thread", async () => withFixture(async f => {
    const saved = await f.service.handlers.createTaskArtifact(f.input());
    f.bb.cli.register(defineCli({ name: "tasks", summary: "Owned artifact fixture", commands: artifactCommands(f.bb, f.store, async () => ({ ...f.task, labelIds: [] }), async action => {
      const result = await action();
      return typeof result === "string" ? { exitCode: 0, stdout: result } : result;
    }) }));
    const shown = await f.harness.runCli(["artifact", "show", f.task.key, saved.id, "--json"], { threadId: "thr_agent" });
    expect(shown.exitCode).toBe(0);
    expect(taskArtifactViewSchema.parse(JSON.parse(shown.stdout)).artifact.annotation).toEqual(saved.annotation);
    const refused = await f.harness.runCli(["artifact", "show", f.task.key, saved.id, "--context", "Work"], { threadId: "thr_agent" });
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("frozen context");
  }));
});
