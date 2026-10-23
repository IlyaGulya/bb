import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  realpath,
  rm,
  rmdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import {
  WORKSPACE_TRANSFER_MAX_BYTES,
  WORKSPACE_TRANSFER_MAX_FILES,
  WORKSPACE_TRANSFER_MAX_SERIALIZED_BYTES,
  workspaceCheckpointSchema,
  workspaceTransferFileSchema,
  workspaceTransferPathSchema,
  workspaceRemoteBaseSchema,
  type WorkspaceRemoteBase,
  type WorkspaceCheckpoint,
  type WorkspaceTransferFile,
  type WorkspaceTransferPreviewResult,
} from "@bb/host-daemon-contract";

type GitEntry = {
  path: string;
  mode: "100644" | "100755" | "120000";
  oid: string;
};
type FileIdentity = {
  oid: string;
  mode: GitEntry["mode"];
  permissions: number;
  stamp: string;
  contentSha256?: string;
} | null;
type TransferOptions = {
  shellEnv?: Record<string, string>;
  activeThreadIds?: () => string[];
  acquireCapture?: () => () => void;
  remoteBase?: WorkspaceRemoteBase;
  nativeRemoteAuthentication?: boolean;
  timeoutMs?: number;
};
const transfers = new Set<string>();
const sizeError =
  "Workspace transfer exceeds the supported 64 MiB decoded payload (bundle + changed index/worktree files + selected files). Commit large changes or transfer large artifacts separately, then retry with fewer selected files.";
const sha256 = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");
function budget() {
  let used = 0;
  return (bytes: number) => {
    used += bytes;
    if (used > WORKSPACE_TRANSFER_MAX_BYTES) throw new Error(sizeError);
  };
}
export function assertWorkspaceTransferSerializedSize(
  payload: WorkspaceCheckpoint | { files: WorkspaceTransferFile[] },
  maxBytes = WORKSPACE_TRANSFER_MAX_SERIALIZED_BYTES,
) {
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > maxBytes) {
    throw new Error(
      "Workspace transfer exceeds the supported 96 MiB serialized JSON payload limit (base64 plus path/index metadata). Select fewer files or reduce workspace path/index metadata before retrying.",
    );
  }
}

