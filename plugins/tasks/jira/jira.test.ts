import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createStore } from "../api/index.js";
import type { JiraProposal, JiraSource } from "../shared/jira-contract.js";
import { registerJiraSync } from "./index.js";
import { textDocument } from "./client.js";
import { JiraStore, storedJiraContext } from "./store.js";
import { loadJiraConfiguration, type JiraConnectionConfig } from "./config.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});

function setup() {
  const { bb, harness } = createFakePluginHost({
    pluginId: "jira-behavior-test",
  });
  const store = createStore(bb);
  const project = store.tasks.createProject({
    name: "Synthetic work",
    prefix: "SYN",
    color: "blue",
  });
  const other = store.tasks.createProject({
    name: "Synthetic personal",
    prefix: "OTH",
    color: "green",
  });
  const directory = mkdtempSync(join(tmpdir(), "bb-jira-test-"));
  const credentialFile = join(directory, "jira.env");
  writeFileSync(
    credentialFile,
    'JIRA_ACCOUNT_EMAIL="synthetic@example.invalid"\nJIRA_API_TOKEN="synthetic-test-only"\n',
    { mode: 0o600 },
  );
  const config: JiraConnectionConfig = {
    id: "synthetic",
    label: "Synthetic Jira",
    siteUrl: "https://synthetic.atlassian.net",
    cloudId: "12345678-1234-4123-8123-123456789abc",
    credentialFile,
    projectIds: [project.id],
  };
  const issue: {
    id: string;
    key: string;
    fields: {
      summary: string;
      description: unknown;
      status: { id: string; name: string };
      priority: { name: string };
      assignee: null;
      updated: string;
    };
  } = {
    id: "10001",
    key: "DEMO-1",
    fields: {
      summary: "Remote summary",
      description: textDocument("Remote description"),
      status: { id: "open", name: "Open" },
      priority: { name: "Medium" },
      assignee: null,
      updated: "2026-01-01T00:00:00.000Z",
    },
  };
  const comments: Array<{
    id: string;
    body: unknown;
    updated: string;
    author: { displayName: string };
    properties: Array<{ key: string; value: unknown }>;
  }> = [];
  const state = {
    writes: 0,
    reads: 0,
    readStatus: 200,
    writeMode: "ok" as
      | "ok"
      | "reject"
      | "timeout"
      | "timeout-before"
      | "readback",
    transitionAvailable: true,
    commentTotal: 0,
  };
  const http: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.atlassian.com");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      `Basic ${Buffer.from("synthetic@example.invalid:synthetic-test-only").toString("base64")}`,
    );
    const method = init?.method ?? "GET";
    if (method === "GET") {
      state.reads += 1;
      if (state.readStatus !== 200)
        return Response.json(
          { errorMessages: ["Never exposed internal fixture body"] },
          { status: state.readStatus },
        );
      if (url.pathname.endsWith("/transitions"))
        return Response.json({
          transitions: state.transitionAvailable
            ? [
                {
                  id: "finish",
                  name: "Finish",
                  to: { id: "done", name: "Done" },
                },
              ]
            : [],
        });
      if (/\/comment\/[^/]+$/.test(url.pathname)) {
        const comment = comments.find((candidate) =>
          url.pathname.endsWith(`/${candidate.id}`),
        );
        return comment
          ? Response.json(comment)
          : Response.json({}, { status: 404 });
      }
      if (url.pathname.endsWith("/comment"))
        return Response.json({
          total: Math.max(state.commentTotal, comments.length),
          comments: comments.slice(
            0,
            Number(url.searchParams.get("maxResults") ?? 50),
          ),
        });
      return Response.json(issue);
    }
    state.writes += 1;
    if (state.writeMode === "reject")
      return Response.json({ secret: "must not leak" }, { status: 403 });
    if (state.writeMode === "timeout-before")
      throw new Error("transport unavailable");
    const body: unknown = JSON.parse(String(init?.body));
    let commentId: string | null = null;
    if (url.pathname.endsWith("/comment")) {
      const parsed = z
        .object({
          body: z.unknown(),
          properties: z.array(
            z.object({
              key: z.string(),
              value: z.record(z.string(), z.unknown()),
            }),
          ),
        })
        .safeParse(body);
      if (!parsed.success)
        return Response.json(
          { errorMessages: ["Comment properties require JSON objects"] },
          { status: 400 },
        );
      const payload = parsed.data;
      commentId = String(200 + comments.length);
      comments.unshift({
        id: commentId,
        body: payload.body,
        properties: payload.properties,
        author: { displayName: "Synthetic author" },
        updated: issue.fields.updated,
      });
    } else if (url.pathname.endsWith("/transitions")) {
      issue.fields.status = { id: "done", name: "Done" };
    } else {
      const payload = z
        .object({
          fields: z.object({
            summary: z.string().optional(),
            description: z.unknown().optional(),
          }),
        })
        .parse(body);
      if (payload.fields.summary !== undefined)
        issue.fields.summary = payload.fields.summary;
      if (payload.fields.description !== undefined)
        issue.fields.description = z
          .object({
            type: z.string(),
            version: z.number(),
            content: z.array(
              z.object({
                type: z.string(),
                content: z.array(
                  z.object({ type: z.string(), text: z.string() }),
                ),
              }),
            ),
          })
          .parse(payload.fields.description);
    }
    issue.fields.updated = `2026-01-01T00:00:${String(state.writes).padStart(2, "0")}.000Z`;
    if (state.writeMode === "timeout")
      throw new Error("connection dropped after commit");
    if (state.writeMode === "readback") state.readStatus = 503;
    return commentId
      ? Response.json({ id: commentId })
      : new Response(null, { status: 204 });
  };
  const jira = registerJiraSync(bb, store, {
    configuration: () => ({ connections: [config], error: null }),
    fetch: http,
  });
  cleanup.push(async () => {
    await harness.dispose();
    rmSync(directory, { recursive: true, force: true });
  });
  const importIssue = (taskId: string | null = null) =>
    jira.jiraImport({
      connectionId: config.id,
      issue: issue.key,
      projectId: project.id,
      taskId,
    });
  async function preview(source: JiraSource, proposal: JiraProposal) {
    const draft = await jira.jiraDraft({
      taskId: source.taskId,
      expectedRevision: source.revision,
      proposal,
    });
    return jira.jiraPreview({
      taskId: source.taskId,
      expectedRevision: draft.source.revision,
    });
  }
  return {
    bb,
    store,
    project,
    other,
    directory,
    config,
    issue,
    comments,
    state,
    jira,
    importIssue,
    preview,
  };
}

