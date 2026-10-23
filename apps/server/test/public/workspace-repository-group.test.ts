import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { TransferWorkspaceResponse } from "@bb/server-contract";
import {
  registerWorkspaceRepositoryGroup,
  repositoryWorkspacePaths,
  assertRepositoryGroupAdmission,
  assertRepositoryTargetUnowned,
  mayHaveWorkspaceRepositoryGroups,
} from "../../src/services/projects/workspace-repository-group.js";
import { withTestHarness } from "../helpers/test-app.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";

function operation(
  projectId: string,
  sourceEnvironmentId: string,
  environmentId: string,
  hostId: string,
  rootPath: string,
): TransferWorkspaceResponse {
  return {
    operationId: `wtx_${environmentId}`,
    projectId,
    sourceEnvironmentId,
    environmentId,
    sourceHostId: hostId,
    targetHostId: hostId,
    hostId,
    targetPath: rootPath,
    rootPath,
    createdAt: 1,
    updatedAt: 1,
    status: "ready",
    head: "a".repeat(40),
    branch: "bb/task-isolated",
    handoff: "Verified source-preserving transfer",
  };
}

describe("coherent workspace ownership", () => {
  it("keeps ordinary single-root admission independent of asynchronous registry filesystem work", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHostSession(harness.deps, {
        id: "host-ordinary-admission",
      }).host;
      const project = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      }).project;
      const sourceA = seedEnvironment(harness.deps, {
        projectId: project.id,
        hostId: host.id,
        path: "/source/a",
      });
      const sourceB = seedEnvironment(harness.deps, {
        projectId: project.id,
        hostId: host.id,
        path: "/source/b",
      });
      const targetA = seedEnvironment(harness.deps, {
        projectId: project.id,
        hostId: host.id,
        path: "/target/a",
      });
      const targetB = seedEnvironment(harness.deps, {
        projectId: project.id,
        hostId: host.id,
        path: "/target/b",
      });
      const scan = vi.spyOn(fs, "readdir").mockImplementation(async () => {
        throw new Error(
          "Ordinary dispatch must not depend on asynchronous group scans",
        );
      });
      const create = vi.spyOn(fs, "mkdir").mockImplementation(async () => {
        throw new Error("Ordinary dispatch must not create a group registry");
      });
      try {
        expect(mayHaveWorkspaceRepositoryGroups(harness.deps)).toBe(false);
        await expect(
          repositoryWorkspacePaths(harness.deps, targetA.id, "thr_ordinary"),
        ).resolves.toEqual([]);
        await expect(
          assertRepositoryGroupAdmission(
            harness.deps,
            targetA.id,
            "thr_ordinary",
          ),
        ).resolves.toBeUndefined();
        await expect(
          repositoryWorkspacePaths(harness.deps, targetA.id, "thr_ordinary"),
        ).resolves.toEqual([]);
        expect(scan).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
      } finally {
        scan.mockRestore();
        create.mockRestore();
      }
      await expect(
        fs.stat(
          path.join(harness.deps.config.dataDir, "workspace-repository-groups"),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await registerWorkspaceRepositoryGroup(harness.deps, [
        operation(project.id, sourceA.id, targetA.id, host.id, "/target/a"),
        operation(project.id, sourceB.id, targetB.id, host.id, "/target/b"),
      ]);
      expect(mayHaveWorkspaceRepositoryGroups(harness.deps)).toBe(true);
      const unrelated = seedEnvironment(harness.deps, {
        projectId: project.id,
        hostId: host.id,
        path: "/ordinary",
      });
      expect(mayHaveWorkspaceRepositoryGroups(harness.deps, unrelated.id)).toBe(
        false,
      );
      expect(mayHaveWorkspaceRepositoryGroups(harness.deps, sourceA.id)).toBe(
        true,
      );
      expect(mayHaveWorkspaceRepositoryGroups(harness.deps, targetA.id)).toBe(
        true,
      );
      expect(
        await repositoryWorkspacePaths(
          harness.deps,
          targetA.id,
          "thr_coherent",
        ),
      ).toEqual(["/target/b"]);
      await expect(
        assertRepositoryGroupAdmission(harness.deps, targetB.id, "thr_other"),
      ).rejects.toThrow("one coherent writer");
    });
  });
  it("admits one writer for all roots, durably records it, and refuses sibling writers and terminal admission", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHostSession(harness.deps, {
        id: "host-repository-group",
      }).host;
      const first = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      }).project;
      const second = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      }).project;
      const sourceA = seedEnvironment(harness.deps, {
        projectId: first.id,
        hostId: host.id,
        path: "/source/a",
      });
      const sourceB = seedEnvironment(harness.deps, {
        projectId: second.id,
        hostId: host.id,
        path: "/source/b",
      });
      const targetA = seedEnvironment(harness.deps, {
        projectId: first.id,
        hostId: host.id,
        path: "/target/a",
      });
      const targetB = seedEnvironment(harness.deps, {
        projectId: second.id,
        hostId: host.id,
        path: "/target/b",
      });
      const writer = seedThread(harness.deps, {
        projectId: first.id,
        environmentId: targetA.id,
        status: "idle",
      });
      const rival = seedThread(harness.deps, {
        projectId: first.id,
        environmentId: targetA.id,
        status: "idle",
      });
      const operations = [
        operation(first.id, sourceA.id, targetA.id, host.id, "/target/a"),
        operation(second.id, sourceB.id, targetB.id, host.id, "/target/b"),
      ];
      await registerWorkspaceRepositoryGroup(harness.deps, operations);
      expect(
        await repositoryWorkspacePaths(harness.deps, targetA.id, writer.id),
      ).toEqual(["/target/b"]);
      const attempts = await Promise.allSettled([
        assertRepositoryGroupAdmission(harness.deps, targetA.id, writer.id),
        assertRepositoryGroupAdmission(harness.deps, targetA.id, rival.id),
      ]);
      expect(
        attempts.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const manifest = JSON.parse(
        await fs.readFile(
          path.join(
            harness.deps.config.dataDir,
            "workspace-repository-groups",
            `${targetA.id}.json`,
          ),
          "utf8",
        ),
      );
      expect([writer.id, rival.id]).toContain(manifest.writerThreadId);
      expect(manifest.roots.map((root: { path: string }) => root.path)).toEqual(
        ["/target/a", "/target/b"],
      );
      await expect(
        assertRepositoryGroupAdmission(
          harness.deps,
          targetB.id,
          "thr_second_writer",
        ),
      ).rejects.toThrow("one coherent writer");
      await expect(
        assertRepositoryGroupAdmission(harness.deps, targetA.id),
      ).rejects.toThrow("one coherent writer");
      await expect(
        registerWorkspaceRepositoryGroup(
          harness.deps,
          [...operations].reverse(),
        ),
      ).rejects.toThrow("already bound");
      for (const target of ["/target/a", "/target/a/nested", "/target"])
        await expect(
          assertRepositoryTargetUnowned(harness.deps, host.id, target),
        ).rejects.toThrow("overlaps");
      await expect(
        assertRepositoryTargetUnowned(harness.deps, host.id, "/other-target"),
      ).resolves.toBeUndefined();
    });
  });
  it("blocks the coherent executor when a different source root has active work", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHostSession(harness.deps, {
        id: "host-source-admission",
      }).host;
      const project = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      }).project;
      const sourceA = seedEnvironment(harness.deps, {
        projectId: project.id,
        hostId: host.id,
        path: "/source/a",
      });
      const sourceB = seedEnvironment(harness.deps, {
        projectId: project.id,
        hostId: host.id,
        path: "/source/b",
      });
      const targetA = seedEnvironment(harness.deps, {
        projectId: project.id,
        hostId: host.id,
        path: "/target/a",
      });
      const targetB = seedEnvironment(harness.deps, {
        projectId: project.id,
        hostId: host.id,
        path: "/target/b",
      });
      await registerWorkspaceRepositoryGroup(harness.deps, [
        operation(project.id, sourceA.id, targetA.id, host.id, "/target/a"),
        operation(project.id, sourceB.id, targetB.id, host.id, "/target/b"),
      ]);
      seedThread(harness.deps, {
        projectId: project.id,
        environmentId: sourceB.id,
        status: "active",
      });
      await expect(
        assertRepositoryGroupAdmission(harness.deps, targetA.id, "thr_writer"),
      ).rejects.toThrow("every bound source");
      expect(
        await repositoryWorkspacePaths(
          harness.deps,
          sourceA.id,
          "thr_unrelated",
        ),
      ).toEqual([]);
    });
  });
  it("refuses disconnected hosts and duplicate/nested roots before exposing native write directories", async () => {
    await withTestHarness(async (harness) => {
      const first = operation(
        "proj_a",
        "env_source_a",
        "env_a",
        "host_a",
        "/target/a",
      );
      const second = operation(
        "proj_b",
        "env_source_b",
        "env_b",
        "host_b",
        "/target/b",
      );
      await expect(
        registerWorkspaceRepositoryGroup(harness.deps, [first, second]),
      ).rejects.toThrow("same execution host");
      await expect(
        registerWorkspaceRepositoryGroup(harness.deps, [
          first,
          { ...second, hostId: "host_a", rootPath: "/target/a/nested" },
        ]),
      ).rejects.toThrow("non-nested");
      expect(
        await repositoryWorkspacePaths(harness.deps, "env_a", "thr_writer"),
      ).toEqual([]);
    });
  });
});
