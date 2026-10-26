import type { ExperimentalNativeRootsResolveAnswer } from "@get-bb/plugin-sdk/host";

export type AcpNativeRootsEnvironment = Readonly<
  Record<string, string | undefined>
>;

export interface AcpNativeRootsResolverArgs {
  cwd: string | null;
  homeDir: string;
  env: AcpNativeRootsEnvironment;
  executionContext?: {
    skillRoots: readonly string[];
    commandRoots?: readonly string[];
    pluginRoots?: readonly string[];
  } | null;
}

export type AcpResolvedSkillRoot = NonNullable<
  ExperimentalNativeRootsResolveAnswer["skills"]
>[number];

export type AcpNativeRootsResolver = (
  args: AcpNativeRootsResolverArgs,
) => Promise<ExperimentalNativeRootsResolveAnswer>;
