import { cliCommand, type BbPluginApi, type PluginCliContext, type PluginCliResult } from "@get-bb/plugin-sdk";
import type { TasksApiStore } from "../api/index.js";
import { taskArtifactHandlers } from "../artifacts/index.js";
import { taskArtifactRpcContract } from "../shared/artifacts.js";
import type { Task } from "../shared/contract.js";

export function artifactCommands(
  bb: BbPluginApi,
  store: TasksApiStore,
  resolveTask: (address: string) => Promise<Task>,
  guard: (action: () => Promise<string | PluginCliResult>) => Promise<PluginCliResult>,
) {
  const service = taskArtifactHandlers(bb, store);
  const task = { name: "task", description: "Task key or ID", required: true } as const;
  const artifact = { name: "artifact", description: "Retained artifact ID returned by create/list", required: true } as const;
  const json = { type: "boolean", description: "Emit machine-readable JSON" } as const;
  const context = { type: "string", description: "Logical execution context name for an operator outside a thread; never a model account" } as const;
  const options = { json, context };
  async function scope(address: string, selected: string | undefined, ctx: PluginCliContext) {
    let executionContextId: string;
    if (ctx.threadId) {
      if (selected) throw new Error("An invoking thread uses its frozen context; omit --context");
      const binding = await bb.sdk.experimental_executionContexts.getThreadBinding({ threadId: ctx.threadId });
      if (!binding?.executionContext) throw new Error("This thread has no logical execution context");
      executionContextId = binding.executionContext.id;
    } else {
      if (!selected) throw new Error("Choose --context by name outside a thread");
      const matches = (await bb.sdk.experimental_executionContexts.list()).filter(entry => entry.name === selected);
      if (matches.length !== 1) throw new Error("Choose a unique existing context name");
      executionContextId = matches[0]!.id;
    }
    return { taskId: (await resolveTask(address)).id, executionContextId };
  }
  const emit = (action: () => Promise<unknown>) => guard(async () => JSON.stringify(await action(), null, 2));
  return {
    "artifact list": cliCommand({
      summary: "List retained task decisions and screenshot annotations in the invoking logical context",
      positionals: [task], options,
      run: (input, ctx) => emit(async () => {
        const target = await scope(input.positionals.task, input.options.context, ctx);
        return ctx.threadId ? service.listForThread(target.taskId, ctx.threadId) : service.handlers.listTaskArtifacts(target);
      }),
    }),
    "artifact show": cliCommand({
      summary: "Read retained text/coordinates and current source availability; fetch the image with attachment get",
      positionals: [task, artifact], options,
      run: (input, ctx) => emit(async () => {
        const target = await scope(input.positionals.task, input.options.context, ctx);
        if (ctx.threadId) {
          const result = await service.readForThread(input.positionals.artifact, ctx.threadId);
          if (result.view.artifact.taskId !== target.taskId) throw new Error("Artifact belongs to another task");
          return result.view;
        }
        return service.handlers.getTaskArtifact(taskArtifactRpcContract.getTaskArtifact.input.parse({ ...target, artifactId: input.positionals.artifact }));
      }),
    }),
    "artifact image": cliCommand({
      summary: "Inspect an existing task screenshot's hash, decoded dimensions and coordinate frame",
      positionals: [task, { name: "attachment", required: true, description: "Existing task image attachment ID" }], options,
      run: (input, ctx) => emit(async () => service.handlers.inspectTaskArtifactImage(taskArtifactRpcContract.inspectTaskArtifactImage.input.parse({
        ...await scope(input.positionals.task, input.options.context, ctx), attachmentId: input.positionals.attachment,
      }))),
    }),
    "artifact create": cliCommand({
      summary: "Explicitly retain a bounded source quote/decision with an optional verified screenshot annotation; never dispatches",
      positionals: [task], options: { ...options, data: { type: "string", required: true, description: "Typed JSON: artifactId UUID, source {threadId,eventSeq,quote}, decision, annotation or null, retentionConfirmed:true" } },
      run: (input, ctx) => emit(async () => service.handlers.createTaskArtifact(taskArtifactRpcContract.createTaskArtifact.input.parse({
        ...JSON.parse(input.options.data), ...await scope(input.positionals.task, input.options.context, ctx),
      }))),
    }),
    "artifact remove": cliCommand({
      summary: "Explicitly remove one retained artifact; the existing task attachment is not deleted",
      positionals: [task, artifact], options,
      run: (input, ctx) => emit(async () => {
        const target = await scope(input.positionals.task, input.options.context, ctx);
        if (ctx.threadId) {
          const retained = await service.authorizeForThread(input.positionals.artifact, ctx.threadId);
          if (retained.taskId !== target.taskId) throw new Error("Artifact belongs to another task");
        }
        return service.handlers.deleteTaskArtifact(taskArtifactRpcContract.deleteTaskArtifact.input.parse({ ...target, artifactId: input.positionals.artifact }));
      }),
    }),
  };
}