function uniquePaths(paths: string[]) {
  if (paths.length > WORKSPACE_TRANSFER_MAX_FILES)
    throw new Error(
      `Workspace transfer supports at most ${WORKSPACE_TRANSFER_MAX_FILES.toLocaleString("en-US")} files per list; narrow the selection.`,
    );
  const result = paths.map((value) => workspaceTransferPathSchema.parse(value));
  if (new Set(result).size !== result.length)
    throw new Error("Duplicate workspace file paths are not allowed.");
  const folded = new Set<string>();
  for (const value of result) {
    const key = value.normalize("NFC").toLowerCase();
    if (folded.has(key))
      throw new Error(
        `Workspace paths collide on a case-insensitive filesystem: ${value}`,
      );
    folded.add(key);
  }
  return result;
}
function git(
  root: string,
  args: string[],
  options: TransferOptions,
  input?: Buffer,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...options.shellEnv };
    for (const key of Object.keys(env))
      if (key.startsWith("GIT_")) delete env[key];
    Object.assign(env, {
      GIT_OPTIONAL_LOCKS: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      ...(options.nativeRemoteAuthentication
        ? {}
        : { GIT_CONFIG_GLOBAL: devNull }),
      GIT_TERMINAL_PROMPT: "0",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_NO_LAZY_FETCH: "1",
    });
    const child = spawn(
      "git",
      [
        "-c",
        `core.hooksPath=${devNull}`,
        "-c",
        `core.attributesFile=${devNull}`,
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.filemode=true",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "maintenance.auto=false",
        "-C",
        root,
        ...args,
      ],
      { env, stdio: ["pipe", "pipe", "pipe"] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: Error | null = null;
    const timer = setTimeout(() => {
      failure = new Error(
        `Git workspace transfer exceeded ${(options.timeoutMs ?? 120_000) / 1000} seconds; inspect remote availability and repository/selection size before retrying.`,
      );
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 120_000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > WORKSPACE_TRANSFER_MAX_BYTES) {
        failure = new Error(sizeError);
        child.kill("SIGKILL");
      } else stdout.push(chunk);
    });
    let errorBytes = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      errorBytes += chunk.length;
      if (errorBytes <= 65536) stderr.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new Error(
            `git ${args[0]} failed: ${Buffer.concat(stderr).toString("utf8").trim()}`,
          ),
        );
      else resolve(Buffer.concat(stdout));
    });
    child.stdin.end(input);
  });
}
async function rootDirectory(rootPath: string) {
  const resolved = path.resolve(rootPath);
  if ((await lstat(resolved)).isSymbolicLink())
    throw new Error(`Workspace root must not be a symlink: ${rootPath}`);
  const root = await realpath(resolved);
  if (!(await stat(root)).isDirectory())
    throw new Error(`Workspace root is not a directory: ${rootPath}`);
  return root;
}
async function confined(root: string, relative: string, createParents = false) {
  workspaceTransferPathSchema.parse(relative);
  const parts = relative.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    if (createParents)
      await mkdir(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    const info = await lstat(current);
    if (info.isSymbolicLink())
      throw new Error(`Unsafe workspace path component: ${relative}`);
    if (!info.isDirectory())
      throw Object.assign(
        new Error(`Workspace path component is not a directory: ${relative}`),
        { code: "ENOTDIR" },
      );
  }
  return path.join(root, ...parts);
}
function confinedLinkTarget(relative: string, content: Buffer) {
  const target = content.toString("utf8");
  if (
    !content.equals(Buffer.from(target)) ||
    target.length === 0 ||
    target.length > 4096 ||
    path.posix.isAbsolute(target) ||
    /[\\\u0000-\u001f\u007f:]/u.test(target)
  )
    throw new Error(
      `Symlink target must be a confined relative UTF-8 path: ${relative}`,
    );
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(relative), target),
  );
  workspaceTransferPathSchema.parse(resolved);
  if (secretReason(resolved))
    throw new Error(
      `Symlink cannot reference an authentication/session path: ${relative}`,
    );
  return target;
}
async function readConfinedLink(
  root: string,
  relative: string,
  charge: (bytes: number) => void,
): Promise<WorkspaceTransferFile> {
  const absolute = await confined(root, relative);
  const before = await lstat(absolute);
  if (!before.isSymbolicLink())
    throw new Error(`Source changed during capture: ${relative}`);
  const content = Buffer.from(await readlink(absolute));
  confinedLinkTarget(relative, content);
  const resolved = await realpath(absolute);
  const resolvedRelative = path
    .relative(root, resolved)
    .split(path.sep)
    .join("/");
  workspaceTransferPathSchema.parse(resolvedRelative);
  if (secretReason(resolvedRelative))
    throw new Error(
      `Symlink cannot reference an authentication/session path: ${relative}`,
    );
  const after = await lstat(absolute);
  if (
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    content.toString() !== (await readlink(absolute))
  )
    throw new Error(
      `Source changed during capture: ${relative}; stop writers and retry.`,
    );
  charge(content.length);
  return {
    path: relative,
    mode: "120000",
    permissions: 0o777,
    contentBase64: content.toString("base64"),
    sha256: sha256(content),
  };
}
async function readOrdinary(
  root: string,
  relative: string,
  charge: (bytes: number) => void,
  allowSymlink = false,
): Promise<WorkspaceTransferFile> {
  const absolute = await confined(root, relative);
  if (allowSymlink && (await lstat(absolute)).isSymbolicLink())
    return readConfinedLink(root, relative, charge);
  const handle = await open(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile())
      throw new Error(`Only ordinary files can be transferred: ${relative}`);
    charge(before.size);
    if (before.size > WORKSPACE_TRANSFER_MAX_BYTES) throw new Error(sizeError);
    const content = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await handle.read(
        content,
        offset,
        content.length - offset,
        offset,
      );
      if (bytesRead === 0)
        throw new Error(
          `Source changed during capture: ${relative}; stop writers and retry.`,
        );
      offset += bytesRead;
    }
    const probe = Buffer.allocUnsafe(1);
    const extraBytes = (await handle.read(probe, 0, 1, content.length))
      .bytesRead;
    const after = await handle.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      extraBytes !== 0
    )
      throw new Error(
        `Source changed during capture: ${relative}; stop writers and retry.`,
      );
    return {
      path: relative,
      mode: before.mode & 0o100 ? "100755" : "100644",
      permissions: before.mode & 0o777,
      contentBase64: content.toString("base64"),
      sha256: sha256(content),
    };
  } finally {
    await handle.close();
  }
}
async function fileIdentity(
  root: string,
  relative: string,
  objectFormat: "sha1" | "sha256",
  withContentSha256 = false,
): Promise<FileIdentity> {
  let absolute: string;
  try {
    absolute = await confined(root, relative);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  let info;
  try {
    info = await lstat(absolute);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (info.isDirectory()) return null;
  if (info.isSymbolicLink()) {
    const file = await readConfinedLink(root, relative, () => {});
    const content = Buffer.from(file.contentBase64, "base64");
    return {
      oid: createHash(objectFormat)
        .update(`blob ${content.length}\0`)
        .update(content)
        .digest("hex"),
      mode: "120000",
      permissions: 0o777,
      stamp: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`,
    };
  }
  if (!info.isFile())
    throw new Error(`Non-ordinary files cannot be transferred: ${relative}`);
  const hash = createHash(objectFormat).update(`blob ${info.size}\0`);
  const contentHash = withContentSha256 ? createHash("sha256") : null;
  const handle = await open(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      contentHash?.update(chunk);
    }
  } finally {
    await handle.close();
  }
  const after = await lstat(absolute);
  if (
    info.size !== after.size ||
    info.mtimeMs !== after.mtimeMs ||
    info.ctimeMs !== after.ctimeMs ||
    info.ino !== after.ino
  )
    throw new Error(
      `Source changed during capture: ${relative}; stop writers and retry.`,
    );
  return {
    oid: hash.digest("hex"),
    mode: info.mode & 0o100 ? ("100755" as const) : ("100644" as const),
    permissions: info.mode & 0o777,
    stamp: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`,
    ...(contentHash ? { contentSha256: contentHash.digest("hex") } : {}),
  };
}
function isMissing(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
function secretReason(relative: string) {
  if (nativeAuthenticationPath(relative))
    return "Sensitive native authentication/session storage; cannot be transferred even with explicit selection.";
  const parts = relative.toLowerCase().split("/");
  const name = parts[parts.length - 1]!;
  const storageFile =
    /(?:^|[._-])(?:auth|credentials?|secrets?|tokens?)(?:[._-](?:local|private|prod|production|dev|development|test|staging))?\.(?:jsonl?|toml|ya?ml|ini|cfg|conf|properties|txt)$/u.test(
      name,
    );
  const extensionlessStorage = /^(?:auth|credentials?|secrets?|tokens?)$/u.test(
    name,
  );
  if (
    /^\.env(?:\.|$)/u.test(name) ||
    /\.(?:pem|key|p12|pfx|keystore)$/u.test(name) ||
    [
      ".npmrc",
      ".pypirc",
      ".netrc",
      "settings-security.xml",
      "id_rsa",
      "id_ed25519",
    ].includes(name) ||
    storageFile ||
    extensionlessStorage ||
    (parts.some((part) => part === "secrets" || part === "credentials") &&
      /(?:\.(?:jsonl?|toml|ya?ml|ini|cfg|conf|properties|txt))$/u.test(name))
  )
    return "Sensitive configuration/auth/session path; explicit source-owner review is required.";
  return undefined;
}
function nativeAuthenticationPath(relative: string): boolean {
  const value = relative.toLowerCase();
  return (
    /(?:^|\/)\.(?:ssh|aws|azure|gnupg|kube|bb)(?:\/|$)/u.test(value) ||
    /(?:^|\/)\.codex\/(?!skills(?:\/|$))/u.test(value) ||
    /(?:^|\/)\.claude\/(?:projects|sessions?|\.credentials\.json|credentials|history\.jsonl)(?:[./]|$)/u.test(
      value,
    ) ||
    /(?:^|\/)\.config\/(?:gh|gcloud|aws)(?:\/|$)/u.test(value)
  );
}

async function assertNoSensitiveUnpublishedHistory(
  root: string,
  head: string,
  publishedHead: string | undefined,
  options: TransferOptions,
) {
  if (publishedHead === head) return;
  const objects = (
    await git(
      root,
      [
        "rev-list",
        "--objects",
        head,
        ...(publishedHead ? [`^${publishedHead}`] : []),
      ],
      options,
    )
  )
    .toString("utf8")
    .split("\n")
    .flatMap((object) => {
      const split = object.indexOf(" ");
      const relative = split < 0 ? "" : object.slice(split + 1);
      return relative && secretReason(relative)
        ? [{ oid: object.slice(0, split), path: relative }]
        : [];
    });
  if (!objects.length) return;
  const kinds = (
    await git(
      root,
      ["cat-file", "--batch-check=%(objecttype)"],
      options,
      Buffer.from(objects.map((object) => object.oid).join("\n") + "\n"),
    )
  )
    .toString("utf8")
    .trim()
    .split("\n");
  const sensitive = objects.find((_, index) => kinds[index] === "blob");
  if (sensitive)
    throw new Error(
      `Unpublished history includes sensitive source context ${sensitive.path}; obtain an approved published prerequisite containing it instead of copying sensitive history.`,
    );
}
function gitPaths(output: Buffer) {
  const text = output.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(output))
    throw new Error(
      "Workspace paths must be valid UTF-8 for portable transfer; rename unsupported paths before retrying.",
    );
  return text.split("\0").filter(Boolean);
}

async function metadataFingerprint(gitDirectory: string) {
  return Promise.all(
    ["HEAD", "index"].map(async (name) => {
      try {
        const hash = createHash("sha256");
        const handle = await open(
          path.join(gitDirectory, name),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          for await (const chunk of handle.createReadStream({
            autoClose: false,
          }))
            hash.update(chunk);
        } finally {
          await handle.close();
        }
        return hash.digest("hex");
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    }),
  );
}

function parseEntries(output: Buffer, tree: boolean): GitEntry[] {
  const entries = gitPaths(output).map((record): GitEntry => {
    const match = tree
      ? /^(\d{6}) (\w+) ([a-f0-9]+)\t([\s\S]+)$/u.exec(record)
      : /^(\d{6}) ([a-f0-9]+) (\d)\t([\s\S]+)$/u.exec(record);
    if (!match)
      throw new Error("Git returned an unsupported index/tree entry.");
    const mode = match[1];
    const relative = match[4]!;
    workspaceTransferPathSchema.parse(relative);
    if (mode !== "100644" && mode !== "100755" && mode !== "120000")
      throw new Error(`Submodules and gitlinks are unsupported: ${relative}`);
    if (!tree && match[3] !== "0")
      throw new Error(
        `Unmerged index entry: ${relative}; resolve conflicts before transfer.`,
      );
    if (
      relative.split("/").some((part) => part.toLowerCase() === ".gitmodules")
    )
      throw new Error(
        `Submodule metadata is unsupported: ${relative}; remove submodules before transfer.`,
      );
    return { path: relative, mode, oid: (tree ? match[3] : match[2])! };
  });
  uniquePaths(entries.map((entry) => entry.path));
  return entries;
}
async function ensureNoGitOperation(root: string, options: TransferOptions) {
  for (const name of [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "REBASE_HEAD",
    "rebase-apply",
    "rebase-merge",
    "sequencer",
    "BISECT_START",
    "index.lock",
    "HEAD.lock",
    "shallow",
    "info/grafts",
  ]) {
    const value = (await git(root, ["rev-parse", "--git-path", name], options))
      .toString("utf8")
      .trim();
    try {
      await lstat(path.resolve(root, value));
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    throw new Error(
      `Workspace has an in-progress Git operation or unsupported history state (${name}); finish/abort the operation, unshallow the repository, or remove grafts before transfer.`,
    );
  }
}
async function inspect(root: string, options: TransferOptions) {
  const top = (await git(root, ["rev-parse", "--show-toplevel"], options))
    .toString("utf8")
    .trim();
  if ((await realpath(top)) !== root)
    throw new Error(
      "Workspace transfer requires the repository/worktree root, not a nested directory.",
    );
  const configNames = (
    await git(root, ["config", "--name-only", "--list"], options)
  )
    .toString("utf8")
    .split("\n");
  for (const name of configNames)
    if (
      /^remote\..*\.promisor$/iu.test(name) &&
      (await git(root, ["config", "--bool", "--get", name], options))
        .toString("utf8")
        .trim() === "true"
    )
      throw new Error(
        "Partial/promisor clones cannot be captured without modifying source object storage; fully materialize repository history before transfer.",
      );
  if (
    (
      await git(
        root,
        [
          "config",
          "--bool",
          "--default",
          "false",
          "--get",
          "core.sparseCheckout",
        ],
        options,
      )
    )
      .toString("utf8")
      .trim() === "true" ||
    (
      await git(
        root,
        ["config", "--bool", "--default", "false", "--get", "index.sparse"],
        options,
      )
    )
      .toString("utf8")
      .trim() === "true"
  )
    throw new Error(
      "Sparse checkouts/indexes cannot be transferred exactly; disable sparse checkout and expand the index before transfer.",
    );
  if (
    (
      await git(
        root,
        ["for-each-ref", "--format=%(refname)", "refs/replace/"],
        options,
      )
    ).length
  )
    throw new Error(
      "Git replacement refs are unsupported; remove replacement refs before transfer.",
    );
  await ensureNoGitOperation(root, options);
  const head = (
    await git(root, ["rev-parse", "--verify", "HEAD^{commit}"], options)
  )
    .toString("utf8")
    .trim();
  const branchValue = (
    await git(root, ["rev-parse", "--abbrev-ref", "HEAD"], options)
  )
    .toString("utf8")
    .trim();
  const headEntries = parseEntries(
    await git(root, ["ls-tree", "-rz", "--full-tree", "HEAD"], options),
    true,
  );
  const indexEntries = parseEntries(
    await git(root, ["ls-files", "--stage", "-z"], options),
    false,
  );
  const flags = (await git(root, ["ls-files", "-v", "-z"], options))
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  for (const value of flags)
    if (value[0] !== "H")
      throw new Error(
        `Unsupported index flag (assume-unchanged/skip-worktree): ${value.slice(2)}; clear it before transfer.`,
      );
  const untracked = gitPaths(
    await git(
      root,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      options,
    ),
  );
  const ignored = gitPaths(
    await git(
      root,
      [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "-z",
      ],
      options,
    ),
  ).map((value) => value.replace(/\/$/u, ""));
  uniquePaths([
    ...new Set([
      ...headEntries.map((entry) => entry.path),
      ...indexEntries.map((entry) => entry.path),
      ...untracked,
      ...ignored,
    ]),
  ]);
  const trackedPaths = [
    ...new Set([...headEntries, ...indexEntries].map((entry) => entry.path)),
  ];
  const attributes = (
    await git(
      root,
      ["check-attr", "-z", "--stdin", "filter"],
      options,
      Buffer.from(trackedPaths.map((relative) => `${relative}\0`).join("")),
    )
  )
    .toString("utf8")
    .split("\0");
  const lfsPaths: string[] = [];
  for (let index = 0; index + 2 < attributes.length; index += 3) {
    const relative = attributes[index]!;
    const filter = attributes[index + 2]!;
    if (filter === "unspecified" || filter === "unset") continue;
    if (filter !== "lfs")
      throw new Error(
        `Custom Git clean/smudge filter '${filter}' is unsupported for ${relative}; materialize ordinary files and remove the filter before transfer.`,
      );
    lfsPaths.push(relative);
    let absolute: string;
    try {
      absolute = await confined(root, relative);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    let handle;
    try {
      handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    try {
      if (!(await handle.stat()).isFile())
        throw new Error(`LFS path is not an ordinary file: ${relative}`);
      const prefix = Buffer.alloc(200);
      const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
      if (
        prefix
          .subarray(0, bytesRead)
          .toString("utf8")
          .startsWith("version https://git-lfs.github.com/spec/v1")
      )
        throw new Error(
          `Git LFS content is missing for ${relative}; fetch/materialize its actual bytes before transfer.`,
        );
    } finally {
      await handle.close();
    }
  }
  const visible = new Set(
    (
      await git(
        root,
        [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--cached",
          "--name-only",
          "-z",
          "--ita-visible-in-index",
          "HEAD",
          "--",
        ],
        options,
      )
    )
      .toString("utf8")
      .split("\0")
      .filter(Boolean),
  );
  const invisible = new Set(
    (
      await git(
        root,
        [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--cached",
          "--name-only",
          "-z",
          "--ita-invisible-in-index",
          "HEAD",
          "--",
        ],
        options,
      )
    )
      .toString("utf8")
      .split("\0")
      .filter(Boolean),
  );
  const intentPaths = [...visible].filter((value) => !invisible.has(value));
  for (const entry of headEntries)
    if (entry.mode === "120000")
      confinedLinkTarget(
        entry.path,
        await git(root, ["cat-file", "blob", entry.oid], options),
      );
  for (const entry of indexEntries)
    if (entry.mode === "120000" && !intentPaths.includes(entry.path))
      confinedLinkTarget(
        entry.path,
        await git(root, ["cat-file", "blob", entry.oid], options),
      );
  return {
    head,
    branch: branchValue === "HEAD" ? null : branchValue,
    headEntries,
    indexEntries,
    untracked,
    ignored,
    intentPaths,
    lfsPaths,
  };
}
async function publishedLfsPointers(
  root: string,
  headEntries: GitEntry[],
  lfsPaths: string[],
  baseHead: string,
  options: TransferOptions,
): Promise<Map<string, string>> {
  if (!lfsPaths.length) return new Map();
  const published = new Set(
    parseEntries(
      await git(root, ["ls-tree", "-rz", "--full-tree", baseHead], options),
      true,
    ).map((entry) => entry.oid),
  );
  const lfs = new Set(lfsPaths);
  const entries = headEntries.filter(
    (entry) => lfs.has(entry.path) && published.has(entry.oid),
  );
  if (!entries.length) return new Map();
  const output = await git(
    root,
    ["cat-file", "--batch"],
    options,
    Buffer.from(entries.map((entry) => entry.oid).join("\n") + "\n"),
  );
  const result = new Map<string, string>();
  let offset = 0;
  for (const entry of entries) {
    const end = output.indexOf(10, offset);
    const header = output.subarray(offset, end).toString("utf8");
    const match = /^([a-f0-9]+) blob (\d+)$/u.exec(header);
    if (!match || match[1] !== entry.oid)
      throw new Error(`Cannot inspect published LFS pointer: ${entry.path}`);
    const size = Number(match[2]);
    const content = output.subarray(end + 1, end + 1 + size).toString("utf8");
    offset = end + 1 + size + 1;
    const sha = /^oid sha256:([a-f0-9]{64})$/mu.exec(content)?.[1];
    if (
      content.startsWith("version https://git-lfs.github.com/spec/v1\n") &&
      sha
    )
      result.set(entry.path, sha);
  }
  return result;
}
async function cachedRemoteBases(
  root: string,
  head: string,
  branch: string | null,
  options: TransferOptions,
): Promise<WorkspaceRemoteBase[]> {
  let url: string;
  try {
    url = (await git(root, ["config", "--get", "remote.origin.url"], options))
      .toString("utf8")
      .trim();
  } catch {
    return [];
  }
  const result: WorkspaceRemoteBase[] = [];
  for (const name of new Set([
    ...(branch ? [branch] : []),
    "dev",
    "main",
    "master",
  ])) {
    if (
      !workspaceRemoteBaseSchema.safeParse({
        url,
        ref: `refs/heads/${name}`,
        head,
      }).success
    )
      continue;
    try {
      const base = (
        await git(
          root,
          ["merge-base", head, `refs/remotes/origin/${name}`],
          options,
        )
      )
        .toString("utf8")
        .trim();
      result.push(
        workspaceRemoteBaseSchema.parse({
          url,
          ref: `refs/heads/${name}`,
          head: base,
        }),
      );
    } catch {
      continue;
    }
  }
  return result;
}
export async function previewWorkspaceTransfer(
  rootPath: string,
  options: TransferOptions = {},
): Promise<WorkspaceTransferPreviewResult> {
  const root = await rootDirectory(rootPath);
  const state = await inspect(root, options);
  const tracked = new Set(
    [...state.headEntries, ...state.indexEntries].map((entry) => entry.path),
  );
  const files: WorkspaceTransferPreviewResult["files"] = [];
  for (const relative of [...tracked].sort()) {
    const excludedReason = secretReason(relative);
    if (!excludedReason)
      await fileIdentity(
        root,
        relative,
        state.head.length === 64 ? "sha256" : "sha1",
      );
    files.push({
      path: relative,
      kind: excludedReason ? "sensitive-tracked" : "tracked",
      tracked: true,
      selectedByDefault: !excludedReason,
      ...(excludedReason ? { excludedReason } : {}),
    });
  }
  for (const [kind, paths] of [
    ["untracked", state.untracked],
    ["ignored", state.ignored],
  ] as const)
    for (const relative of paths) {
      if (tracked.has(relative)) continue;
      const excludedReason =
        secretReason(relative) ??
        (state.ignored.includes(relative)
          ? "Ignored path; select exact ordinary files explicitly, not directories."
          : "Not copied unless explicitly selected.");
      files.push({
        path: relative,
        kind,
        tracked: false,
        selectedByDefault: false,
        excludedReason,
      });
    }
  const remoteBaseCandidates = await cachedRemoteBases(
    root,
    state.head,
    state.branch,
    options,
  );
  return {
    head: state.head,
    branch: state.branch,
    files,
    activeThreadIds: options.activeThreadIds?.() ?? [],
    ...(remoteBaseCandidates.length ? { remoteBaseCandidates } : {}),
    maxPayloadBytes: WORKSPACE_TRANSFER_MAX_BYTES,
  };
}
export async function captureWorkspace(
  rootPath: string,
  includePaths: string[],
  options: TransferOptions = {},
): Promise<{ checkpoint: WorkspaceCheckpoint }> {
  const root = await rootDirectory(rootPath);
  if (transfers.has(root))
    throw new Error(
      "A workspace operation is already in progress for this source.",
    );
  transfers.add(root);
  let release: (() => void) | undefined;
  let temporary: string | undefined;
  try {
    release = options.acquireCapture?.();
    if (options.activeThreadIds?.().length)
      throw new Error(
        "Workspace has active local sessions; stop them before capture.",
      );
    const gitDirectory = (
      await git(root, ["rev-parse", "--absolute-git-dir"], options)
    )
      .toString("utf8")
      .trim();
    const originalMetadata = await metadataFingerprint(gitDirectory);
    const selection = new Set(uniquePaths(includePaths));
    const state = await inspect(root, options);
    const remoteBase = options.remoteBase
      ? workspaceRemoteBaseSchema.parse(options.remoteBase)
      : undefined;
    if (remoteBase) {
      try {
        await git(
          root,
          ["merge-base", "--is-ancestor", remoteBase.head, state.head],
          options,
        );
      } catch {
        throw new Error(
          `Approved published prerequisite ${remoteBase.head} must be a locally available ancestor of source HEAD; the source was not fetched or modified.`,
        );
      }
    }
    const publishedPointers = remoteBase
      ? await publishedLfsPointers(
          root,
          state.headEntries,
          state.lfsPaths,
          remoteBase.head,
          options,
        )
      : new Map<string, string>();
    const publishedLfsFiles: NonNullable<
      WorkspaceCheckpoint["publishedLfsFiles"]
    > = [];
    const tracked = new Set(
      [...state.headEntries, ...state.indexEntries].map((entry) => entry.path),
    );
    for (const relative of tracked) {
      if (nativeAuthenticationPath(relative))
        throw new Error(
          `Native authentication/session paths cannot be transferred: ${relative}`,
        );
      if (secretReason(relative) && (!remoteBase || !selection.has(relative)))
        throw new Error(
          `Tracked sensitive path ${relative} requires explicit source-owner approval and an approved published remote base; private credential bytes cannot be copied.`,
        );
    }
    const charge = budget();
    const objectFormat = state.head.length === 64 ? "sha256" : "sha1";
    const headByPath = new Map(
      state.headEntries.map((entry) => [entry.path, entry]),
    );
    const publishedContextPaths = remoteBase
      ? [...tracked].filter((relative) => !!secretReason(relative))
      : [];
    const protectedContext = new Set(publishedContextPaths);
    if (remoteBase && publishedContextPaths.length) {
      const published = new Map(
        parseEntries(
          await git(
            root,
            ["ls-tree", "-rz", "--full-tree", remoteBase.head],
            options,
          ),
          true,
        ).map((entry) => [entry.path, entry]),
      );
      const staged = new Map(
        state.indexEntries.map((entry) => [entry.path, entry]),
      );
      for (const relative of publishedContextPaths) {
        const base = published.get(relative);
        const current = headByPath.get(relative);
        const index = staged.get(relative);
        if (nativeAuthenticationPath(relative))
          throw new Error(
            `Native authentication/session paths cannot be transferred: ${relative}`,
          );
        if (
          !base ||
          current?.oid !== base.oid ||
          current.mode !== base.mode ||
          index?.oid !== base.oid ||
          index.mode !== base.mode
        )
          throw new Error(
            `Flagged source context must already be unchanged at the explicitly approved published base: ${relative}`,
          );
      }
    }
    await assertNoSensitiveUnpublishedHistory(
      root,
      state.head,
      remoteBase?.head,
      options,
    );
    const intents = new Set(state.intentPaths);
    const index: WorkspaceCheckpoint["index"] = [];
    for (const entry of state.indexEntries) {
      const intentToAdd = intents.has(entry.path);
      if (headByPath.get(entry.path)?.oid === entry.oid)
        index.push({ ...entry, intentToAdd });
      else {
        const content = await git(
          root,
          ["cat-file", "blob", entry.oid],
          options,
        );
        charge(content.length);
        index.push({
          ...entry,
          intentToAdd,
          contentBase64: content.toString("base64"),
          sha256: sha256(content),
        });
      }
    }
    const identities = new Map<string, FileIdentity>();
    const worktree: WorkspaceCheckpoint["worktree"] = [];
    const filePermissions: WorkspaceCheckpoint["filePermissions"] = [];
    for (const relative of [...tracked].sort()) {
      const identity = await fileIdentity(
        root,
        relative,
        objectFormat,
        publishedPointers.has(relative),
      );
      identities.set(relative, identity);
      if (protectedContext.has(relative)) {
        const published = headByPath.get(relative)!;
        if (
          !identity ||
          identity.mode !== published.mode ||
          (identity.oid !== published.oid &&
            (!identity.contentSha256 ||
              identity.contentSha256 !== publishedPointers.get(relative)))
        )
          throw new Error(
            `Flagged source context has private worktree changes; these bytes will not be copied: ${relative}`,
          );
      }
      if (identity)
        filePermissions.push({
          path: relative,
          permissions: identity.permissions,
        });
      if (
        identity &&
        identity.mode !== "120000" &&
        identity.contentSha256 &&
        identity.contentSha256 === publishedPointers.get(relative)
      ) {
        publishedLfsFiles.push({
          path: relative,
          oid: identity.oid,
          mode: identity.mode,
        });
        continue;
      }
      const base = headByPath.get(relative);
      if (!identity) {
        if (base) worktree.push({ path: relative, file: null });
      } else if (identity.oid !== base?.oid || identity.mode !== base?.mode)
        worktree.push({
          path: relative,
          file: await readOrdinary(root, relative, charge, true),
        });
    }
    const extraFiles: WorkspaceTransferFile[] = [];
    for (const relative of selection)
      if (!tracked.has(relative)) {
        if (secretReason(relative))
          throw new Error(
            `Untracked sensitive configuration/auth/session bytes cannot be transferred: ${relative}`,
          );
        identities.set(
          relative,
          await fileIdentity(root, relative, objectFormat),
        );
        extraFiles.push(await readOrdinary(root, relative, charge));
      }
    temporary = await mkdtemp(path.join(tmpdir(), "bb-workspace-capture-"));
    const bundlePath = path.join(temporary, "workspace.bundle");
    let bundle: Buffer = Buffer.alloc(0);
    if (!remoteBase || remoteBase.head !== state.head) {
      await git(
        root,
        [
          "bundle",
          "create",
          bundlePath,
          "HEAD",
          ...(remoteBase ? [`^${remoteBase.head}`] : []),
        ],
        options,
      );
      charge((await stat(bundlePath)).size);
      bundle = await readFile(bundlePath);
    }
    if (JSON.stringify(state) !== JSON.stringify(await inspect(root, options)))
      throw new Error(
        "Source Git state changed during capture; stop writers and retry.",
      );
    for (const [relative, identity] of identities)
      if (
        JSON.stringify(identity) !==
        JSON.stringify(
          await fileIdentity(
            root,
            relative,
            objectFormat,
            publishedPointers.has(relative),
          ),
        )
      )
        throw new Error(
          `Source changed during capture: ${relative}; stop writers and retry.`,
        );
    if (
      JSON.stringify(originalMetadata) !==
        JSON.stringify(await metadataFingerprint(gitDirectory)) ||
      (await git(root, ["rev-parse", "HEAD"], options))
        .toString("utf8")
        .trim() !== state.head
    )
      throw new Error(
        "Source Git state changed during capture; stop writers and retry.",
      );
    if (
      bundle.length > 0 &&
      !(await git(root, ["bundle", "list-heads", bundlePath, "HEAD"], options))
        .toString("utf8")
        .startsWith(`${state.head} HEAD`)
    )
      throw new Error(
        "Source HEAD changed while creating the Git bundle; stop writers and retry.",
      );
    if (options.activeThreadIds?.().length)
      throw new Error(
        "A local session became active during capture; stop it and retry.",
      );
    const checkpoint: WorkspaceCheckpoint = {
      version: 1,
      head: state.head,
      branch: state.branch,
      ...(remoteBase ? { remoteBase } : {}),
      ...(publishedLfsFiles.length ? { publishedLfsFiles } : {}),
      ...(publishedContextPaths.length ? { publishedContextPaths } : {}),
      bundleBase64: bundle.toString("base64"),
      bundleSha256: sha256(bundle),
      lfsPaths: state.lfsPaths,
      index,
      worktree,
      extraFiles,
      filePermissions,
    };
    assertWorkspaceTransferSerializedSize(checkpoint);
    return { checkpoint };
  } finally {
    try {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    } finally {
      transfers.delete(root);
      release?.();
    }
  }
}
function decodedFile(
  file: Pick<WorkspaceTransferFile, "path" | "contentBase64" | "sha256">,
  charge: (bytes: number) => void,
) {
  const content = Buffer.from(file.contentBase64, "base64");
  charge(content.length);
  if (sha256(content) !== file.sha256)
    throw new Error(`File SHA-256 mismatch: ${file.path}`);
  return content;
}
async function writeOrdinary(
  root: string,
  file: WorkspaceTransferFile,
  content: Buffer,
  replace = false,
  allowSymlink = false,
) {
  if (file.mode === "120000" && !allowSymlink)
    throw new Error(
      `Symlinks are supported only for verified tracked workspace checkpoints: ${file.path}`,
    );
  const linkTarget =
    file.mode === "120000" ? confinedLinkTarget(file.path, content) : null;
  const absolute = await confined(root, file.path, true);
  if (replace) {
    try {
      const info = await lstat(absolute);
      if (!info.isFile() && !(allowSymlink && info.isSymbolicLink()))
        throw new Error(`Unsafe restore path: ${file.path}`);
      if (info.isSymbolicLink() || linkTarget !== null) await rm(absolute);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  if (linkTarget !== null) {
    await symlink(linkTarget, absolute);
    if (sha256(Buffer.from(await readlink(absolute))) !== file.sha256)
      throw new Error(`Target symlink verification failed: ${file.path}`);
    return;
  }
  const handle = await open(
    absolute,
    constants.O_RDWR |
      constants.O_CREAT |
      constants.O_NOFOLLOW |
      (replace ? constants.O_TRUNC : constants.O_EXCL),
    0o600,
  );
  try {
    await handle.writeFile(content);
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({
      start: 0,
      autoClose: false,
    }))
      hash.update(chunk);
    if (hash.digest("hex") !== file.sha256)
      throw new Error(`Target binary verification failed: ${file.path}`);
    await handle.chmod(file.permissions);
    if (((await handle.stat()).mode & 0o777) !== file.permissions)
      throw new Error(`Target permissions verification failed: ${file.path}`);
  } finally {
    await handle.close();
  }
}
export async function copyWorkspaceRead(rootPath: string, paths: string[]) {
  const root = await rootDirectory(rootPath);
  const charge = budget();
  const files: WorkspaceTransferFile[] = [];
  for (const relative of uniquePaths(paths))
    files.push(await readOrdinary(root, relative, charge));
  assertWorkspaceTransferSerializedSize({ files });
  return { files };
}
export async function copyWorkspaceWrite(
  rootPath: string,
  inputFiles: WorkspaceTransferFile[],
) {
  assertWorkspaceTransferSerializedSize({ files: inputFiles });
  const root = await rootDirectory(rootPath);
  const files = inputFiles.map((file) =>
    workspaceTransferFileSchema.parse(file),
  );
  uniquePaths(files.map((file) => file.path));
  const charge = budget();
  const contents = files.map((file) => decodedFile(file, charge));
  for (const file of files) {
    try {
      const absolute = await confined(root, file.path);
      await lstat(absolute);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    throw new Error(`Refusing to overwrite target file: ${file.path}`);
  }
  for (let index = 0; index < files.length; index++)
    await writeOrdinary(root, files[index]!, contents[index]!);
  return {
    files: files.map(({ path: relative, sha256: hash }) => ({
      path: relative,
      sha256: hash,
    })),
  };
}
export async function restoreWorkspace(
  targetPath: string,
  inputCheckpoint: WorkspaceCheckpoint,
  branchOverride?: string,
  options: TransferOptions = {},
) {
  assertWorkspaceTransferSerializedSize(inputCheckpoint);
  const checkpoint = workspaceCheckpointSchema.parse(inputCheckpoint);
  const charge = budget();
  const bundle = Buffer.from(checkpoint.bundleBase64, "base64");
  charge(bundle.length);
  if (sha256(bundle) !== checkpoint.bundleSha256)
    throw new Error("Workspace bundle SHA-256 mismatch.");
  uniquePaths(checkpoint.index.map((entry) => entry.path));
  uniquePaths(checkpoint.worktree.map((entry) => entry.path));
  uniquePaths(checkpoint.extraFiles.map((entry) => entry.path));
  uniquePaths(checkpoint.filePermissions.map((entry) => entry.path));
  for (const entry of checkpoint.index)
    if (entry.contentBase64 !== undefined)
      decodedFile(
        {
          path: entry.path,
          contentBase64: entry.contentBase64,
          sha256: entry.sha256!,
        },
        charge,
      );
  for (const entry of checkpoint.worktree)
    if (entry.file) {
      if (entry.path !== entry.file.path)
        throw new Error("Worktree entry path does not match file path.");
      const content = decodedFile(entry.file, charge);
      if (entry.file.mode === "120000") confinedLinkTarget(entry.path, content);
    }
  for (const file of checkpoint.extraFiles) {
    if (secretReason(file.path))
      throw new Error(
        `Untracked sensitive configuration/auth/session bytes cannot be restored: ${file.path}`,
      );
    if (file.mode === "120000")
      throw new Error(`Untracked symlinks cannot be transferred: ${file.path}`);
    decodedFile(file, charge);
  }
  if (
    bundle.length === 0 &&
    (!checkpoint.remoteBase || checkpoint.remoteBase.head !== checkpoint.head)
  )
    throw new Error(
      "An empty bundle requires source HEAD itself to be the approved published prerequisite",
    );
  uniquePaths((checkpoint.publishedLfsFiles ?? []).map((file) => file.path));
  if (
    checkpoint.publishedLfsFiles?.length &&
    (!checkpoint.remoteBase ||
      checkpoint.publishedLfsFiles.some(
        (file) =>
          !checkpoint.lfsPaths.includes(file.path) ||
          checkpoint.worktree.some((entry) => entry.path === file.path),
      ))
  )
    throw new Error(
      "Published LFS identities require an approved remote base and non-overlapping tracked LFS paths",
    );
  const publishedContext = new Set(
    uniquePaths(checkpoint.publishedContextPaths ?? []),
  );
  if (publishedContext.size && !checkpoint.remoteBase)
    throw new Error(
      "Published sensitive context requires an approved remote base.",
    );
  for (const relative of publishedContext)
    if (
      nativeAuthenticationPath(relative) ||
      !secretReason(relative) ||
      checkpoint.worktree.some((entry) => entry.path === relative) ||
      checkpoint.extraFiles.some((entry) => entry.path === relative) ||
      checkpoint.index.some(
        (entry) =>
          entry.path === relative &&
          (entry.contentBase64 !== undefined || entry.intentToAdd),
      )
    )
      throw new Error(`Invalid published sensitive context: ${relative}`);
  const requested = path.resolve(targetPath);
  await mkdir(path.dirname(requested), { recursive: true });
  const root = path.join(
    await realpath(path.dirname(requested)),
    path.basename(requested),
  );
  if (transfers.has(root))
    throw new Error(
      "A workspace operation is already in progress for this target.",
    );
  transfers.add(root);
  let created = false;
  let temporary: string | undefined;
  try {
    await mkdir(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST")
        throw new Error(`Refusing to overwrite existing target path: ${root}`);
      throw error;
    });
    created = true;
    temporary = await mkdtemp(path.join(tmpdir(), "bb-workspace-restore-"));
    const bundlePath = path.join(temporary, "workspace.bundle");
    await writeFile(bundlePath, bundle, { flag: "wx", mode: 0o600 });
    await git(
      root,
      [
        "init",
        "-q",
        ...(checkpoint.head.length === 64 ? ["--object-format=sha256"] : []),
      ],
      options,
    );
    const branch = branchOverride ?? checkpoint.branch;
    if (branch !== null)
      await git(root, ["check-ref-format", "--branch", branch], options);
    const remoteDeadline = Date.now() + 18 * 60 * 1000;
    const remoteOptions = () => ({
      ...options,
      nativeRemoteAuthentication: true,
      timeoutMs: Math.max(1, remoteDeadline - Date.now()),
    });
    if (checkpoint.remoteBase) {
      await git(
        root,
        ["remote", "add", "origin", checkpoint.remoteBase.url],
        options,
      );
      await git(
        root,
        [
          "fetch",
          "--quiet",
          "--no-tags",
          "--no-recurse-submodules",
          "origin",
          checkpoint.remoteBase.ref,
        ],
        remoteOptions(),
      );
      try {
        await git(
          root,
          [
            "merge-base",
            "--is-ancestor",
            checkpoint.remoteBase.head,
            "FETCH_HEAD^{commit}",
          ],
          options,
        );
      } catch {
        throw new Error(
          `Target origin/ref does not contain the approved published prerequisite ${checkpoint.remoteBase.head}; no alternate account, origin or full-history fallback was attempted.`,
        );
      }
    }
    if (bundle.length)
      await git(root, ["fetch", "--no-tags", bundlePath, "HEAD"], options);
    const fetched = (
      await git(
        root,
        [
          "rev-parse",
          bundle.length ? "FETCH_HEAD^{commit}" : `${checkpoint.head}^{commit}`,
        ],
        options,
      )
    )
      .toString("utf8")
      .trim();
    if (fetched !== checkpoint.head)
      throw new Error("Bundle HEAD does not match the checkpoint HEAD.");
    const headEntries = parseEntries(
      await git(
        root,
        ["ls-tree", "-rz", "--full-tree", checkpoint.head],
        options,
      ),
      true,
    );
    for (const entry of headEntries)
      if (entry.mode === "120000")
        confinedLinkTarget(
          entry.path,
          await git(root, ["cat-file", "blob", entry.oid], options),
        );
    for (const entry of checkpoint.index)
      if (entry.mode === "120000" && !entry.intentToAdd)
        confinedLinkTarget(
          entry.path,
          entry.contentBase64 === undefined
            ? await git(root, ["cat-file", "blob", entry.oid], options)
            : Buffer.from(entry.contentBase64, "base64"),
        );
    const trackedPaths = new Set(
      [...headEntries, ...checkpoint.index].map((entry) => entry.path),
    );
    uniquePaths([
      ...trackedPaths,
      ...checkpoint.extraFiles.map((file) => file.path),
    ]);
    for (const entry of checkpoint.worktree)
      if (!trackedPaths.has(entry.path))
        throw new Error(`Worktree delta is not a tracked path: ${entry.path}`);
    for (const file of checkpoint.extraFiles)
      if (trackedPaths.has(file.path))
        throw new Error(`Extra file conflicts with tracked path: ${file.path}`);
    const sensitiveTracked = [...trackedPaths].filter(
      (relative) => !!secretReason(relative),
    );
    if (
      sensitiveTracked.some(
        (relative) =>
          nativeAuthenticationPath(relative) || !publishedContext.has(relative),
      ) ||
      [...publishedContext].some((relative) => !trackedPaths.has(relative))
    )
      throw new Error(
        "Sensitive tracked paths require exact published-context approval; native authentication/session paths cannot be restored.",
      );
    if (publishedContext.size) {
      const publishedEntries =
        checkpoint.remoteBase!.head === checkpoint.head
          ? headEntries
          : parseEntries(
              await git(
                root,
                ["ls-tree", "-rz", "--full-tree", checkpoint.remoteBase!.head],
                options,
              ),
              true,
            );
      const publishedByPath = new Map(
        publishedEntries.map((entry) => [entry.path, entry]),
      );
      const currentByPath = new Map(
        headEntries.map((entry) => [entry.path, entry]),
      );
      const stagedByPath = new Map(
        checkpoint.index.map((entry) => [entry.path, entry]),
      );
      for (const relative of publishedContext) {
        const base = publishedByPath.get(relative);
        const current = currentByPath.get(relative);
        const staged = stagedByPath.get(relative);
        if (
          !base ||
          current?.oid !== base.oid ||
          current.mode !== base.mode ||
          staged?.oid !== base.oid ||
          staged.mode !== base.mode
        )
          throw new Error(
            `Sensitive context is not unchanged at the approved published prerequisite: ${relative}`,
          );
      }
    }
    await assertNoSensitiveUnpublishedHistory(
      root,
      checkpoint.head,
      checkpoint.remoteBase?.head,
      options,
    );
    await git(root, ["checkout", "--detach", checkpoint.head], options);
    for (const entry of headEntries) {
      const identity = await fileIdentity(
        root,
        entry.path,
        checkpoint.head.length === 64 ? "sha256" : "sha1",
      );
      if (identity?.oid !== entry.oid || identity.mode !== entry.mode) {
        const content = await git(
          root,
          ["cat-file", "blob", entry.oid],
          options,
        );
        await writeOrdinary(
          root,
          {
            path: entry.path,
            mode: entry.mode,
            permissions:
              entry.mode === "120000"
                ? 0o777
                : entry.mode === "100755"
                  ? 0o755
                  : 0o644,
            contentBase64: content.toString("base64"),
            sha256: sha256(content),
          },
          content,
          true,
          true,
        );
      }
    }
    if (checkpoint.lfsPaths.length) {
      try {
        await git(root, ["lfs", "version"], options);
      } catch {
        throw new Error(
          "This checkpoint contains Git LFS files. Install Git LFS on the target machine, then retry; published LFS also requires target-local remote authorization. No target environment was registered.",
        );
      }
      // Git LFS checkout otherwise returns success without materializing files
      // when filter.lfs.clean is absent, even if the LFS binary is installed.
      for (const [key, value] of [
        ["clean", "git-lfs clean -- %f"],
        ["smudge", "git-lfs smudge -- %f"],
        ["process", "git-lfs filter-process"],
        ["required", "true"],
      ]) {
        await git(
          root,
          ["config", "--local", `filter.lfs.${key}`, value!],
          options,
        );
      }
    }
    if (checkpoint.remoteBase && checkpoint.publishedLfsFiles?.length) {
      await git(
        root,
        [
          "-c",
          "lfs.fetchinclude=",
          "-c",
          "lfs.fetchexclude=",
          "lfs",
          "fetch",
          "origin",
          checkpoint.remoteBase.head,
        ],
        remoteOptions(),
      );
      for (
        let offset = 0;
        offset < checkpoint.publishedLfsFiles.length;
        offset += 100
      )
        await git(
          root,
          [
            "lfs",
            "checkout",
            "--",
            ...checkpoint.publishedLfsFiles
              .slice(offset, offset + 100)
              .map((file) => file.path),
          ],
          remoteOptions(),
        );
    }
    if (branch !== null) {
      await git(
        root,
        ["update-ref", `refs/heads/${branch}`, checkpoint.head],
        options,
      );
      await git(
        root,
        ["symbolic-ref", "HEAD", `refs/heads/${branch}`],
        options,
      );
    }
    await git(root, ["read-tree", "--empty"], options);
    const headByPath = new Map(headEntries.map((entry) => [entry.path, entry]));
    for (const entry of checkpoint.index) {
      if (entry.contentBase64 !== undefined) {
        const oid = (
          await git(
            root,
            ["hash-object", "-w", "--stdin"],
            options,
            Buffer.from(entry.contentBase64, "base64"),
          )
        )
          .toString("utf8")
          .trim();
        if (oid !== entry.oid)
          throw new Error(`Index blob object hash mismatch: ${entry.path}`);
      } else if (headByPath.get(entry.path)?.oid !== entry.oid)
        throw new Error(`Missing changed index blob: ${entry.path}`);
    }
    const indexInfo = checkpoint.index
      .filter((entry) => !entry.intentToAdd)
      .map((entry) => `${entry.mode} ${entry.oid}\t${entry.path}\0`)
      .join("");
    await git(
      root,
      ["update-index", "-z", "--index-info"],
      options,
      Buffer.from(indexInfo),
    );
    for (const entry of checkpoint.worktree)
      if (!entry.file) {
        try {
          const absolute = await confined(root, entry.path);
          const info = await lstat(absolute);
          if (!info.isFile() && !info.isSymbolicLink())
            throw new Error(`Unsafe deletion path: ${entry.path}`);
          await rm(absolute);
          let parent = path.dirname(absolute);
          while (parent !== root) {
            try {
              await rmdir(parent);
            } catch {
              break;
            }
            parent = path.dirname(parent);
          }
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
    for (const entry of checkpoint.worktree)
      if (entry.file)
        await writeOrdinary(
          root,
          entry.file,
          Buffer.from(entry.file.contentBase64, "base64"),
          true,
          true,
        );
    for (const file of checkpoint.extraFiles)
      await writeOrdinary(
        root,
        file,
        Buffer.from(file.contentBase64, "base64"),
      );
    for (const entry of checkpoint.index)
      if (entry.intentToAdd) {
        if (entry.mode === "120000") {
          const absolute = await confined(root, entry.path);
          if (!(await lstat(absolute)).isSymbolicLink())
            throw new Error(
              `Intent-to-add symlink must be present: ${entry.path}`,
            );
          await git(
            root,
            ["add", "--force", "--intent-to-add", "--", entry.path],
            options,
          );
          continue;
        }
        const absolute = await confined(root, entry.path, true);
        let originalMode: number | null = null;
        try {
          originalMode = (await lstat(absolute)).mode;
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        if (originalMode === null)
          await writeFile(absolute, Buffer.alloc(0), { flag: "wx" });
        const handle = await open(
          absolute,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          await handle.chmod(entry.mode === "100755" ? 0o755 : 0o644);
        } finally {
          await handle.close();
        }
        await git(
          root,
          ["add", "--force", "--intent-to-add", "--", entry.path],
          options,
        );
        if (originalMode === null) await rm(absolute);
        else {
          const restored = await open(
            absolute,
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          try {
            await restored.chmod(originalMode & 0o777);
          } finally {
            await restored.close();
          }
        }
      }
    const actualIndex = parseEntries(
      await git(root, ["ls-files", "--stage", "-z"], options),
      false,
    );
    const expectedIndex = checkpoint.index
      .map(({ path: relative, mode, oid }) => ({ path: relative, mode, oid }))
      .sort((a, b) => a.path.localeCompare(b.path));
    if (
      JSON.stringify(
        actualIndex.sort((a, b) => a.path.localeCompare(b.path)),
      ) !== JSON.stringify(expectedIndex)
    )
      throw new Error("Restored index verification failed.");
    const restoredState = await inspect(root, options);
    if (
      JSON.stringify(restoredState.lfsPaths.sort()) !==
      JSON.stringify([...checkpoint.lfsPaths].sort())
    )
      throw new Error(
        "Restored LFS attributes differ from the source. Explicitly include the applicable .gitattributes files; source-only .git/info/attributes must be migrated into .gitattributes before transfer.",
      );
    const restoredIntents = restoredState.intentPaths.sort();
    if (
      JSON.stringify(restoredIntents) !==
      JSON.stringify(
        checkpoint.index
          .filter((entry) => entry.intentToAdd)
          .map((entry) => entry.path)
          .sort(),
      )
    )
      throw new Error(
        "Restored intent-to-add index flags failed verification.",
      );
    const expectedWorktree = new Map<
      string,
      { oid: string; mode: GitEntry["mode"]; permissions: number | null }
    >(
      headEntries.map((entry) => [
        entry.path,
        { oid: entry.oid, mode: entry.mode, permissions: null },
      ]),
    );
    for (const entry of checkpoint.worktree) {
      if (!entry.file) expectedWorktree.delete(entry.path);
      else
        expectedWorktree.set(entry.path, {
          oid: createHash(checkpoint.head.length === 64 ? "sha256" : "sha1")
            .update(
              `blob ${Buffer.byteLength(entry.file.contentBase64, "base64")}\0`,
            )
            .update(Buffer.from(entry.file.contentBase64, "base64"))
            .digest("hex"),
          mode: entry.file.mode,
          permissions: null,
        });
    }
    for (const file of checkpoint.publishedLfsFiles ?? []) {
      if (!expectedWorktree.has(file.path))
        throw new Error(
          `Published LFS path is not present in HEAD: ${file.path}`,
        );
      expectedWorktree.set(file.path, {
        oid: file.oid,
        mode: file.mode,
        permissions: null,
      });
    }
    if (checkpoint.filePermissions.length !== expectedWorktree.size)
      throw new Error(
        "Checkpoint must preserve permissions for every present tracked file.",
      );
    for (const entry of checkpoint.filePermissions) {
      const expected = expectedWorktree.get(entry.path);
      if (!expected)
        throw new Error(
          `Permissions do not belong to a present tracked file: ${entry.path}`,
        );
      expected.permissions = entry.permissions;
      if (expected.mode === "120000") {
        if (entry.permissions !== 0o777)
          throw new Error(`Invalid symlink permissions: ${entry.path}`);
        continue;
      }
      const handle = await open(
        await confined(root, entry.path),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        await handle.chmod(entry.permissions);
      } finally {
        await handle.close();
      }
    }
    for (const relative of trackedPaths) {
      const actual = await fileIdentity(
        root,
        relative,
        checkpoint.head.length === 64 ? "sha256" : "sha1",
      );
      const expected = expectedWorktree.get(relative);
      if (
        actual?.oid !== expected?.oid ||
        actual?.mode !== expected?.mode ||
        actual?.permissions !== expected?.permissions
      )
        throw new Error(`Restored worktree verification failed: ${relative}`);
    }
    return { rootPath: root, head: checkpoint.head, branch };
  } catch (error) {
    if (created) await rm(root, { recursive: true, force: true });
    throw error;
  } finally {
    try {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    } finally {
      transfers.delete(root);
    }
  }
}
