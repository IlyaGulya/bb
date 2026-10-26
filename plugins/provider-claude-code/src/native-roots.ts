import path from "node:path";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  experimental_executionContextSnapshotSchema as executionContextSnapshotSchema,
  type ExecutionContextSnapshot,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import {
  experimental_filterResolvedNativeRoots,
  experimental_resolveClaudePluginRoots,
  experimental_resolveVendorPluginRoots,
  type ExperimentalClaudePluginRootsArgs,
  type ExperimentalVendorPluginRoots,
} from "@get-bb/plugin-sdk/host";
import { buildClaudeContextRoots } from "./bridge/skill-plugins.js";

export const CLAUDE_NATIVE_ROOTS_DECLARATION: Pick<
  PluginProviderDeclaration,
  | "experimental_nativeSkillRoots"
  | "experimental_nativeCommandRoots"
  | "experimental_resolvesNativeRoots"
> = {
  experimental_nativeSkillRoots: {
    user: [
      { path: ".claude/skills", skipIfManifest: ".claude-plugin/plugin.json" },
    ],
    project: [
      {
        path: ".claude/skills",
        ancestors: true,
        skipIfManifest: ".claude-plugin/plugin.json",
      },
    ],
  },
  experimental_nativeCommandRoots: {
    project: [".claude/commands"],
  },
  experimental_resolvesNativeRoots: true,
};

const CLAUDE_PLUGIN_MANIFEST_MARKER = ".claude-plugin/plugin.json";

type ClaudeResolvedRoot = ExperimentalVendorPluginRoots["skills"][number];
interface ClaudeNativeRootsArgs extends ExperimentalClaudePluginRootsArgs {
  executionContext?: ExecutionContextSnapshot;
}

async function resolveScopedRoots(
  context: ExecutionContextSnapshot,
): Promise<ExperimentalVendorPluginRoots> {
  const plugins = await Promise.all(
    context.pluginRoots.map(async (rootPath) => {
      const manifest = z
        .object({
          name: z.string().min(1),
          skills: z.union([z.string(), z.array(z.string())]).optional(),
          commands: z.union([z.string(), z.array(z.string())]).optional(),
        })
        .parse(
          JSON.parse(
            await readFile(
              path.join(rootPath, ".claude-plugin", "plugin.json"),
              "utf8",
            ),
          ),
        );
      return { rootPath, ...manifest, origin: "project" as const };
    }),
  );
  const pluginRoots = await experimental_resolveVendorPluginRoots({
    plugins,
    layout: "claude",
  });
  const injectedRoots = buildClaudeContextRoots(context);
  const roots = {
    skills: [
      ...injectedRoots
        .filter((root) => root.shape === "skills")
        .map((root): ClaudeResolvedRoot => ({
          path: root.path,
          origin: "project",
          shape: "skills",
          namePrefix: `${root.name}:`,
        })),
      ...pluginRoots.skills,
    ],
    commands: [
      ...injectedRoots
        .filter((root) => root.shape === "commands")
        .map((root): ClaudeResolvedRoot => ({
          path: root.path,
          origin: "project",
          shape: "commands",
          namePrefix: `${root.name}:`,
        })),
      ...pluginRoots.commands,
    ],
  };
  const filtered = experimental_filterResolvedNativeRoots(roots, {
    warn: console.warn,
  });
  if (
    filtered.dropped.length > 0 ||
    filtered.truncated.skills > 0 ||
    filtered.truncated.commands > 0
  ) {
    throw new Error(
      "Claude selected context contains unsupported native roots; scoped roots were not replaced with ambient ones.",
    );
  }
  return filtered.answer;
}

export async function resolveClaudeNativeRoots(
  args: ClaudeNativeRootsArgs,
): Promise<ExperimentalVendorPluginRoots> {
  if (args.executionContext !== undefined) {
    return resolveScopedRoots(
      executionContextSnapshotSchema.parse(args.executionContext),
    );
  }
  const plugins = await experimental_resolveClaudePluginRoots(args);
  const userSkillsRoot: ClaudeResolvedRoot = {
    path: path.join(plugins.claudeDir, "skills"),
    origin: "user",
    shape: "skills",
    skipIfManifest: CLAUDE_PLUGIN_MANIFEST_MARKER,
  };
  const userCommandsRoot: ClaudeResolvedRoot = {
    path: path.join(plugins.claudeDir, "commands"),
    origin: "user",
    shape: "commands",
  };

  return experimental_filterResolvedNativeRoots(
    {
      skills: [
        userSkillsRoot,
        ...plugins.skills.filter((root) => root.path !== userSkillsRoot.path),
      ],
      commands: [
        userCommandsRoot,
        ...plugins.commands.filter(
          (root) => root.path !== userCommandsRoot.path,
        ),
      ],
    },
    { warn: console.warn },
  ).answer;
}
