import { stat } from "node:fs/promises";
import path from "node:path";
import { experimental_resolveClaudePluginRoots } from "@get-bb/plugin-sdk/host";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { resolveOpenCodeConfigDir } from "./opencode.js";
import type {
  AcpNativeRootsEnvironment,
  AcpNativeRootsResolver,
  AcpNativeRootsResolverArgs,
  AcpResolvedSkillRoot,
} from "./resolver.js";
import {
  configuredSkillRoot,
  isPathWithinDirectory,
  readParsedFile,
  resolveConfiguredHomeDirectory,
  resolveConfiguredPath,
  resolveProjectAncestorDirectories,
  skillsRoot,
  type ResolvedRootOrigin,
} from "./shared.js";

const OMP_DIR_NAME = ".omp";
const PI_DIR_NAME = ".pi";
const OMP_PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const ompSkillConfigSchema = z
  .object({
    skills: z
      .object({ customDirectories: z.array(z.string()).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

function resolveCodexHome(
  homeDir: string,
  env: AcpNativeRootsEnvironment,
): string {
  return env.CODEX_HOME?.trim() || path.join(homeDir, ".codex");
}

function resolvePiAgentDir(
  homeDir: string,
  env: AcpNativeRootsEnvironment,
): string {
  return resolveConfiguredHomeDirectory(
    homeDir,
    env.PI_CODING_AGENT_DIR,
    PI_DIR_NAME,
    "agent",
  );
}

export function resolveOmpAgentDir(
  homeDir: string,
  env: AcpNativeRootsEnvironment,
): string {
  const profile =
    env.OMP_PROFILE !== undefined
      ? env.OMP_PROFILE.trim()
      : env.PI_PROFILE?.trim();
  if (
    profile &&
    profile !== "default" &&
    OMP_PROFILE_NAME_PATTERN.test(profile)
  ) {
    return path.join(homeDir, OMP_DIR_NAME, "profiles", profile, "agent");
  }
  return resolveConfiguredHomeDirectory(
    homeDir,
    env.PI_CODING_AGENT_DIR,
    OMP_DIR_NAME,
    "agent",
  );
}

async function resolveOmpConfiguredSkillRoots(
  args: AcpNativeRootsResolverArgs,
): Promise<AcpResolvedSkillRoot[]> {
  const cwd = args.cwd ?? args.homeDir;
  const agentDir = resolveOmpAgentDir(args.homeDir, args.env);
  const userConfigPaths = [
    path.join(agentDir, "config.yml"),
    path.join(agentDir, "config.yaml"),
  ];
  const configPaths = [
    ...(args.cwd === null
      ? []
      : [path.join(args.cwd, OMP_DIR_NAME, "config.yml")]),
    ...(
      args.env.PI_CONFIG_FILES?.split(path.delimiter).filter(Boolean) ?? []
    ).map((filePath) =>
      resolveConfiguredPath({
        basePath: cwd,
        env: args.env,
        homeDir: args.homeDir,
        value: filePath,
      }),
    ),
  ];
  const projectRootPath =
    args.cwd === null
      ? null
      : (await resolveProjectAncestorDirectories(args.cwd)).projectRootPath;
  let customDirectories: string[] = [];
  let customOrigin: ResolvedRootOrigin = "user";
  for (const configPath of userConfigPaths) {
    const config = await readParsedFile(
      configPath,
      parseYaml,
      ompSkillConfigSchema,
    );
    if (config !== null) {
      customDirectories = config.skills?.customDirectories ?? [];
      break;
    }
  }
  for (const configPath of configPaths) {
    const config = await readParsedFile(
      configPath,
      parseYaml,
      ompSkillConfigSchema,
    );
    if (config?.skills?.customDirectories !== undefined) {
      customDirectories = config.skills.customDirectories;
      customOrigin =
        projectRootPath !== null &&
        isPathWithinDirectory(projectRootPath, configPath)
          ? "project"
          : "user";
    }
  }
  return customDirectories.map((configuredPath) =>
    configuredSkillRoot({
      origin: customOrigin,
      recursive: false,
      skillPath: resolveConfiguredPath({
        basePath: cwd,
        env: args.env,
        homeDir: args.homeDir,
        value: configuredPath,
      }),
    }),
  );
}

async function requireScopedDirectory(rootPath: string, kind: string): Promise<void> {
  if (!path.isAbsolute(rootPath)) {
    throw new Error(`OMP execution-context ${kind} roots must be absolute host paths.`);
  }
  const root = await stat(rootPath).catch(() => null);
  if (!root?.isDirectory()) {
    throw new Error(
      `OMP execution-context ${kind} root is unavailable or not a directory: ${rootPath}`,
    );
  }
}

export const resolveOmpNativeRoots: AcpNativeRootsResolver = async (args) => {
  if (args.executionContext) {
    const context = args.executionContext;
    const skills = await Promise.all(context.skillRoots.map(async (rootPath) => {
      await requireScopedDirectory(rootPath, "skill");
      return skillsRoot({ origin: "project", path: rootPath, recursive: false });
    }));
    const commands = await Promise.all((context.commandRoots ?? []).map(async (rootPath) => {
      await requireScopedDirectory(rootPath, "command");
      return { origin: "project" as const, path: rootPath, recursive: true };
    }));
    for (const rootPath of context.pluginRoots ?? []) {
      await requireScopedDirectory(rootPath, "plugin");
      // Native OMP extension packages discover sibling directories, not
      // Claude manifest component entries or a root SKILL.md.
      const skillPath = path.join(rootPath, "skills");
      const commandPath = path.join(rootPath, "commands");
      if ((await stat(skillPath).catch(() => null))?.isDirectory()) {
        skills.push(skillsRoot({ origin: "project", path: skillPath, recursive: true }));
      }
      if ((await stat(commandPath).catch(() => null))?.isDirectory()) {
        commands.push({ origin: "project", path: commandPath, recursive: true });
      }
    }
    return { skills, commands };
  }
  const agentDir = resolveOmpAgentDir(args.homeDir, args.env);
  const userRoot = (rootPath: string): AcpResolvedSkillRoot =>
    skillsRoot({ origin: "user", path: rootPath, recursive: false });
  return {
    skills: [
      userRoot(path.join(agentDir, "skills")),
      userRoot(path.join(agentDir, "managed-skills")),
      userRoot(path.join(resolvePiAgentDir(args.homeDir, args.env), "skills")),
      userRoot(path.join(resolveCodexHome(args.homeDir, args.env), "skills")),
      userRoot(
        path.join(resolveOpenCodeConfigDir(args.homeDir, args.env), "skills"),
      ),
      ...(await resolveOmpConfiguredSkillRoots(args)),
      ...(await experimental_resolveClaudePluginRoots(args)).skills,
    ],
  };
};