describe("native Tasks Jira connector", () => {
  it("atomically imports concurrent requests and persists unique source mappings", async () => {
    const fixture = setup();
    const results = await Promise.all([
      fixture.importIssue(),
      fixture.importIssue(),
    ]);
    expect(results[0]?.source.taskId).toBe(results[1]?.source.taskId);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    const source = results[0]!.source;
    const database = fixture.bb.storage.database();
    expect(
      database
        .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM tasks")
        .get()?.count,
    ).toBe(1);
    expect(
      new JiraStore(database, fixture.store).source(source.taskId)?.remote.id,
    ).toBe("10001");
    const otherTask = fixture.store.tasks.createTask({
      projectId: fixture.project.id,
      title: "Existing",
    });
    expect(() =>
      database
        .prepare<[string, string, string, string, string]>(
          "INSERT INTO jira_sources (task_id, connection_id, issue_id, baseline_json, remote_json) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          otherTask.id,
          fixture.config.id,
          source.remote.id,
          JSON.stringify(source.remote),
          JSON.stringify(source.remote),
        ),
    ).toThrow();
    await expect(fixture.importIssue(otherTask.id)).rejects.toThrow(
      "already linked",
    );
    fixture.issue.key = "RENAMED-2";
    expect((await fixture.importIssue()).source.taskId).toBe(source.taskId);
  });

  it("preserves attribute-backed Jira content in descriptions and comments", async () => {
    const fixture = setup();
    const document = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "mention",
              attrs: { id: "synthetic-user", text: "@Reviewer" },
            },
            { type: "text", text: " review " },
            {
              type: "inlineCard",
              attrs: { url: "https://example.invalid/design" },
            },
            { type: "emoji", attrs: { shortName: ":check_mark:" } },
            { type: "status", attrs: { text: "Ready", color: "green" } },
          ],
        },
      ],
    };
    fixture.issue.fields.description = document;
    fixture.comments.push({
      id: "123",
      body: document,
      author: { displayName: "Synthetic reviewer" },
      updated: fixture.issue.fields.updated,
      properties: [],
    });
    const { source } = await fixture.importIssue();
    expect(source.remote.description).toBe(
      "@Reviewer review https://example.invalid/design:check_mark:Ready",
    );
    expect(source.remote.comments[0]?.body).toBe(
      "@Reviewer review https://example.invalid/design:check_mark:Ready",
    );
  });

  it("actually clears rich content instead of reporting a false successful no-op", async () => {
    const fixture = setup();
    fixture.issue.fields.description = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "inlineCard",
              attrs: { url: "https://example.invalid/design" },
            },
          ],
        },
      ],
    };
    const { source } = await fixture.importIssue();
    const preview = await fixture.preview(source, {
      kind: "fields",
      summary: null,
      description: "",
    });
    const result = await fixture.jira.jiraPush({
      taskId: source.taskId,
      previewId: preview.preview.id,
    });
    expect(result.operation.state).toBe("applied");
    expect(fixture.issue.fields.description).toEqual(textDocument(""));
    expect(fixture.state.writes).toBe(1);
  });

  it("honors explicit plain-text replacement even when visible text is unchanged", async () => {
    const fixture = setup();
    fixture.issue.fields.description = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Important", marks: [{ type: "strong" }] },
          ],
        },
      ],
    };
    const { source } = await fixture.importIssue();
    const preview = await fixture.preview(source, {
      kind: "fields",
      summary: null,
      description: "Important",
    });
    const result = await fixture.jira.jiraPush({
      taskId: source.taskId,
      previewId: preview.preview.id,
    });
    expect(result.operation.state).toBe("applied");
    expect(fixture.issue.fields.description).toEqual(textDocument("Important"));
    expect(fixture.state.writes).toBe(1);
  });

  it("links and pulls without changing local planning, comments, threads or workspace project", async () => {
    const fixture = setup();
    const task = fixture.store.tasks.createTask({
      projectId: fixture.project.id,
      title: "Local plan",
      description: "Local description",
      status: "in_progress",
      priority: "high",
    });
    const comment = fixture.store.tasks.createComment({
      taskId: task.id,
      kind: "user",
      authorName: "Planner",
      body: "Local note",
    });
    const thread = fixture.store.tasks.upsertTaskThread({
      taskId: task.id,
      threadId: "thr_synthetic",
      presetName: "Test",
      title: "Existing work",
      liveStatus: "working",
    });
    const imported = await fixture.importIssue(task.id);
    fixture.issue.fields.summary = "Changed source";
    fixture.issue.fields.status = { id: "done", name: "Done" };
    const pulled = await fixture.jira.jiraPull({
      taskId: task.id,
      expectedRevision: imported.source.revision,
    });
    expect(pulled.source.remote.summary).toBe("Changed source");
    expect(fixture.store.tasks.getTask(task.id)).toEqual(task);
    expect(fixture.store.tasks.listComments(task.id)).toEqual([comment]);
    expect(fixture.store.tasks.getTaskThread(thread.id)).toEqual(thread);
    expect(storedJiraContext(fixture.bb, task.id)).toContain("Changed source");
    expect(storedJiraContext(fixture.bb, task.id)).toContain(
      "untrusted external data",
    );
  });

  it("retains draft baselines across pulls and rejects overlapping field edits", async () => {
    const fixture = setup();
    const { source } = await fixture.importIssue();
    const draft = await fixture.jira.jiraDraft({
      taskId: source.taskId,
      expectedRevision: source.revision,
      proposal: { kind: "fields", summary: "My proposal", description: null },
    });
    fixture.issue.fields.summary = "Another editor";
    const pulled = await fixture.jira.jiraPull({
      taskId: source.taskId,
      expectedRevision: draft.source.revision,
    });
    expect(pulled.source.baseline.summary).toBe("Remote summary");
    const preview = await fixture.jira.jiraPreview({
      taskId: source.taskId,
      expectedRevision: pulled.source.revision,
    });
    expect(preview.preview.canPush).toBe(false);
    expect(preview.preview.changes[0]?.conflict).toBe(true);
    await expect(
      fixture.jira.jiraPush({
        taskId: source.taskId,
        previewId: preview.preview.id,
      }),
    ).rejects.toThrow("conflicted");
    expect(fixture.state.writes).toBe(0);
  });

  it("accepts non-overlapping and convergent changes without rewriting untouched descriptions", async () => {
    const fixture = setup();
    const { source } = await fixture.importIssue();
    const originalDocument = structuredClone(fixture.issue.fields.description);
    const draft = await fixture.jira.jiraDraft({
      taskId: source.taskId,
      expectedRevision: source.revision,
      proposal: {
        kind: "fields",
        summary: "Chosen summary",
        description: null,
      },
    });
    fixture.issue.fields.status = { id: "review", name: "Review" };
    const preview = await fixture.jira.jiraPreview({
      taskId: source.taskId,
      expectedRevision: draft.source.revision,
    });
    const pushed = await fixture.jira.jiraPush({
      taskId: source.taskId,
      previewId: preview.preview.id,
    });
    expect(pushed.operation.state).toBe("applied");
    expect(pushed.source.remote.summary).toBe("Chosen summary");
    expect(fixture.issue.fields.description).toEqual(originalDocument);
    expect(fixture.store.tasks.getTask(source.taskId)?.status).toBe("backlog");
    const convergent = await fixture.preview(pushed.source, {
      kind: "fields",
      summary: "Chosen summary",
      description: null,
    });
    expect(
      (
        await fixture.jira.jiraPush({
          taskId: source.taskId,
          previewId: convergent.preview.id,
        })
      ).operation.state,
    ).toBe("applied");
    expect(fixture.state.writes).toBe(1);
  });

  it("rejects stale editor revisions and previews changed on Jira", async () => {
    const fixture = setup();
    const { source } = await fixture.importIssue();
    const preview = await fixture.preview(source, {
      kind: "fields",
      summary: "Proposed",
      description: null,
    });
    await expect(
      fixture.jira.jiraDraft({
        taskId: source.taskId,
        expectedRevision: source.revision,
        proposal: null,
      }),
    ).rejects.toThrow("changed");
    fixture.issue.fields.summary = "New remote value";
    await expect(
      fixture.jira.jiraPush({
        taskId: source.taskId,
        previewId: preview.preview.id,
      }),
    ).rejects.toThrow("after preview");
    expect(fixture.state.writes).toBe(0);
    expect(
      (await fixture.jira.jiraSource({ taskId: source.taskId })).source
        ?.preview,
    ).toBeNull();
  });

  it("enforces connection project restrictions again after a linked card moves", async () => {
    const fixture = setup();
    await expect(
      fixture.jira.jiraImport({
        connectionId: fixture.config.id,
        issue: "DEMO-1",
        projectId: fixture.other.id,
        taskId: null,
      }),
    ).rejects.toThrow("not enabled");
    expect(fixture.state.reads).toBe(0);
    const { source } = await fixture.importIssue();
    const preview = await fixture.preview(source, {
      kind: "comment",
      body: "Proposed comment",
    });
    fixture.store.tasks.moveTaskToProject(source.taskId, fixture.other.id);
    await expect(
      fixture.jira.jiraPush({
        taskId: source.taskId,
        previewId: preview.preview.id,
      }),
    ).rejects.toThrow("not enabled");
    await expect(
      fixture.jira.jiraPull({
        taskId: source.taskId,
        expectedRevision: preview.source.revision,
      }),
    ).rejects.toThrow("not enabled");
    expect(fixture.state.writes).toBe(0);
  });

  it("retains successful snapshots and records missing credentials and inaccessible issues", async () => {
    const fixture = setup();
    const { source } = await fixture.importIssue();
    rmSync(fixture.config.credentialFile);
    expect((await fixture.jira.jiraConnections({})).connections[0]?.ready).toBe(
      false,
    );
    await expect(
      fixture.jira.jiraPull({
        taskId: source.taskId,
        expectedRevision: source.revision,
      }),
    ).rejects.toThrow("credentials");
    let stored = (await fixture.jira.jiraSource({ taskId: source.taskId }))
      .source!;
    expect(stored.remote).toEqual(source.remote);
    expect(stored.lastError).toContain("credentials");
    writeFileSync(
      fixture.config.credentialFile,
      "JIRA_ACCOUNT_EMAIL=synthetic@example.invalid\nJIRA_API_TOKEN=synthetic-test-only\n",
    );
    fixture.state.readStatus = 404;
    await expect(
      fixture.jira.jiraPull({
        taskId: source.taskId,
        expectedRevision: stored.revision,
      }),
    ).rejects.toThrow("404");
    stored = (await fixture.jira.jiraSource({ taskId: source.taskId })).source!;
    expect(stored.remote).toEqual(source.remote);
    expect(stored.lastError).not.toContain("fixture body");
  });

  it("journals uncertain comments, blocks replay, and reconciles by operation property", async () => {
    const fixture = setup();
    const { source } = await fixture.importIssue();
    const preview = await fixture.preview(source, {
      kind: "comment",
      body: "Exactly one comment",
    });
    fixture.state.writeMode = "timeout";
    const pushed = await fixture.jira.jiraPush({
      taskId: source.taskId,
      previewId: preview.preview.id,
    });
    expect(pushed.operation.state).toBe("uncertain");
    const repeated = await fixture.jira.jiraPush({
      taskId: source.taskId,
      previewId: preview.preview.id,
    });
    expect(repeated.operation).toEqual(pushed.operation);
    expect(fixture.state.writes).toBe(1);
    await expect(
      fixture.jira.jiraDraft({
        taskId: source.taskId,
        expectedRevision: repeated.source.revision,
        proposal: null,
      }),
    ).rejects.toThrow("unresolved");
    const reconciled = await fixture.jira.jiraReconcile({
      taskId: source.taskId,
      operationId: pushed.operation.id,
    });
    expect(reconciled.operation.state).toBe("applied");
    expect(reconciled.operation.externalCommentId).toBe("200");
    expect(fixture.comments).toHaveLength(1);
    expect(fixture.state.writes).toBe(1);
  });

  it("claims a preview only once under concurrent push and returns its applied receipt", async () => {
    const fixture = setup();
    const { source } = await fixture.importIssue();
    const preview = await fixture.preview(source, {
      kind: "comment",
      body: "Concurrent comment",
    });
    const results = await Promise.all([
      fixture.jira.jiraPush({
        taskId: source.taskId,
        previewId: preview.preview.id,
      }),
      fixture.jira.jiraPush({
        taskId: source.taskId,
        previewId: preview.preview.id,
      }),
    ]);
    expect(results[0]?.operation.id).toBe(results[1]?.operation.id);
    const repeated = await fixture.jira.jiraPush({
      taskId: source.taskId,
      previewId: preview.preview.id,
    });
    expect(repeated.operation.state).toBe("applied");
    expect(fixture.state.writes).toBe(1);
  });

  it("keeps failed readback uncertain and explicit permission rejection failed", async () => {
    const fixture = setup();
    const { source } = await fixture.importIssue();
    const preview = await fixture.preview(source, {
      kind: "fields",
      summary: "Write then lose readback",
      description: null,
    });
    fixture.state.writeMode = "readback";
    const pushed = await fixture.jira.jiraPush({
      taskId: source.taskId,
      previewId: preview.preview.id,
    });
    expect(pushed.operation.state).toBe("uncertain");
    expect(pushed.source.remote.summary).toBe("Remote summary");
    fixture.state.readStatus = 200;
    const reconciled = await fixture.jira.jiraReconcile({
      taskId: source.taskId,
      operationId: pushed.operation.id,
    });
    expect(reconciled.operation.state).toBe("applied");
    const second = await fixture.preview(reconciled.source, {
      kind: "comment",
      body: "Denied comment",
    });
    fixture.state.writeMode = "reject";
    const rejected = await fixture.jira.jiraPush({
      taskId: source.taskId,
      previewId: second.preview.id,
    });
    expect(rejected.operation.state).toBe("failed");
    expect(rejected.operation.message).toContain("403");
    expect(JSON.stringify(rejected)).not.toContain("must not leak");
  });

  it("does not resolve an unobserved outcome or replay an interrupted journal entry", async () => {
    const fixture = setup();
    const { source } = await fixture.importIssue();
    const preview = await fixture.preview(source, {
      kind: "comment",
      body: "Unknown outcome",
    });
    fixture.state.writeMode = "timeout-before";
    const pushed = await fixture.jira.jiraPush({
      taskId: source.taskId,
      previewId: preview.preview.id,
    });
    fixture.bb.storage
      .database()
      .prepare<[string]>(
        "UPDATE jira_operations SET state = 'sending' WHERE id = ?",
      )
      .run(pushed.operation.id);
    new JiraStore(
      fixture.bb.storage.database(),
      fixture.store,
    ).recoverInterrupted();
    expect(
      (
        await fixture.jira.jiraReconcile({
          taskId: source.taskId,
          operationId: pushed.operation.id,
        })
      ).operation.state,
    ).toBe("uncertain");
    expect(
      (
        await fixture.jira.jiraPush({
          taskId: source.taskId,
          previewId: preview.preview.id,
        })
      ).operation.state,
    ).toBe("uncertain");
    expect(fixture.state.writes).toBe(1);
  });

  it("previews valid transitions separately and never mirrors Done into local status", async () => {
    const fixture = setup();
    const { source } = await fixture.importIssue();
    expect(
      (await fixture.jira.jiraTransitions({ taskId: source.taskId }))
        .transitions[0]?.id,
    ).toBe("finish");
    const preview = await fixture.preview(source, {
      kind: "transition",
      transitionId: "finish",
      toStatusId: "done",
    });
    const result = await fixture.jira.jiraPush({
      taskId: source.taskId,
      previewId: preview.preview.id,
    });
    expect(result.operation.state).toBe("applied");
    expect(result.source.remote.statusId).toBe("done");
    expect(fixture.store.tasks.getTask(source.taskId)?.status).toBe("backlog");
  });

  it("reports bounded comment truncation and rejects unsafe operator configuration", async () => {
    const fixture = setup();
    fixture.state.commentTotal = 75;
    expect((await fixture.importIssue()).source.remote.commentsTruncated).toBe(
      true,
    );
    const path = join(fixture.directory, "connections.json");
    writeFileSync(
      path,
      JSON.stringify({
        connections: [{ ...fixture.config, siteUrl: "https://evil.invalid/" }],
      }),
    );
    expect(loadJiraConfiguration(path).error).toContain("invalid");
    writeFileSync(path, JSON.stringify({ connections: [fixture.config] }));
    expect(loadJiraConfiguration(path).connections).toHaveLength(1);
    expect(loadJiraConfiguration("relative.json").error).toContain("absolute");
  });

  it("rolls back native task creation if source association cannot commit", async () => {
    const fixture = setup();
    const database = fixture.bb.storage.database();
    database.exec(
      "CREATE TRIGGER reject_source BEFORE INSERT ON jira_sources BEGIN SELECT RAISE(ABORT, 'Synthetic source failure'); END",
    );
    await expect(fixture.importIssue()).rejects.toThrow(
      "Synthetic source failure",
    );
    expect(
      database
        .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM tasks")
        .get()?.count,
    ).toBe(0);
    database.exec("DROP TRIGGER reject_source");
    const imported = await fixture.importIssue();
    expect(imported.source.taskKey).toBe("SYN-1");
  });

  it("writes explicit plain-text description replacements and preserves trailing whitespace", async () => {
    const fixture = setup();
    const { source } = await fixture.importIssue();
    const description = "Replacement line  \nSecond line\n";
    const preview = await fixture.preview(source, {
      kind: "fields",
      summary: null,
      description,
    });
    const result = await fixture.jira.jiraPush({
      taskId: source.taskId,
      previewId: preview.preview.id,
    });
    expect(result.operation.state).toBe("applied");
    expect(result.source.remote.description).toBe(description);
    expect(JSON.parse(result.source.remote.descriptionDocument!)).toEqual(
      textDocument(description),
    );
    expect(result.source.remote.summary).toBe("Remote summary");
  });

  it("accepts a concurrent convergent edit and rejects a withdrawn transition", async () => {
    const fixture = setup();
    const { source } = await fixture.importIssue();
    const draft = await fixture.jira.jiraDraft({
      taskId: source.taskId,
      expectedRevision: source.revision,
      proposal: { kind: "fields", summary: "Converged", description: null },
    });
    fixture.issue.fields.summary = "Converged";
    const preview = await fixture.jira.jiraPreview({
      taskId: source.taskId,
      expectedRevision: draft.source.revision,
    });
    expect(preview.preview.changes[0]?.conflict).toBe(false);
    const result = await fixture.jira.jiraPush({
      taskId: source.taskId,
      previewId: preview.preview.id,
    });
    expect(result.operation.state).toBe("applied");
    expect(fixture.state.writes).toBe(0);
    const transition = await fixture.preview(result.source, {
      kind: "transition",
      transitionId: "finish",
      toStatusId: "done",
    });
    fixture.state.transitionAvailable = false;
    await expect(
      fixture.jira.jiraPush({
        taskId: source.taskId,
        previewId: transition.preview.id,
      }),
    ).rejects.toThrow("no longer available");
    expect(fixture.state.writes).toBe(0);
  });
});
