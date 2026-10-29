import { makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { z } from "zod";
import { createArtifactFixture } from "../tasks/artifacts/test-fixtures.js";
import { tasksRpcContract } from "../tasks/shared/contract.js";
import { memoryRpcContract } from "./server.js";
import type { MemorySelection } from "./lineage.js";
import { taskArtifactRpcContract } from "../tasks/shared/artifacts.js";
import { createTaskMemoryFixture } from "./core-runtime-fixture.js";

type Memory = z.output<typeof memoryRpcContract.createTaskMemory.output>["memory"];
type Source = z.output<typeof memoryRpcContract.createTaskMemory.input>["draft"]["source"];

export async function createArtifactMemoryFixture() {
  const native = await createArtifactFixture();
  const projectId = native.state.projectId;
  const threadId = "thr_memory_artifact_reader";
  const task = { taskId: native.task.id, context: "research" };
  const selection: MemorySelection = { projectId, task, executionContextId: native.scope.executionContextId };
  const other: MemorySelection = { ...selection, executionContextId: "context-work" };
  const unbound: MemorySelection = { ...selection, executionContextId: null };
  const reader = { executionContextId: selection.executionContextId };
  const core = await createTaskMemoryFixture(projectId, {
      projects: {
        get: async ({ projectId: selected }) => {
          if (selected !== projectId) throw new Error("Core project is unavailable");
          return { id: projectId, name: "Owned artifact memory project" };
        },
        list: async () => [{ id: projectId, name: "Owned artifact memory project" }],
      },
      threads: { get: async ({ threadId: selected }) => makeThreadResponse({ id: selected, projectId }) },
      experimental_executionContexts: {
        get: native.bb.sdk.experimental_executionContexts.get,
        list: native.bb.sdk.experimental_executionContexts.list,
        getThreadBinding: async ({ threadId: selected }) => reader.executionContextId === null ? null : {
          threadId: selected,
          executionContext: await native.bb.sdk.experimental_executionContexts.get({ id: reader.executionContextId }),
          modelConnection: null,
          createdAt: 0,
        },
      },
  }, native);
  const { memory } = core;
  const dispose = core.dispose;
  async function call<T>(method: string, input: unknown, output: z.ZodType<T>): Promise<T> {
    return output.parse(await memory.harness.behavior.callRpc(method, input));
  }
  try {
    await call("setTaskBindings", { projectId, threadId, expectedVersion: 0, tasks: [task] }, memoryRpcContract.setTaskBindings.output);
  } catch (error) {
    await dispose();
    throw error;
  }
  const read = async (name: string, selected = selection) =>
    (await call("getMemory", { ...selected, name }, memoryRpcContract.getMemory.output)).memory;
  const history = async (name: string, selected = selection) =>
    (await call("memoryHistory", { ...selected, name }, memoryRpcContract.memoryHistory.output)).history;
  const inspect = (artifactId: string) => call("readMemoryArtifact", { ...selection, artifactId }, memoryRpcContract.readMemoryArtifact.output);
  const nativeSource = (): Source => ({
    kind: "task", commentId: null, revision: native.store.tasks.getTask(native.task.id)!.updatedAt, observedAt: Date.now(), quote: "",
  });
  const commentSource = async (): Promise<Source> => {
    const { comment } = tasksRpcContract.createComment.output.parse(await native.harness.behavior.callRpc("createComment", {
      taskId: native.task.id, body: "A native task comment is not permission to publish retained thread evidence.", notify: false,
    }));
    return { kind: "comment", commentId: comment.id, revision: comment.createdAt, observedAt: Date.now(), quote: "" };
  };
  const retain = async (text = native.state.sourceText, artifactId?: string, eventSeq = 7) => {
    native.state.sourceText = text;
    const input = native.input(false);
    return taskArtifactRpcContract.createTaskArtifact.output.parse(await native.harness.behavior.callRpc("createTaskArtifact", {
      ...input, artifactId: artifactId ?? input.artifactId, source: { ...input.source, eventSeq, quote: text },
    }));
  };
  const remember = async (name: string, summary: string, source: Source, replaces: { id: string; version: number } | null = null, details = summary) =>
    (await call("createTaskMemory", { ...selection, draft: {
      name, summary, details, classification: "decision", source, reason: "Inspect bounded native evidence without changing its visibility", replaces,
    } }, memoryRpcContract.createTaskMemory.output)).memory;
  const propose = (record: Memory, source: Source, summary = record.summary, state: "current" | "obsolete" = "current") =>
    call("proposeReflection", { ...selection, changes: [{
      id: record.id, expectedVersion: record.version, summary, details: record.details,
      classification: record.lineage!.classification, state, source, reason: "Review provenance without declassifying retained evidence",
    }] }, memoryRpcContract.proposeReflection.output);
  const decide = (id: string) => call("decideReflection", { ...selection, id, decision: "apply" }, memoryRpcContract.decideReflection.output);
  const injected = async (selected: MemorySelection) => {
    reader.executionContextId = selected.executionContextId;
    const configured = await memory.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
      thread: { id: threadId }, project: { id: projectId },
    }));
    return configured.instructions ?? "";
  };
  return { native, memory, selection, other, unbound, threadId, call, read, history, inspect, nativeSource, commentSource, retain, remember, propose, decide, injected, dispose };
}
