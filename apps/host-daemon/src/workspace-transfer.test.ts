import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
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
  workspaceRemoteBaseSchema,
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
async function publishedFixture() {
  const fixturePaths = await fixture();
  const published = path.join(fixturePaths.base, "published.git");
  await git(
    fixturePaths.source,
    "clone",
    "--bare",
    fixturePaths.source,
    published,
  );
  const head = (await git(fixturePaths.source, "rev-parse", "HEAD")).trim();
  const url = "https://approved.example.test/team/repository.git";
  const home = path.join(fixturePaths.base, "target-home");
  await mkdir(home);
  await writeFile(
    path.join(home, ".gitconfig"),
    `[url "file://${published}"]\n\tinsteadOf = ${url}\n`,
  );
  await git(fixturePaths.source, "remote", "add", "origin", url);
  await git(
    fixturePaths.source,
    "update-ref",
    "refs/remotes/origin/main",
    head,
  );
  return {
    ...fixturePaths,
    published,
    home,
    remoteBase: { url, ref: "refs/heads/main", head },
    targetOptions: { shellEnv: { HOME: home, XDG_CONFIG_HOME: home } },
  };
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
  it("uses an approved published base plus unpublished commits and exact dirty overlays without source mutation", async () => {
    const { source, target, remoteBase, targetOptions } =
      await publishedFixture();
    await writeFile(path.join(source, "unpublished.txt"), "local commit\n");
    await git(source, "add", "unpublished.txt");
    await git(source, "commit", "-m", "unpublished");
    await writeFile(
      path.join(source, "tracked.bin"),
      Buffer.from([9, 8, 0, 255]),
    );
    await git(source, "add", "tracked.bin");
    await writeFile(
      path.join(source, "tracked.bin"),
      Buffer.from([1, 0, 6, 255]),
    );
    await writeFile(
      path.join(source, "AGENTS.md"),
      "explicit portable context\n",
    );
    await git(
      source,
      "config",
      "credential.helper",
      "source-only-must-not-run",
    );
    const sourceConfig = await readFile(path.join(source, ".git", "config"));
    const sourceIndex = await readFile(path.join(source, ".git", "index"));
    const sourceHead = (await git(source, "rev-parse", "HEAD")).trim();
    const sourceRefs = await git(source, "show-ref");
    const preview = await previewWorkspaceTransfer(source);
    expect(preview.remoteBaseCandidates).toContainEqual(remoteBase);
    const { checkpoint } = await captureWorkspace(source, ["AGENTS.md"], {
      remoteBase,
    });
    expect(checkpoint.remoteBase).toEqual(remoteBase);
    expect(checkpoint.bundleBase64.length).toBeGreaterThan(0);
    await restoreWorkspace(
      target,
      checkpoint,
      "bb/remote-continuation",
      targetOptions,
    );
    expect((await git(target, "rev-parse", "HEAD")).trim()).toBe(sourceHead);
    expect(await git(target, "diff", "--cached", "--binary")).toBe(
      await git(source, "diff", "--cached", "--binary"),
    );
    expect(await git(target, "diff", "--binary")).toBe(
      await git(source, "diff", "--binary"),
    );
    expect(await readFile(path.join(target, "AGENTS.md"), "utf8")).toBe(
      "explicit portable context\n",
    );
    expect(
      (
        await git(target, "config", "--local", "--get", "remote.origin.url")
      ).trim(),
    ).toBe(remoteBase.url);
    await expect(
      git(target, "config", "--local", "--get", "credential.helper"),
    ).rejects.toThrow();
    expect(await readFile(path.join(source, ".git", "config"))).toEqual(
      sourceConfig,
    );
    expect(await readFile(path.join(source, ".git", "index"))).toEqual(
      sourceIndex,
    );
    expect(await git(source, "show-ref")).toBe(sourceRefs);
  });

  it("transfers no Git bundle when exact HEAD is published and refuses a missing prerequisite without fallback", async () => {
    const { source, target, base, remoteBase, targetOptions } =
      await publishedFixture();
    const { checkpoint } = await captureWorkspace(source, [], { remoteBase });
    expect(checkpoint.bundleBase64).toBe("");
    await restoreWorkspace(target, checkpoint, "bb/published", targetOptions);
    expect((await git(target, "rev-parse", "HEAD")).trim()).toBe(
      remoteBase.head,
    );
    const missingTarget = path.join(base, "missing-target");
    await expect(
      restoreWorkspace(
        missingTarget,
        {
          ...checkpoint,
          remoteBase: { ...remoteBase, head: "f".repeat(40) },
          head: "f".repeat(40),
        },
        undefined,
        targetOptions,
      ),
    ).rejects.toThrow("approved published prerequisite");
    await expect(lstat(missingTarget)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const missingRef = path.join(base, "missing-ref");
    await expect(
      restoreWorkspace(
        missingRef,
        {
          ...checkpoint,
          remoteBase: { ...remoteBase, ref: "refs/heads/not-published" },
        },
        undefined,
        targetOptions,
      ),
    ).rejects.toThrow();
    await expect(lstat(missingRef)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await git(source, "rev-parse", "HEAD")).trim()).toBe(
      remoteBase.head,
    );
  });

  it("fetches unchanged published LFS using target-local configuration rather than embedding materialized bytes", async () => {
    const { source, target, published, remoteBase, targetOptions } =
      await publishedFixture();
    await git(source, "lfs", "install", "--local", "--skip-smudge");
    await writeFile(
      path.join(source, ".gitattributes"),
      "*.bin filter=lfs diff=lfs merge=lfs -text\n",
    );
    const bytes = Buffer.from([1, 255, 0, 32, 97, 100]);
    await writeFile(path.join(source, "tracked.bin"), bytes);
    await git(source, "add", ".gitattributes", "tracked.bin");
    await git(source, "commit", "-m", "published LFS");
    await git(published, "fetch", source, "main:main");
    await cp(
      path.join(source, ".git", "lfs", "objects"),
      path.join(published, "lfs", "objects"),
      { recursive: true },
    );
    remoteBase.head = (await git(source, "rev-parse", "HEAD")).trim();
    const { checkpoint } = await captureWorkspace(source, [], { remoteBase });
    expect(checkpoint.bundleBase64).toBe("");
    expect(checkpoint.publishedLfsFiles?.map((entry) => entry.path)).toEqual([
      "tracked.bin",
    ]);
    expect(
      checkpoint.worktree.some((entry) => entry.path === "tracked.bin"),
    ).toBe(false);
    await restoreWorkspace(
      target,
      checkpoint,
      "bb/published-lfs",
      targetOptions,
    );
    expect(await readFile(path.join(target, "tracked.bin"))).toEqual(bytes);
    expect((await git(target, "status", "--porcelain")).trim()).toBe("");
    expect(await readFile(path.join(source, "tracked.bin"))).toEqual(bytes);
  });

  it("does not require per-file approval for ordinary token/secret source code, action modules or project instructions", async () => {
    const { source, target, remoteBase, targetOptions } =
      await publishedFixture();
    const paths = [
      "src/auth/token_storage.dart",
      "city/secret-request/Client.kt",
      ".github/actions/aws-secrets/action.yml",
      ".claude/settings.json",
      ".codex/skills/guide.md",
    ];
    for (const relative of paths) {
      await mkdir(path.dirname(path.join(source, relative)), {
        recursive: true,
      });
      await writeFile(
        path.join(source, relative),
        "ordinary published project source\n",
      );
    }
    await git(source, "add", ".");
    await git(source, "commit", "-m", "ordinary unpublished source modules");
    await writeFile(
      path.join(source, paths[0]!),
      "ordinary private source edit\n",
    );
    const preview = await previewWorkspaceTransfer(source);
    for (const relative of paths)
      expect(
        preview.files.find((entry) => entry.path === relative),
      ).toMatchObject({ kind: "tracked", selectedByDefault: true });
    const { checkpoint } = await captureWorkspace(source, [], { remoteBase });
    expect(checkpoint.publishedContextPaths).toBeUndefined();
    await restoreWorkspace(
      target,
      checkpoint,
      "bb/ordinary-code",
      targetOptions,
    );
    expect(await readFile(path.join(target, paths[0]!), "utf8")).toBe(
      "ordinary private source edit\n",
    );
    expect(await git(target, "diff")).toBe(await git(source, "diff"));
  });

  it("requires explicit review only for unchanged ambiguous published key files and validates provenance on the target", async () => {
    const { source, target, base, published, remoteBase, targetOptions } =
      await publishedFixture();
    const oldPublishedHead = remoteBase.head;
    const relative = "app/test.keystore";
    await mkdir(path.join(source, "app"));
    await writeFile(
      path.join(source, relative),
      "fixture bytes, not a real signing key\n",
    );
    await git(source, "add", ".");
    await git(source, "commit", "-m", "published fixture key-shaped asset");
    await git(published, "fetch", source, "main:main");
    remoteBase.head = (await git(source, "rev-parse", "HEAD")).trim();
    await writeFile(
      path.join(source, "ordinary.txt"),
      "unpublished ordinary source\n",
    );
    await git(source, "add", "ordinary.txt");
    await git(source, "commit", "-m", "ordinary unpublished commit");
    const originalIndex = await readFile(path.join(source, ".git", "index"));
    await expect(captureWorkspace(source, [], { remoteBase })).rejects.toThrow(
      "explicit source-owner approval",
    );
    const { checkpoint } = await captureWorkspace(source, [relative], {
      remoteBase,
    });
    expect(checkpoint.publishedContextPaths).toEqual([relative]);
    expect(checkpoint.worktree.some((entry) => entry.path === relative)).toBe(
      false,
    );
    await restoreWorkspace(
      target,
      checkpoint,
      "bb/reviewed-context",
      targetOptions,
    );
    expect(await readFile(path.join(target, relative))).toEqual(
      await readFile(path.join(source, relative)),
    );
    expect(await readFile(path.join(source, ".git", "index"))).toEqual(
      originalIndex,
    );
    await expect(
      restoreWorkspace(
        path.join(base, "missing-approval"),
        { ...checkpoint, publishedContextPaths: [] },
        undefined,
        targetOptions,
      ),
    ).rejects.toThrow("exact published-context approval");
    await expect(
      restoreWorkspace(
        path.join(base, "wrong-base"),
        {
          ...checkpoint,
          remoteBase: { ...remoteBase, head: oldPublishedHead },
        },
        undefined,
        targetOptions,
      ),
    ).rejects.toThrow("not unchanged at the approved published prerequisite");
    await expect(
      restoreWorkspace(
        path.join(base, "overlay"),
        {
          ...checkpoint,
          worktree: [
            ...checkpoint.worktree,
            { path: relative, file: file(relative) },
          ],
        },
        undefined,
        targetOptions,
      ),
    ).rejects.toThrow("Invalid published sensitive context");
    await expect(
      restoreWorkspace(
        path.join(base, "no-base"),
        { ...checkpoint, remoteBase: undefined },
        undefined,
        targetOptions,
      ),
    ).rejects.toThrow("requires an approved remote base");
    await expect(
      restoreWorkspace(
        path.join(base, "native-context"),
        {
          ...checkpoint,
          publishedContextPaths: [relative, ".claude/session.json"],
        },
        undefined,
        targetOptions,
      ),
    ).rejects.toThrow("Invalid published sensitive context");
    const privateIndex = file(
      relative,
      Buffer.from("private fixture overlay\n"),
    );
    await expect(
      restoreWorkspace(
        path.join(base, "index-overlay"),
        {
          ...checkpoint,
          index: checkpoint.index.map((entry) =>
            entry.path === relative
              ? {
                  ...entry,
                  contentBase64: privateIndex.contentBase64,
                  sha256: privateIndex.sha256,
                }
              : entry,
          ),
        },
        undefined,
        targetOptions,
      ),
    ).rejects.toThrow("Invalid published sensitive context");
    await writeFile(path.join(source, relative), "private fixture edit\n");
    await expect(
      captureWorkspace(source, [relative], { remoteBase }),
    ).rejects.toThrow("private worktree changes");
    await git(source, "add", relative);
    await expect(
      captureWorkspace(source, [relative], { remoteBase }),
    ).rejects.toThrow("unchanged at the explicitly approved published base");
    await git(source, "commit", "-m", "unpublished key-shaped change");
    await expect(
      captureWorkspace(source, [relative], { remoteBase }),
    ).rejects.toThrow("unchanged at the explicitly approved published base");
  });

  it.each([".claude/session.json", ".codex/auth.json", ".ssh/id_ed25519"])(
    "never captures native authentication/session storage %s even with approval",
    async (relative) => {
      const { source, published, remoteBase } = await publishedFixture();
      await mkdir(path.dirname(path.join(source, relative)), {
        recursive: true,
      });
      await writeFile(
        path.join(source, relative),
        "fixture-only native storage\n",
      );
      await expect(
        captureWorkspace(source, [relative], { remoteBase }),
      ).rejects.toThrow("Untracked sensitive");
      await git(source, "add", relative);
      await git(source, "commit", "-m", "native storage fixture");
      await git(published, "fetch", source, "main:main");
      remoteBase.head = (await git(source, "rev-parse", "HEAD")).trim();
      await expect(
        captureWorkspace(source, [relative], { remoteBase }),
      ).rejects.toThrow(
        "Native authentication/session paths cannot be transferred",
      );
    },
  );

  it("does not smuggle a deleted sensitive file through unpublished Git history", async () => {
    const { source, target, base, remoteBase, targetOptions } =
      await publishedFixture();
    const { checkpoint } = await captureWorkspace(source, [], { remoteBase });
    await writeFile(
      path.join(source, "credentials.json"),
      '{"fixture":true}\n',
    );
    await git(source, "add", "credentials.json");
    await git(source, "commit", "-m", "unpublished fixture credentials");
    await git(source, "rm", "credentials.json");
    await git(source, "commit", "-m", "remove fixture credentials");
    await expect(captureWorkspace(source, [], { remoteBase })).rejects.toThrow(
      "Unpublished history includes sensitive source context credentials.json",
    );
    await expect(captureWorkspace(source, [])).rejects.toThrow(
      "Unpublished history includes sensitive source context credentials.json",
    );
    const bundlePath = path.join(base, "forged.bundle");
    await git(
      source,
      "bundle",
      "create",
      bundlePath,
      "HEAD",
      `^${remoteBase.head}`,
    );
    const bundle = await readFile(bundlePath);
    await expect(
      restoreWorkspace(
        target,
        {
          ...checkpoint,
          head: (await git(source, "rev-parse", "HEAD")).trim(),
          bundleBase64: bundle.toString("base64"),
          bundleSha256: createHash("sha256").update(bundle).digest("hex"),
        },
        undefined,
        targetOptions,
      ),
    ).rejects.toThrow(
      "Unpublished history includes sensitive source context credentials.json",
    );
    await expect(lstat(path.join(target, "tracked.bin"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  it.each([
    "file:///tmp/repo",
    "file:/tmp/repo",
    "/tmp/repo",
    "https://token@github.com/org/repo.git",
    "https://github.com/org/repo.git?token=private",
    "ssh://git:password@github.com/org/repo.git",
  ])("rejects unapproved or credential-bearing remote %s", (url) => {
    expect(
      workspaceRemoteBaseSchema.safeParse({
        url,
        ref: "refs/heads/main",
        head: "a".repeat(40),
      }).success,
    ).toBe(false);
  });

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
      await expect(captureWorkspace(source, [".env"])).rejects.toThrow(
        "Untracked sensitive",
      );
      const { checkpoint } = await captureWorkspace(source, []);
      await restoreWorkspace(target, checkpoint);
      await expect(lstat(path.join(target, ".env"))).rejects.toMatchObject({
        code: "ENOENT",
      });
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

  it("refuses private tracked sensitive bytes even when explicitly selected", async () => {
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
    await expect(captureWorkspace(source, [".env"])).rejects.toThrow(
      "approved published remote base",
    );
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves confined instruction links, directory links and staged/unstaged link checkpoints without copying sessions", async () => {
    const { source, target } = await fixture();
    await mkdir(path.join(source, "docs", "skills"), { recursive: true });
    await mkdir(path.join(source, ".claude"));
    for (const name of ["agents", "staged", "unstaged"])
      await writeFile(
        path.join(source, "docs", `${name}.md`),
        `${name} instructions\n`,
      );
    await writeFile(
      path.join(source, "docs", "mcp.json"),
      '{"mcpServers":{}}\n',
    );
    await writeFile(
      path.join(source, "docs", "skills", "SKILL.md"),
      "repository skill\n",
    );
    for (const [name, targetPath] of [
      ["AGENTS.md", "docs/agents.md"],
      ["CLAUDE.md", "docs/agents.md"],
      [".mcp.json", "docs/mcp.json"],
      [".claude/skills", "../docs/skills"],
      ["deleted-link", "script.sh"],
    ])
      await symlink(targetPath!, path.join(source, name!));
    await git(source, "add", ".");
    await git(source, "commit", "-m", "confined context links");
    await rm(path.join(source, "AGENTS.md"));
    await symlink("docs/staged.md", path.join(source, "AGENTS.md"));
    await git(source, "add", "AGENTS.md");
    await rm(path.join(source, "AGENTS.md"));
    await symlink("docs/unstaged.md", path.join(source, "AGENTS.md"));
    await rm(path.join(source, "deleted-link"));
    await writeFile(
      path.join(source, ".claude", "session.json"),
      "must remain source-local\n",
    );
    await symlink("docs/agents.md", path.join(source, "intent-link"));
    await git(source, "add", "--intent-to-add", "intent-link");
    const originalHead = await git(source, "rev-parse", "HEAD");
    const originalIndex = await readFile(path.join(source, ".git", "index"));
    const staged = await git(source, "diff", "--cached", "--binary");
    const unstaged = await git(source, "diff", "--binary");
    const preview = await previewWorkspaceTransfer(source);
    expect(
      preview.files.find((entry) => entry.path === ".claude/skills"),
    ).toMatchObject({ tracked: true, selectedByDefault: true });
    expect(
      preview.files.find((entry) => entry.path === ".claude/session.json")
        ?.excludedReason,
    ).toContain("Sensitive");
    const { checkpoint } = await captureWorkspace(source, []);
    await restoreWorkspace(target, checkpoint, "bb/coherent-context");
    expect(await git(target, "diff", "--cached", "--binary")).toBe(staged);
    expect(await git(target, "diff", "--binary")).toBe(unstaged);
    expect(await readlink(path.join(target, "AGENTS.md"))).toBe(
      "docs/unstaged.md",
    );
    expect(await readlink(path.join(target, ".claude", "skills"))).toBe(
      "../docs/skills",
    );
    expect(await readFile(path.join(target, "CLAUDE.md"), "utf8")).toBe(
      "agents instructions\n",
    );
    expect(await readFile(path.join(target, ".mcp.json"), "utf8")).toBe(
      '{"mcpServers":{}}\n',
    );
    expect(
      await readFile(
        path.join(target, ".claude", "skills", "SKILL.md"),
        "utf8",
      ),
    ).toBe("repository skill\n");
    await expect(
      lstat(path.join(target, ".claude", "session.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      lstat(path.join(target, "deleted-link")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(source, ".git", "index"))).toEqual(
      originalIndex,
    );
    expect(await git(source, "rev-parse", "HEAD")).toBe(originalHead);
    expect((await git(source, "branch", "--show-current")).trim()).toBe("main");
  });

  it("preserves tracked regular-to-link and link-to-regular worktree changes", async () => {
    const { source, target } = await fixture();
    await symlink("script.sh", path.join(source, "link"));
    await git(source, "add", "link");
    await git(source, "commit", "-m", "tracked link");
    await rm(path.join(source, "link"));
    await writeFile(path.join(source, "link"), "now an ordinary file\n");
    await rm(path.join(source, "deleted.txt"));
    await symlink("script.sh", path.join(source, "deleted.txt"));
    const { checkpoint } = await captureWorkspace(source, []);
    await restoreWorkspace(target, checkpoint);
    expect((await lstat(path.join(target, "link"))).isFile()).toBe(true);
    expect(await readFile(path.join(target, "link"), "utf8")).toBe(
      "now an ordinary file\n",
    );
    expect(await readlink(path.join(target, "deleted.txt"))).toBe("script.sh");
    expect(await git(target, "diff", "--binary")).toBe(
      await git(source, "diff", "--binary"),
    );
  });

  it.each([
    "../outside",
    "/tmp/outside",
    ".git/config",
    ".env",
    "missing-file",
  ])(
    "refuses unsafe or unresolved tracked link target %s",
    async (linkTarget) => {
      const { source } = await fixture();
      await symlink(linkTarget, path.join(source, "AGENTS.md"));
      await git(source, "add", "AGENTS.md");
      await expect(previewWorkspaceTransfer(source)).rejects.toThrow();
      await expect(captureWorkspace(source, [])).rejects.toThrow();
      expect(await readlink(path.join(source, "AGENTS.md"))).toBe(linkTarget);
    },
  );

  it("rejects forged checkpoint links before creating a target and does not broaden explicit copy", async () => {
    const { source, target } = await fixture();
    const { checkpoint } = await captureWorkspace(source, []);
    const unsafe = {
      ...file("script.sh", Buffer.from("../outside")),
      mode: "120000" as const,
      permissions: 0o777,
    };
    checkpoint.worktree.push({ path: "script.sh", file: unsafe });
    await expect(restoreWorkspace(target, checkpoint)).rejects.toThrow();
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(target);
    await expect(
      copyWorkspaceWrite(target, [
        {
          ...unsafe,
          contentBase64: Buffer.from("script.sh").toString("base64"),
          sha256: createHash("sha256").update("script.sh").digest("hex"),
        },
      ]),
    ).rejects.toThrow("verified tracked");
  });

  it("refuses escaping symlinks, gitlinks, unmerged entries, unsupported flags, and in-progress operations", async () => {
    const { source } = await fixture();
    await symlink("../outside", path.join(source, "link"));
    await git(source, "add", "link");
    await expect(captureWorkspace(source, [])).rejects.toThrow();
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
