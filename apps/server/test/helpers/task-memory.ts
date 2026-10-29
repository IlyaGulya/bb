import { getProject, getThread } from "@bb/db";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from "../../../../plugins/tasks/api/index.js";
import memoryPlugin, { memoryRpcContract } from "../../../../plugins/memory/server.js";
import type { MemorySelection } from "../../../../plugins/memory/lineage.js";
import type { TestAppHarness } from "./test-app.js";

export async function createTaskMemoryFixture(
  harness: TestAppHarness,
  projectId: string,
) {
  const tasksHost = createFakePluginHost({ pluginId: "tasks" });
  const tasks = createStore(tasksHost.bb);
  registerTasksApi(tasksHost.bb, tasks);
  const project = tasks.tasks.createProject({
    name: "Owned task memory fixture",
    prefix: "MEMORY",
    color: "blue",
    linkedBbProjectId: projectId,
  });
  const task = tasks.tasks.createTask({
    projectId: project.id,
    title: "Retain the SQLite original",
    description: "Owned bounded evidence: use the existing SQLite store.",
  });
  const memory = createFakePluginHost({
    pluginId: "memory",
    agentSkillIds: ["memory"],
    sdk: {
      projects: {
        get: async ({ projectId: selected }) => {
          const result = getProject(harness.db, selected);
          if (!result) throw new Error("Core project not found");
          return result;
        },
        list: async () => {
          const result = getProject(harness.db, projectId);
          if (!result) throw new Error("Core project not found");
          return [result];
        },
      },
      threads: {
        get: async ({ threadId }) => {
          const result = getThread(harness.db, threadId);
          if (!result) throw new Error("Core thread not found");
          return result;
        },
      },
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
      quote: "Owned bounded evidence: use the existing SQLite store.",
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
      return memoryRpcContract.setTaskBindings.output.parse(
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
