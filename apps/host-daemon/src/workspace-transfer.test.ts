import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  WORKSPACE_TRANSFER_MAX_BYTES,
  WORKSPACE_TRANSFER_MAX_SERIALIZED_BYTES,
  type WorkspaceTransferFile,
} from "@bb/host-daemon-contract";
import {
  assertWorkspaceTransferSerializedSize,
  captureWorkspace,
  copyWorkspaceRead,
  copyWorkspaceWrite,
  previewWorkspaceTransfer,
  restoreWorkspace,
} from "./workspace-transfer.js";
import { RuntimeManager } from "./runtime-manager.js";
import { dispatchOnlineRpcCommand } from "./command-dispatch.js";
import {
  createFakeRuntime,
  createFakeWorkspace,
  makeDispatchOptions,
} from "../test/command/dispatch-helpers.js";

const execute = promisify(execFile);
const roots: string[] = [];
async function git(root: string, ...args: string[]) {
  return (
    await execute("git", ["-C", root, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Workspace Test",
        GIT_AUTHOR_EMAIL: "workspace@example.test",
        GIT_COMMITTER_NAME: "Workspace Test",
        GIT_COMMITTER_EMAIL: "workspace@example.test",
      },
    })
  ).stdout;
}
async function fixture() {
  const base = await mkdtemp(
    path.join(tmpdir(), "bb-workspace-transfer-test-"),
  );
  roots.push(base);
  const source = path.join(base, "source");
  await mkdir(source);
  await git(source, "init", "-b", "main");
  await writeFile(
    path.join(source, "tracked.bin"),
    Buffer.from([0, 1, 255, 0, 13]),
  );
  await writeFile(path.join(source, "deleted.txt"), "delete me\n");
  await writeFile(path.join(source, "staged-delete.txt"), "staged delete\n");
  await writeFile(path.join(source, "script.sh"), "echo initial\n");
  await writeFile(path.join(source, ".gitignore"), "ignored/\n.env\n");
  await git(source, "add", ".");
  await git(source, "commit", "-m", "initial");
  return { base, source, target: path.join(base, "target") };
}
function file(
  relative: string,
  bytes = Buffer.from([0, 255, 1]),
): WorkspaceTransferFile {
  return {
    path: relative,
    contentBase64: bytes.toString("base64"),
    mode: "100755",
    permissions: 0o755,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("portable workspace checkpoints", () => {
  it("routes every workspace RPC and enforces local session and terminal admission", async () => {
    const { source, target } = await fixture();
    const { runtime, threadControls } = createFakeRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createFakeWorkspace(source).workspace,
    });
    await manager.ensureEnvironment({
      environmentId: "source-env",
      workspacePath: source,
    });
    const options = makeDispatchOptions({ runtimeManager: manager });
    const signal = new AbortController().signal;
    threadControls.setActiveTurn("source-thread", "active-turn");
    const preview = await dispatchOnlineRpcCommand<"workspace.transferPreview">(
      { type: "workspace.transferPreview", rootPath: source },
      options,
      signal,
    );
    expect(preview.activeThreadIds).toEqual(["source-thread"]);
    await expect(
      dispatchOnlineRpcCommand<"workspace.capture">(
        { type: "workspace.capture", rootPath: source, includePaths: [] },
        options,
        signal,
      ),
    ).rejects.toThrow("active local sessions");
    threadControls.endActiveTurn("source-thread");
    manager.markTerminalActive("source-env", "terminal");
    await expect(
      dispatchOnlineRpcCommand<"workspace.capture">(
        { type: "workspace.capture", rootPath: source, includePaths: [] },
        options,
        signal,
      ),
    ).rejects.toThrow("active local terminals");
    manager.markTerminalInactive("source-env", "terminal");
    const captured = await dispatchOnlineRpcCommand<"workspace.capture">(
      { type: "workspace.capture", rootPath: source, includePaths: [] },
      options,
      signal,
    );
    const restored = await dispatchOnlineRpcCommand<"workspace.restore">(
      {
        type: "workspace.restore",
        targetPath: target,
        checkpoint: captured.checkpoint,
      },
      options,
      signal,
    );
    expect(restored.head).toBe(captured.checkpoint.head);
    await writeFile(path.join(source, "copy.bin"), Buffer.from([0, 251]));
    const copied = await dispatchOnlineRpcCommand<"workspace.copyRead">(
      { type: "workspace.copyRead", rootPath: source, paths: ["copy.bin"] },
      options,
      signal,
    );
    await dispatchOnlineRpcCommand<"workspace.copyWrite">(
      { type: "workspace.copyWrite", rootPath: target, files: copied.files },
      options,
      signal,
    );
    expect(await readFile(path.join(target, "copy.bin"))).toEqual(
      Buffer.from([0, 251]),
    );
    await manager.shutdownAll();
  });

  it("carries unpublished HEAD, exact binary staged/unstaged state, modes, deletions, intent-to-add, and explicit ignored extras without writing source Git state", async () => {
    const { source, target } = await fixture();
    await writeFile(
      path.join(source, "local-only.txt"),
      "unpublished commit\n",
    );
    await git(source, "add", "local-only.txt");
    await git(source, "commit", "-m", "unpublished");
    await writeFile(
      path.join(source, "tracked.bin"),
      Buffer.from([0, 2, 254, 0, 10]),
    );
    await git(source, "add", "tracked.bin");
    await writeFile(
      path.join(source, "tracked.bin"),
      Buffer.from([0, 3, 253, 0, 13, 10]),
    );
    await rm(path.join(source, "deleted.txt"));
    await git(source, "rm", "staged-delete.txt");
    await chmod(path.join(source, "script.sh"), 0o755);
    await git(source, "add", "script.sh");
    await chmod(path.join(source, "script.sh"), 0o644);
    await writeFile(path.join(source, "intent.bin"), Buffer.from([0, 99, 255]));
    await git(source, "add", "-N", "intent.bin");
    await mkdir(path.join(source, "ignored"));
    await writeFile(
      path.join(source, "ignored", "selected.bin"),
      Buffer.from([0, 252, 11]),
    );
    await writeFile(path.join(source, ".env"), "NOT_SELECTED=private\n");
    const sourceIndex = await readFile(path.join(source, ".git", "index"));
    const sourceIndexTime = (await lstat(path.join(source, ".git", "index")))
      .mtimeMs;
    const { checkpoint } = await captureWorkspace(source, [
      "ignored/selected.bin",
    ]);
    expect(
      checkpoint.index.find((entry) => entry.path === "local-only.txt")
        ?.contentBase64,
    ).toBeUndefined();
    expect(
      checkpoint.index.find((entry) => entry.path === "intent.bin")
        ?.intentToAdd,
    ).toBe(true);
    const restored = await restoreWorkspace(target, checkpoint, "continued");
    expect(restored.branch).toBe("continued");
    expect(await git(target, "rev-parse", "HEAD")).toBe(
      await git(source, "rev-parse", "HEAD"),
    );
    expect(await git(target, "ls-files", "--stage")).toBe(
      await git(source, "ls-files", "--stage"),
    );
    expect(await git(target, "diff", "--binary", "--full-index")).toBe(
      await git(source, "diff", "--binary", "--full-index"),
    );
    expect(
      await git(target, "diff", "--cached", "--binary", "--full-index"),
    ).toBe(await git(source, "diff", "--cached", "--binary", "--full-index"));
    expect(await readFile(path.join(target, "tracked.bin"))).toEqual(
      await readFile(path.join(source, "tracked.bin")),
    );
    expect(
      await readFile(path.join(target, "ignored", "selected.bin")),
    ).toEqual(Buffer.from([0, 252, 11]));
    await expect(lstat(path.join(target, ".env"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(path.join(source, ".git", "index"))).toEqual(
      sourceIndex,
    );
    expect((await lstat(path.join(source, ".git", "index"))).mtimeMs).toBe(
      sourceIndexTime,
    );
  });

  it.skipIf(process.platform === "win32")(
    "preserves private permission bits for explicit copies and unchanged tracked files",
    async () => {
      const { source, target, base } = await fixture();
      await chmod(path.join(source, "tracked.bin"), 0o600);
      await writeFile(path.join(source, ".env"), "ONLY_TEST_DATA=selected\n", {
        mode: 0o600,
      });
      const copiedTarget = path.join(base, "copy-target");
      await mkdir(copiedTarget);
      const copied = await copyWorkspaceRead(source, [".env"]);
      await copyWorkspaceWrite(copiedTarget, copied.files);
      expect((await lstat(path.join(copiedTarget, ".env"))).mode & 0o777).toBe(
        0o600,
      );
      const { checkpoint } = await captureWorkspace(source, [".env"]);
      await restoreWorkspace(target, checkpoint);
      expect((await lstat(path.join(target, ".env"))).mode & 0o777).toBe(0o600);
      expect((await lstat(path.join(target, "tracked.bin"))).mode & 0o777).toBe(
        0o600,
      );
    },
  );

  it("preserves detached HEAD and a deleted intent-to-add worktree file", async () => {
    const { source, target } = await fixture();
    await git(source, "checkout", "--detach");
    await writeFile(path.join(source, "intent.bin"), "intent");
    await git(source, "add", "-N", "intent.bin");
    await rm(path.join(source, "intent.bin"));
    const { checkpoint } = await captureWorkspace(source, []);
    expect((await restoreWorkspace(target, checkpoint)).branch).toBeNull();
    expect(await git(target, "ls-files", "--stage")).toBe(
      await git(source, "ls-files", "--stage"),
    );
    await expect(lstat(path.join(target, "intent.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("requires explicit consent for tracked sensitive paths and never silently drops them", async () => {
    const { source, target } = await fixture();
    await writeFile(path.join(source, ".env"), "TEST_SECRET=selected\n");
    await git(source, "add", "-f", ".env");
    const preview = await previewWorkspaceTransfer(source);
    expect(preview.files.find((entry) => entry.path === ".env")).toMatchObject({
      kind: "sensitive-tracked",
      tracked: true,
      selectedByDefault: false,
      excludedReason: expect.stringContaining("Sensitive"),
    });
    await expect(captureWorkspace(source, [])).rejects.toThrow(
      "Tracked sensitive path .env",
    );
    const { checkpoint } = await captureWorkspace(source, [".env"]);
    await restoreWorkspace(target, checkpoint);
    expect(await readFile(path.join(target, ".env"), "utf8")).toBe(
      "TEST_SECRET=selected\n",
    );
  });

  it("refuses symlinks, gitlinks, unmerged entries, unsupported flags, and in-progress operations", async () => {
    const { source } = await fixture();
    await symlink("script.sh", path.join(source, "link"));
    await git(source, "add", "link");
    await expect(captureWorkspace(source, [])).rejects.toThrow("Symlinks");
    await git(source, "rm", "--cached", "link");
    await rm(path.join(source, "link"));
    const head = (await git(source, "rev-parse", "HEAD")).trim();
    await git(
      source,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${head},submodule`,
    );
    await expect(captureWorkspace(source, [])).rejects.toThrow("gitlinks");
    await git(source, "update-index", "--force-remove", "submodule");
    await git(source, "update-index", "--assume-unchanged", "script.sh");
    await expect(captureWorkspace(source, [])).rejects.toThrow(
      "Unsupported index flag",
    );
    await git(source, "update-index", "--no-assume-unchanged", "script.sh");
    await writeFile(path.join(source, ".git", "MERGE_HEAD"), `${head}\n`);
    await expect(captureWorkspace(source, [])).rejects.toThrow(
      "in-progress Git operation",
    );
    await rm(path.join(source, ".git", "MERGE_HEAD"));
    const blob = (await git(source, "rev-parse", "HEAD:script.sh")).trim();
    const unmergedIndex = `100644 ${blob} 1\tscript.sh\n100644 ${blob} 2\tscript.sh\n`;
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        "git",
        ["-C", source, "update-index", "--index-info"],
        (error) => (error ? reject(error) : resolve()),
      );
      child.stdin?.end(unmergedIndex);
    });
    await expect(captureWorkspace(source, [])).rejects.toThrow(
      "Unmerged index entry",
    );
  });

  it("refuses active sessions, overlapping captures, and source changes during capture", async () => {
    const preview = await previewWorkspaceTransfer((await fixture()).source, {
      activeThreadIds: () => ["preview-active"],
    });
    expect(preview.activeThreadIds).toEqual(["preview-active"]);
    const { source } = await fixture();
    await expect(
      captureWorkspace(source, [], {
        activeThreadIds: () => ["thread-active"],
      }),
    ).rejects.toThrow("active local sessions");
    const first = captureWorkspace(source, []);
    const second = captureWorkspace(source, []);
    const results = await Promise.allSettled([first, second]);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    let mutated = false;
    await expect(
      captureWorkspace(source, [], {
        activeThreadIds: () => {
          if (!mutated) {
            mutated = true;
            return [];
          }
          return ["became-active"];
        },
      }),
    ).rejects.toThrow("became active");
    const manager = new RuntimeManager();
    const release = manager.acquireWorkspaceCapture(source);
    await expect(
      manager.ensureEnvironment({
        environmentId: "blocked",
        workspacePath: source,
      }),
    ).rejects.toThrow("capture is in progress");
    await expect(
      manager.retainEnvironmentForThreadCommand("unknown", "thread"),
    ).rejects.toThrow("capture is in progress");
    release();
  });

  it("detects a source writer after snapshotting and preserves the writer's change", async () => {
    const { source, base, target } = await fixture();
    const binaries = path.join(base, "bin");
    await mkdir(binaries);
    const wrapper = path.join(binaries, "git");
    await writeFile(
      wrapper,
      `#!${process.execPath}\nconst fs = require("node:fs");\nconst { spawnSync } = require("node:child_process");\nconst args = process.argv.slice(2);\nif (args.includes("bundle") && args.includes("create")) fs.appendFileSync(${JSON.stringify(path.join(source, "script.sh"))}, "concurrent writer\\n");\nconst result = spawnSync("git", args, { env: { ...process.env, PATH: ${JSON.stringify(process.env.PATH ?? "")} }, stdio: "inherit" });\nprocess.exit(result.status ?? 1);\n`,
    );
    await chmod(wrapper, 0o755);
    await expect(
      captureWorkspace(source, [], {
        shellEnv: {
          PATH: `${binaries}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      }),
    ).rejects.toThrow("Source changed during capture");
    expect(await readFile(path.join(source, "script.sh"), "utf8")).toContain(
      "concurrent writer",
    );
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses sparse checkout, skip-worktree, custom filters, and missing LFS bytes", async () => {
    const { source } = await fixture();
    await git(source, "config", "remote.origin.promisor", "true");
    await expect(captureWorkspace(source, [])).rejects.toThrow(
      "Partial/promisor clones",
    );
    await git(source, "config", "remote.origin.promisor", "false");
    await git(source, "config", "core.sparseCheckout", "true");
    await expect(captureWorkspace(source, [])).rejects.toThrow(
      "Sparse checkouts",
    );
    await git(source, "config", "core.sparseCheckout", "false");
    await git(source, "update-index", "--skip-worktree", "script.sh");
    await expect(captureWorkspace(source, [])).rejects.toThrow(
      "Unsupported index flag",
    );
    await git(source, "update-index", "--no-skip-worktree", "script.sh");
    await writeFile(
      path.join(source, ".gitattributes"),
      "script.sh filter=custom\n",
    );
    await expect(captureWorkspace(source, [])).rejects.toThrow(
      "Custom Git clean/smudge filter",
    );
    await writeFile(path.join(source, ".gitattributes"), "*.bin filter=lfs\n");
    await writeFile(
      path.join(source, "tracked.bin"),
      "version https://git-lfs.github.com/spec/v1\noid sha256:0000000000000000000000000000000000000000000000000000000000000000\nsize 123\n",
    );
    await expect(captureWorkspace(source, [])).rejects.toThrow(
      "Git LFS content is missing",
    );
  });

  it("captures materialized LFS bytes and refuses missing target LFS or mismatched attributes", async () => {
    const { source, target, base } = await fixture();
    await writeFile(path.join(source, ".gitattributes"), "*.bin filter=lfs\n");
    await git(source, "add", ".gitattributes");
    const bytes = Buffer.from([0, 248, 2, 245]);
    await writeFile(path.join(source, "tracked.bin"), bytes);
    const { checkpoint } = await captureWorkspace(source, []);
    expect(checkpoint.lfsPaths).toContain("tracked.bin");
    expect(
      checkpoint.worktree.find((entry) => entry.path === "tracked.bin")?.file
        ?.contentBase64,
    ).toBe(bytes.toString("base64"));
    await expect(
      restoreWorkspace(target, { ...checkpoint, lfsPaths: [] }),
    ).rejects.toThrow("Restored LFS attributes differ");
    const binaries = path.join(base, "bin");
    await mkdir(binaries);
    const wrapper = path.join(binaries, "git");
    await writeFile(
      wrapper,
      `#!${process.execPath}\nconst { spawnSync } = require("node:child_process");\nconst args = process.argv.slice(2);\nif (args.includes("lfs") && args.includes("version")) process.exit(1);\nconst result = spawnSync("git", args, { env: { ...process.env, PATH: ${JSON.stringify(process.env.PATH ?? "")} }, stdio: "inherit" });\nprocess.exit(result.status ?? 1);\n`,
    );
    await chmod(wrapper, 0o755);
    await expect(
      restoreWorkspace(target, checkpoint, undefined, {
        shellEnv: {
          PATH: `${binaries}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      }),
    ).rejects.toThrow("Install Git LFS on the target machine");
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores file/directory replacements without overwriting the source", async () => {
    const { source, target } = await fixture();
    await git(source, "rm", "script.sh");
    await mkdir(path.join(source, "script.sh"));
    await writeFile(
      path.join(source, "script.sh", "nested.bin"),
      Buffer.from([0, 255]),
    );
    await git(source, "add", "script.sh/nested.bin");
    const { checkpoint } = await captureWorkspace(source, []);
    await restoreWorkspace(target, checkpoint);
    expect(
      await readFile(path.join(target, "script.sh", "nested.bin")),
    ).toEqual(Buffer.from([0, 255]));
    expect(await git(target, "ls-files", "--stage")).toBe(
      await git(source, "ls-files", "--stage"),
    );
  });

  it("rejects bundle/index/worktree corruption and existing targets without touching them", async () => {
    const { source, target } = await fixture();
    await writeFile(path.join(source, "tracked.bin"), Buffer.from([0, 222]));
    await git(source, "add", "tracked.bin");
    const { checkpoint } = await captureWorkspace(source, []);
    await expect(
      restoreWorkspace(target, { ...checkpoint, bundleSha256: "0".repeat(64) }),
    ).rejects.toThrow("bundle SHA-256 mismatch");
    const brokenIndex = checkpoint.index.map((entry) =>
      entry.path === "tracked.bin" ? { ...entry, oid: "f".repeat(40) } : entry,
    );
    await expect(
      restoreWorkspace(target, { ...checkpoint, index: brokenIndex }),
    ).rejects.toThrow("Index blob object hash mismatch");
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    const brokenWorktree = checkpoint.worktree.map((entry) =>
      entry.file
        ? { ...entry, file: { ...entry.file, sha256: "0".repeat(64) } }
        : entry,
    );
    await expect(
      restoreWorkspace(target, { ...checkpoint, worktree: brokenWorktree }),
    ).rejects.toThrow("File SHA-256 mismatch");
    await mkdir(target);
    await writeFile(path.join(target, "sentinel"), "preserved");
    await expect(restoreWorkspace(target, checkpoint)).rejects.toThrow(
      "Refusing to overwrite",
    );
    expect(await readFile(path.join(target, "sentinel"), "utf8")).toBe(
      "preserved",
    );
  });
});

describe("explicit workspace file copy", () => {
  it("bounds serialized UTF-8 JSON including escaped metadata at the exact wire budget", () => {
    expect(WORKSPACE_TRANSFER_MAX_SERIALIZED_BYTES).toBe(96 * 1024 * 1024);
    const payload = { files: [file('nested/"é".bin')] };
    const serialized = JSON.stringify(payload);
    const bytes = Buffer.byteLength(serialized, "utf8");
    expect(bytes).toBeGreaterThan(serialized.length);
    expect(() =>
      assertWorkspaceTransferSerializedSize(payload, bytes),
    ).not.toThrow();
    expect(() =>
      assertWorkspaceTransferSerializedSize(payload, bytes - 1),
    ).toThrow("serialized JSON payload limit");
  });

  it("copies exact binary bytes and executable mode with verification", async () => {
    const { source, target } = await fixture();
    await mkdir(target);
    await writeFile(path.join(source, "binary"), Buffer.from([0, 13, 10, 255]));
    await chmod(path.join(source, "binary"), 0o755);
    const { files } = await copyWorkspaceRead(source, ["binary"]);
    expect(await copyWorkspaceWrite(target, files)).toEqual({
      files: [{ path: "binary", sha256: files[0]!.sha256 }],
    });
    expect(await readFile(path.join(target, "binary"))).toEqual(
      Buffer.from([0, 13, 10, 255]),
    );
    expect((await lstat(path.join(target, "binary"))).mode & 0o111).not.toBe(0);
    await expect(copyWorkspaceWrite(target, files)).rejects.toThrow(
      "Refusing to overwrite",
    );
  });

  it("rejects traversal, .git, parent symlinks, duplicate paths and bad hashes before writing", async () => {
    const { source, target } = await fixture();
    await mkdir(target);
    await symlink(source, path.join(target, "escape"));
    for (const relative of [
      "../outside",
      "/absolute",
      ".git/config",
      "escape/file",
    ])
      await expect(
        copyWorkspaceWrite(target, [file(relative)]),
      ).rejects.toThrow();
    await expect(
      copyWorkspaceWrite(target, [file("same"), file("same")]),
    ).rejects.toThrow("Duplicate");
    await expect(
      copyWorkspaceWrite(target, [{ ...file("bad"), sha256: "0".repeat(64) }]),
    ).rejects.toThrow("SHA-256 mismatch");
    await expect(lstat(path.join(target, "bad"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await symlink("script.sh", path.join(source, "selected-link"));
    await expect(
      copyWorkspaceRead(source, ["selected-link"]),
    ).rejects.toThrow();
  });

  it("reports the explicit size limit without truncating selected files", async () => {
    const { source } = await fixture();
    await writeFile(
      path.join(source, "oversized"),
      Buffer.alloc(WORKSPACE_TRANSFER_MAX_BYTES + 1),
    );
    await expect(copyWorkspaceRead(source, ["oversized"])).rejects.toThrow(
      "64 MiB",
    );
    expect((await lstat(path.join(source, "oversized"))).size).toBe(
      WORKSPACE_TRANSFER_MAX_BYTES + 1,
    );
  });
});
