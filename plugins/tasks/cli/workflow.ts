import { cliCommand, type PluginCliResult } from "@get-bb/plugin-sdk";
import type { TaskWorkflowHandlers } from "../workflow/index.js";
import type { Task } from "../shared/contract.js";
import { workflowRpcContract } from "../shared/workflow-contract.js";

export function workflowCommands(
  handlers: TaskWorkflowHandlers,
  resolveTask: (address: string) => Promise<Task>,
  guard: (
    action: () => Promise<string | PluginCliResult>,
  ) => Promise<PluginCliResult>,
) {
  const task = {
    name: "task",
    description: "Task key or ID",
    required: true,
  } as const;
  const id = {
    name: "id",
    description: "Task workflow receipt ID",
    required: true,
  } as const;
  const json = {
    type: "boolean",
    description: "Emit machine-readable JSON",
  } as const;
  const revision = {
    type: "string",
    required: true,
    description: "Exact published revision (prevents stale decisions)",
  } as const;
  return {
    "workflow start": cliCommand({
      summary:
        "Plan, build and smoke with one writer, then independently review; never auto-accept",
      positionals: [task],
      options: {
        json,
        key: {
          type: "string",
          required: true,
          description: "Stable launch idempotency key; reuse on retry",
        },
        origin: {
          type: "string",
          required: true,
          description:
            "Idle native thread in the linked project's prepared workspace",
        },
        writer: {
          type: "string",
          required: true,
          description: "Allowed writer execution-profile ID",
        },
        reviewer: {
          type: "string",
          required: true,
          description: "Allowed independent runtime/model profile ID",
        },
        smoke: {
          type: "string",
          required: true,
          description: "JSON array of actual platform smoke commands",
        },
        ui: {
          type: "boolean",
          description: "Require screenshot/preview evidence",
        },
      },
      run(input) {
        return guard(async () =>
          JSON.stringify(
            await handlers.launchTaskWorkflow(
              workflowRpcContract.launchTaskWorkflow.input.parse({
                taskId: (await resolveTask(input.positionals.task)).id,
                launchKey: input.options.key,
                originThreadId: input.options.origin,
                writerPresetId: input.options.writer,
                reviewerPresetId: input.options.reviewer,
                smokeCommands: JSON.parse(input.options.smoke),
                uiRequired: input.options.ui ?? false,
              }),
            ),
            null,
            2,
          ),
        );
      },
    }),
    "workflow list": cliCommand({
      summary:
        "Inspect task workflow receipts, native workers and result packages",
      positionals: [task],
      options: { json },
      run(input) {
        return guard(async () =>
          JSON.stringify(
            await handlers.taskWorkflows({
              taskId: (await resolveTask(input.positionals.task)).id,
            }),
            null,
            2,
          ),
        );
      },
    }),
    "workflow accept": cliCommand({
      summary:
        "Human acceptance: mark the exact reviewed result done and release retained workers",
      positionals: [id],
      options: { json, revision },
      run(input) {
        return guard(async () =>
          JSON.stringify(
            await handlers.acceptTaskWorkflow(
              workflowRpcContract.acceptTaskWorkflow.input.parse({
                id: input.positionals.id,
                revision: Number(input.options.revision),
              }),
            ),
            null,
            2,
          ),
        );
      },
    }),
    "workflow return": cliCommand({
      summary:
        "Return feedback to the same retained writer session and workspace",
      positionals: [id],
      options: {
        json,
        revision,
        feedback: {
          type: "string",
          required: true,
          description: "Concrete human revision feedback",
        },
      },
      run(input) {
        return guard(async () =>
          JSON.stringify(
            await handlers.returnTaskWorkflow(
              workflowRpcContract.returnTaskWorkflow.input.parse({
                id: input.positionals.id,
                revision: Number(input.options.revision),
                feedback: input.options.feedback,
              }),
            ),
            null,
            2,
          ),
        );
      },
    }),
  };
}
