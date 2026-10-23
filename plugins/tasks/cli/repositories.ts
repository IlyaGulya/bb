import { cliCommand, type PluginCliResult } from "@get-bb/plugin-sdk";
import type { RepositoryHandlers } from "../repositories";
import { repositoryRpcContract } from "../shared/repositories";
import type { Task } from "../shared/contract";

export function repositoryCommands(
  handlers: RepositoryHandlers,
  resolveTask: (address: string) => Promise<Task>,
  guard: (
    action: () => Promise<string | PluginCliResult>,
  ) => Promise<PluginCliResult>,
) {
  const positionals = [
    { name: "task", description: "Task key or ID", required: true },
  ] as const;
  const json = { type: "boolean", description: "Emit compact JSON" } as const;
  return {
    "repositories inspect": cliCommand({
      summary:
        "Inspect a repository source, HEAD, dirty files and running writers without copying or starting anything",
      positionals,
      options: {
        json,
        project: {
          type: "string",
          required: true,
          description: "Explicit BB code project ID",
        },
        environment: {
          type: "string",
          required: true,
          description: "Source environment ID",
        },
        host: { type: "string", required: true, description: "Target host ID" },
      },
      run(input) {
        return guard(async () =>
          JSON.stringify(
            await handlers.inspectTaskRepository({
              taskId: (await resolveTask(input.positionals.task)).id,
              bbProjectId: input.options.project,
              sourceEnvironmentId: input.options.environment,
              targetHostId: input.options.host,
            }),
            null,
            input.options.json ? undefined : 2,
          ),
        );
      },
    }),
    "repositories prepare": cliCommand({
      summary:
        "Queue preparation of all explicit bindings and return a checkpoint immediately; observe with repositories show, never start an executor",
      positionals,
      options: {
        json,
        bindings: {
          type: "string",
          required: true,
          description:
            "JSON bindings with explicit owner, role, source identity, target path, isolated branch, instructions and selected files; large repositories use approved credential-free remoteBase {url,ref,head}. Ordinary source code needs no per-file approval; ambiguous key files require explicit review and unchanged published provenance",
        },
        checkpoint: {
          type: "string",
          description:
            "Retry this settled checkpoint, preserving verified roots and choosing fresh paths for failed or interrupted roots",
        },
      },
      run(input) {
        return guard(async () =>
          JSON.stringify(
            await handlers.prepareTaskRepositories(
              repositoryRpcContract.prepareTaskRepositories.input.parse({
                taskId: (await resolveTask(input.positionals.task)).id,
                bindings: JSON.parse(input.options.bindings),
                ...(input.options.checkpoint
                  ? { checkpointId: input.options.checkpoint }
                  : {}),
              }),
            ),
            null,
            input.options.json ? undefined : 2,
          ),
        );
      },
    }),
    "repositories show": cliCommand({
      summary:
        "Observe queued preparation, aggregate/per-root progress, errors, native operation IDs and the shared writer; reconcile interrupted receipts without replay",
      positionals,
      options: { json },
      run(input) {
        return guard(async () =>
          JSON.stringify(
            await handlers.getTaskRepositories({
              taskId: (await resolveTask(input.positionals.task)).id,
            }),
            null,
            input.options.json ? undefined : 2,
          ),
        );
      },
    }),
    "repositories continue": cliCommand({
      summary:
        "Start or recover one coherent writer across all verified folders only after every required repository is ready",
      positionals,
      options: {
        json,
        checkpoint: {
          type: "string",
          required: true,
          description: "Prepared aggregate checkpoint ID",
        },
      },
      run(input) {
        return guard(async () =>
          JSON.stringify(
            await handlers.continueTaskRepositories({
              taskId: (await resolveTask(input.positionals.task)).id,
              checkpointId: input.options.checkpoint,
            }),
            null,
            input.options.json ? undefined : 2,
          ),
        );
      },
    }),
  };
}
