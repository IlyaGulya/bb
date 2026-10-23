import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  getEnvironment,
  getProjectSourceByHost,
  listEnvironments,
  listPublicProjects,
  setProjectGitRemoteUrlIfMissing,
  threads,
} from "@bb/db";
import {
  prepareMachineResponseSchema,
  workspaceTransferOperationSchema,
} from "@bb/server-contract";
import { assertWorkspaceTransferAdmission } from "../../src/services/projects/workspace-transfer-locks.js";
import {
  assertWorkspaceContinuationAdmission,
  rememberWorkspaceContinuation,
  workspaceContinuationAdmissionRequired,
} from "../../src/services/projects/workspace-transfer-admission.js";
import { createWorkspaceContinuationThread } from "../../src/services/projects/workspace-transfer.js";
import {
  listQueuedCommands,
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedPrimaryHost,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const head = "a".repeat(40);
const bundle = Buffer.from("fixture bundle");
const checkpoint = {
  version: 1 as const,
  head,
  branch: "main",
  bundleBase64: bundle.toString("base64"),
  bundleSha256: createHash("sha256").update(bundle).digest("hex"),
  index: [],
  worktree: [],
  extraFiles: [],
  lfsPaths: [],
  filePermissions: [],
};
function request(projectId: string, action: string, body: object) {
  return new Request(
    `http://localhost/api/v1/projects/${projectId}/${action}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

describe("workspace transfers", () => {
  it("does not delay ordinary dispatch on an absent transfer registry and activates ownership when a transfer is later remembered", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHostSession(harness.deps).host;
      const project = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      }).project;
      const source = seedEnvironment(harness.deps, {
        projectId: project.id,
        hostId: host.id,
        path: "/ordinary-source",
      });
      const target = seedEnvironment(harness.deps, {
        projectId: project.id,
        hostId: host.id,
        path: "/later-target",
      });
      const scan = vi.spyOn(fs, "readdir").mockImplementation(async () => {
        throw new Error(
          "Ordinary dispatch must not wait on transfer registry I/O",
        );
      });
      try {
        expect(
          workspaceContinuationAdmissionRequired(harness.deps, source.id),
        ).toBe(false);
        await expect(
          assertWorkspaceContinuationAdmission(harness.deps, source.id),
        ).resolves.toBeUndefined();
        expect(scan).not.toHaveBeenCalled();
        await rememberWorkspaceContinuation(harness.deps, {
          operationId: `wtx_${randomUUID()}`,
          projectId: project.id,
          sourceEnvironmentId: source.id,
          sourceHostId: host.id,
          targetHostId: host.id,
          targetPath: "/later-target",
          environmentId: target.id,
          hostId: host.id,
          rootPath: "/later-target",
          createdAt: 1,
          updatedAt: 1,
          status: "ready",
          head,
          branch: "bb/later",
          handoff: "Verified fixture",
        });
        expect(
          workspaceContinuationAdmissionRequired(harness.deps, source.id),
        ).toBe(true);
        expect(
          workspaceContinuationAdmissionRequired(harness.deps, target.id),
        ).toBe(true);
        seedThread(harness.deps, {
          projectId: project.id,
          environmentId: target.id,
          status: "active",
        });
        await expect(
          assertWorkspaceContinuationAdmission(harness.deps, source.id),
        ).rejects.toThrow("other workspace");
        expect(scan).not.toHaveBeenCalled();
      } finally {
        scan.mockRestore();
      }
    });
  });
  it("transfers into a new environment in the same project and durably returns only verified handoff", async () => {
    await withTestHarness(async (harness) => {
      const sourceHost = seedHostSession(harness.deps, {
        id: "host-workspace-source",
      }).host;
      const targetHost = seedHostSession(harness.deps, {
        id: "host-workspace-target",
      }).host;
      seedPrimaryHost(harness.deps, sourceHost.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: sourceHost.id,
      });
      const source = seedEnvironment(harness.deps, {
        projectId: project.id,
        hostId: sourceHost.id,
        path: "/source/repo",
      });
      seedThread(harness.deps, {
        projectId: project.id,
        environmentId: source.id,
        status: "idle",
      });
      const input = {
        sourceEnvironmentId: source.id,
        targetHostId: targetHost.id,
        targetPath: "/target/continued",
        includePaths: ["fixture.bin"],
      };
      const responsePromise = harness.app.fetch(
        request(project.id, "transfer-workspace", input),
      );
      const capture = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "workspace.capture",
      );
      expect(capture.command).toMatchObject({
        rootPath: "/source/repo",
        includePaths: ["fixture.bin"],
      });
      expect(() =>
        assertWorkspaceTransferAdmission(harness.db, source.id),
      ).toThrow("being transferred");
      expect(
        (
          await harness.app.fetch(
            request(project.id, "transfer-workspace", input),
          )
        ).status,
      ).toBe(409);
      await reportQueuedCommandSuccess(harness, capture, { checkpoint });
      const restore = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "workspace.restore",
      );
      expect(restore.command).toMatchObject({
        targetPath: input.targetPath,
        checkpoint,
      });
      expect(
        listEnvironments(harness.db, { projectId: project.id }),
      ).toHaveLength(1);
      await reportQueuedCommandSuccess(harness, restore, {
        rootPath: input.targetPath,
        head,
        branch: "main",
      });
      const response = await responsePromise;
      expect(response.status).toBe(200);
      const result = workspaceTransferOperationSchema.parse(
        await readJson(response),
      );
      expect(result.status).toBe("ready");
      if (result.status !== "ready") throw new Error("Expected ready transfer");
      expect(result.handoff).toContain("No running process, native session");
      expect(getEnvironment(harness.db, result.environmentId)).toMatchObject({
        projectId: project.id,
        hostId: targetHost.id,
        path: input.targetPath,
        status: "ready",
        providerOwnsPath: false,
      });
      expect(getEnvironment(harness.db, source.id)).toMatchObject({
        hostId: sourceHost.id,
        path: "/source/repo",
      });
      expect(listPublicProjects(harness.db)).toHaveLength(1);
      const durable = await harness.app.request(
        `/api/v1/workspace-transfers/${result.operationId}`,
      );
      expect(await readJson(durable)).toEqual(result);
      const savedCheckpoint = await fs.readFile(
        path.join(
          harness.deps.config.dataDir,
          "workspace-transfers",
          `${result.operationId}.checkpoint`,
        ),
      );
      expect(JSON.parse(savedCheckpoint.toString("utf8"))).toEqual(checkpoint);
      expect(result.checkpointSha256).toBe(
        createHash("sha256").update(savedCheckpoint).digest("hex"),
      );
      expect(result.checkpointBytes).toBe(savedCheckpoint.length);
      expect(() =>
        assertWorkspaceTransferAdmission(harness.db, source.id),
      ).not.toThrow();
      const spawnRequest = {
        projectId: project.id,
        environment: {
          type: "reuse" as const,
          environmentId: result.environmentId,
        },
        transferOperationId: result.operationId,
      };
      let created = 0;
      const create = async () => {
        expect(() =>
          assertWorkspaceTransferAdmission(harness.db, source.id),
        ).toThrow("being transferred");
        created += 1;
        return seedThread(harness.deps, {
          projectId: project.id,
          environmentId: result.environmentId,
          status: "starting",
        });
      };
      const targetThread = await createWorkspaceContinuationThread(
        harness.deps,
        spawnRequest,
        create,
      );
      expect(
        (
          await createWorkspaceContinuationThread(
            harness.deps,
            spawnRequest,
            create,
          )
        ).id,
      ).toBe(targetThread.id);
      expect(created).toBe(1);
      await expect(
        assertWorkspaceContinuationAdmission(harness.deps, source.id),
      ).rejects.toThrow("other workspace");
      await expect(
        assertWorkspaceContinuationAdmission(
          harness.deps,
          result.environmentId,
          targetThread.id,
        ),
      ).resolves.toBeUndefined();
      await expect(
        assertWorkspaceContinuationAdmission(
          harness.deps,
          result.environmentId,
        ),
      ).rejects.toThrow("already has a writer");
      expect(
        await readJson(
          await harness.app.request(
            `/api/v1/workspace-transfers/${result.operationId}`,
          ),
        ),
      ).toMatchObject({
        continuationThreadId: targetThread.id,
        status: "ready",
      });
    });
  });

  it("refuses any active source thread without dispatching capture and journals the refusal", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHostSession(harness.deps, {
        id: "host-active-source",
      }).host;
      seedPrimaryHost(harness.deps, host.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const source = seedEnvironment(harness.deps, {
        projectId: project.id,
        hostId: host.id,
      });
      seedThread(harness.deps, {
        projectId: project.id,
        environmentId: source.id,
        status: "idle",
      });
      seedThread(harness.deps, {
        projectId: project.id,
        environmentId: source.id,
        status: "active",
      });
      const response = await harness.app.fetch(
        request(project.id, "transfer-workspace", {
          sourceEnvironmentId: source.id,
          targetHostId: host.id,
          targetPath: "/new/repo",
          includePaths: [],
        }),
      );
      expect(response.status).toBe(409);
      expect(listQueuedCommands(harness, "workspace.capture")).toEqual([]);
      const error = z
        .object({ details: z.object({ operationId: z.string() }) })
        .parse(await readJson(response));
      const durable = await harness.app.request(
        `/api/v1/workspace-transfers/${error.details.operationId}`,
      );
      expect(await readJson(durable)).toMatchObject({
        status: "failed",
        error: expect.stringContaining("Stop all source workspace threads"),
      });
    });
  });

  it("preserves failed targets for inspection and never registers an environment after restore refusal", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHostSession(harness.deps, {
        id: "host-refused-transfer",
      }).host;
      seedPrimaryHost(harness.deps, host.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const source = seedEnvironment(harness.deps, {
        projectId: project.id,
        hostId: host.id,
      });
      const operationId = `wtx_${randomUUID()}`;
      const remoteBase = {
        url: "https://approved.example.test/team/repository.git",
        ref: "refs/heads/main",
        head,
      };
      const captured = { ...checkpoint, remoteBase };
      const responsePromise = harness.app.fetch(
        request(project.id, "transfer-workspace", {
          operationId,
          remoteBase,
          sourceEnvironmentId: source.id,
          targetHostId: host.id,
          targetPath: "/existing/repo",
          includePaths: [],
        }),
      );
      const capture = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "workspace.capture",
      );
      expect(capture.command).toMatchObject({ remoteBase });
      await reportQueuedCommandSuccess(harness, capture, {
        checkpoint: captured,
      });
      const restore = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "workspace.restore",
      );
      await reportQueuedCommandError(harness, restore, {
        errorCode: "target_exists",
        errorMessage: "Target already exists; choose a new path",
      });
      const response = await responsePromise;
      expect(response.status).toBe(502);
      expect(
        listEnvironments(harness.db, { projectId: project.id }),
      ).toHaveLength(1);
      expect(await readJson(response)).toMatchObject({
        details: { sourcePreserved: true, targetPath: "/existing/repo" },
      });
      const saved = await fs.readFile(
        path.join(
          harness.deps.config.dataDir,
          "workspace-transfers",
          `${operationId}.checkpoint`,
        ),
      );
      expect(JSON.parse(saved.toString("utf8"))).toEqual(captured);
      const durable = workspaceTransferOperationSchema.parse(
        await readJson(
          await harness.app.request(
            `/api/v1/workspace-transfers/${operationId}`,
          ),
        ),
      );
      expect(durable).toMatchObject({
        status: "failed",
        remoteBase,
        checkpointSha256: createHash("sha256").update(saved).digest("hex"),
        checkpointBytes: saved.length,
      });
      const duplicate = await harness.app.fetch(
        request(project.id, "transfer-workspace", {
          operationId,
          sourceEnvironmentId: source.id,
          targetHostId: host.id,
          targetPath: "/different/fresh-path",
          includePaths: [],
          remoteBase,
        }),
      );
      expect(duplicate.status).toBe(409);
      expect(
        workspaceTransferOperationSchema.parse(
          await readJson(
            await harness.app.request(
              `/api/v1/workspace-transfers/${operationId}`,
            ),
          ),
        ),
      ).toEqual(durable);
    });
  });
  it("reloads symmetric execution fencing from a ready journal after restart", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHostSession(harness.deps, {
        id: "host-restarted-continuation",
      }).host;
      seedPrimaryHost(harness.deps, host.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const source = seedEnvironment(harness.deps, {
        projectId: project.id,
        hostId: host.id,
        path: "/source/restarted",
      });
      const target = seedEnvironment(harness.deps, {
        projectId: project.id,
        hostId: host.id,
        path: "/target/restarted",
      });
      const sourceThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: source.id,
        status: "idle",
      });
      const targetThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: target.id,
        status: "active",
      });
      const operationId = `wtx_${randomUUID()}`;
      const directory = path.join(
        harness.config.dataDir,
        "workspace-transfers",
      );
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(
        path.join(directory, `${operationId}.json`),
        JSON.stringify({
          operationId,
          projectId: project.id,
          sourceEnvironmentId: source.id,
          sourceHostId: host.id,
          targetHostId: host.id,
          targetPath: target.path,
          createdAt: 1,
          updatedAt: 2,
          status: "ready",
          environmentId: target.id,
          hostId: host.id,
          rootPath: target.path,
          head,
          branch: "main",
          handoff: "Verified",
          continuationThreadId: targetThread.id,
        }),
      );
      await expect(
        assertWorkspaceContinuationAdmission(harness.deps, source.id),
      ).rejects.toThrow("other workspace");
      harness.db
        .update(threads)
        .set({ status: "idle" })
        .where(eq(threads.id, targetThread.id))
        .run();
      harness.db
        .update(threads)
        .set({ status: "starting" })
        .where(eq(threads.id, sourceThread.id))
        .run();
      await expect(
        assertWorkspaceContinuationAdmission(harness.deps, target.id),
      ).rejects.toThrow("other workspace");
      harness.db
        .update(threads)
        .set({ status: "idle" })
        .where(eq(threads.id, sourceThread.id))
        .run();
      await expect(
        assertWorkspaceContinuationAdmission(harness.deps, target.id),
      ).resolves.toBeUndefined();
    });
  });

  it("marks an unfinished durable journal interrupted after server restart", async () => {
    await withTestHarness(async (harness) => {
      const operationId = `wtx_${randomUUID()}`;
      const directory = path.join(
        harness.config.dataDir,
        "workspace-transfers",
      );
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(
        path.join(directory, `${operationId}.json`),
        JSON.stringify({
          operationId,
          projectId: "project",
          sourceEnvironmentId: "source",
          sourceHostId: "host",
          targetHostId: "target",
          targetPath: "/new/repo",
          createdAt: 1,
          updatedAt: 1,
          status: "transferring",
        }),
      );
      const response = await harness.app.request(
        `/api/v1/workspace-transfers/${operationId}`,
      );
      expect(await readJson(response)).toMatchObject({
        operationId,
        status: "interrupted",
        error: expect.stringContaining("source is preserved"),
      });
      expect(
        JSON.parse(
          await fs.readFile(
            path.join(directory, `${operationId}.json`),
            "utf8",
          ),
        ),
      ).toMatchObject({ status: "interrupted" });
      expect(
        (await harness.app.request("/api/v1/workspace-transfers/invalid-id"))
          .status,
      ).toBe(400);
    });
  });

  it("prepares a verified existing checkout and copies only explicit binary files before registration", async () => {
    await withTestHarness(async (harness) => {
      const first = seedHostSession(harness.deps, {
        id: "host-copy-source",
      }).host;
      const target = seedHostSession(harness.deps, {
        id: "host-copy-target",
      }).host;
      seedPrimaryHost(harness.deps, first.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: first.id,
      });
      const remoteUrl = "ssh://git.example.test/team/repo";
      setProjectGitRemoteUrlIfMissing(
        harness.db,
        harness.hub,
        project.id,
        remoteUrl,
      );
      const bytes = Buffer.from([0, 255, 128, 10]);
      const file = {
        path: "fixture.bin",
        contentBase64: bytes.toString("base64"),
        mode: "100755" as const,
        permissions: 0o755,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      const responsePromise = harness.app.fetch(
        request(project.id, "prepare-machine", {
          hostId: target.id,
          targetPath: "/target/repo",
          sourceHostId: first.id,
          copyPaths: [file.path],
        }),
      );
      const copyRead = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "workspace.copyRead",
      );
      expect(copyRead.command).toMatchObject({ paths: ["fixture.bin"] });
      await reportQueuedCommandSuccess(harness, copyRead, { files: [file] });
      const exists = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "host.paths_exist",
      );
      await reportQueuedCommandSuccess(harness, exists, {
        existence: { "/target/repo": true },
      });
      const inspect = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "project.inspect",
      );
      await reportQueuedCommandSuccess(harness, inspect, {
        path: "/target/repo",
        gitRemoteUrl: remoteUrl,
      });
      const preview = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "workspace.transferPreview",
      );
      await reportQueuedCommandSuccess(harness, preview, {
        head,
        branch: "main",
        files: [],
        activeThreadIds: [],
        maxPayloadBytes: 67108864,
      });
      const copyWrite = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "workspace.copyWrite",
      );
      expect(copyWrite.command).toMatchObject({
        rootPath: "/target/repo",
        files: [file],
      });
      expect(
        getProjectSourceByHost(harness.db, project.id, target.id),
      ).toBeNull();
      await reportQueuedCommandSuccess(harness, copyWrite, {
        files: [{ path: file.path, sha256: file.sha256 }],
      });
      const verified = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "project.inspect",
      );
      await reportQueuedCommandSuccess(harness, verified, {
        path: "/target/repo",
        gitRemoteUrl: remoteUrl,
      });
      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(
        prepareMachineResponseSchema.parse(await readJson(response)),
      ).toMatchObject({
        source: {
          projectId: project.id,
          hostId: target.id,
          path: "/target/repo",
        },
        copiedFiles: [{ path: file.path, sha256: file.sha256 }],
        readiness: {
          ready: true,
          checks: expect.arrayContaining([
            expect.objectContaining({ name: "additional-files", ok: true }),
          ]),
        },
      });
    });
  });

  it("requires explicit copy selection and same-project source membership", async () => {
    await withTestHarness(async (harness) => {
      const first = seedHostSession(harness.deps, {
        id: "host-prepare-source",
      }).host;
      const target = seedHostSession(harness.deps, {
        id: "host-prepare-target",
      }).host;
      seedPrimaryHost(harness.deps, first.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: first.id,
      });
      const response = await harness.app.fetch(
        request(project.id, "prepare-machine", {
          hostId: target.id,
          targetPath: "/new/repo",
          sourceHostId: target.id,
          copyPaths: [".env"],
        }),
      );
      expect(response.status).toBe(400);
      expect(listQueuedCommands(harness, "workspace.copyRead")).toEqual([]);
      expect(listQueuedCommands(harness, "project.clone")).toEqual([]);
    });
  });
});
