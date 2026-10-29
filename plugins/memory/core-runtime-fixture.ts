import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from "../tasks/api/index.js";
import memoryPlugin, { memoryRpcContract } from "./server.js";
import type { MemorySelection } from "./lineage.js";

type FixtureSdk = NonNullable<NonNullable<Parameters<typeof createFakePluginHost>[0]>["sdk"]>;
type FixtureSource = {
  bb: ReturnType<typeof createFakePluginHost>["bb"];
  harness: ReturnType<typeof createFakePluginHost>["harness"];
  store: ReturnType<typeof createStore>;
  project: ReturnType<ReturnType<typeof createStore>["tasks"]["createProject"]>;
  task: ReturnType<ReturnType<typeof createStore>["tasks"]["createTask"]>;
};

export async function createTaskMemoryFixture(projectId: string, sdk: FixtureSdk, source?: FixtureSource) {
  const tasksHost = source ?? createFakePluginHost({ pluginId: "tasks" });
  const tasks = source?.store ?? createStore(tasksHost.bb);
  registerTasksApi(tasksHost.bb, tasks);
  const project = source?.project ?? tasks.tasks.createProject({
    name: "Owned task memory fixture",
    prefix: "MEMORY",
    color: "blue",
    linkedBbProjectId: projectId,
  });
  const task = source?.task ?? tasks.tasks.createTask({
    projectId: project.id,
    title: "Retain the SQLite original",
    description: "Owned bounded evidence: use the existing SQLite store.",
  });
  const memory = createFakePluginHost({
    pluginId: "memory",
    agentSkillIds: ["memory"],
    sdk: {
      ...sdk,
      plugins: {
        callRpc: async (args) => {
          if (args.pluginId !== "tasks") throw new Error("Unexpected source plugin");
          return args.outputSchema.parse(
            await tasksHost.harness.behavior.callRpc(args.method, args.input),
          );
        },
      },
    },
  });
  try {
    await memoryPlugin(memory.bb);
  } catch (error) {
    await Promise.all([memory.harness.lifecycle.dispose(), tasksHost.harness.lifecycle.dispose()]);
    throw error;
  }
  const selection: MemorySelection = {
    projectId,
    task: { taskId: task.id, context: "owned-research" },
    executionContextId: null,
  };
  const draft = (name: string, summary: string) => ({
    name,
    summary,
    details: "Retain the source revision and use the existing SQLite store.",
    classification: "decision" as const,
    source: {
      kind: "task" as const,
      commentId: null,
      revision: tasks.tasks.getTask(task.id)!.updatedAt,
      observedAt: Date.now(),
      quote: task.description.slice(0, 600),
    },
    reason: "Inspected owned synthetic evidence",
    replaces: null,
  });
  return {
    memory,
    async remember(name: string, summary: string) {
      return memoryRpcContract.createTaskMemory.output.parse(
        await memory.harness.behavior.callRpc("createTaskMemory", {
          ...selection,
          draft: draft(name, summary),
        }),
      ).memory;
    },
    async bind(threadId: string) {
      memoryRpcContract.setTaskBindings.output.parse(
        await memory.harness.behavior.callRpc("setTaskBindings", {
          projectId,
          threadId,
          expectedVersion: 0,
          tasks: [selection.task],
        }),
      );
    },
    async dispose() {
      await Promise.all([memory.harness.lifecycle.dispose(), tasksHost.harness.lifecycle.dispose()]);
    },
  };
}
