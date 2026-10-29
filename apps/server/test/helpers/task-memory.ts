import { fileURLToPath } from "node:url";
import { getProject, getThread } from "@bb/db";
import type { createFakePluginHost, FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { vi } from "vitest";
import { z } from "zod";
import type { TestAppHarness } from "./test-app.js";

type FixtureSdk = NonNullable<NonNullable<Parameters<typeof createFakePluginHost>[0]>["sdk"]>;
const isFunction = (value: unknown) => typeof value === "function";
const memoryDriverSchema = z.object({
  harness: z.object({
    runCli: z.custom<FakePluginHost["harness"]["runCli"]>(isFunction),
    behavior: z.object({
      resolveAgentConfiguration: z.custom<FakePluginHost["harness"]["behavior"]["resolveAgentConfiguration"]>(isFunction),
    }),
    registrations: z.object({
      instructionProvider: z.custom<FakePluginHost["harness"]["registrations"]["instructionProvider"]>((value) => value === null || isFunction(value)),
    }),
  }),
});
const fixtureSchema = z.object({
  memory: z.custom<z.infer<typeof memoryDriverSchema>>((value) => memoryDriverSchema.safeParse(value).success),
  remember: z.custom<(name: string, summary: string) => Promise<unknown>>(isFunction),
  bind: z.custom<(threadId: string) => Promise<unknown>>(isFunction),
  dispose: z.custom<() => Promise<unknown>>(isFunction),
});
const fixtureModuleSchema = z.object({
  createTaskMemoryFixture: z.custom<(projectId: string, sdk: FixtureSdk) => Promise<unknown>>(isFunction),
});

export async function createTaskMemoryFixture(harness: TestAppHarness, projectId: string) {
  const fixturePath = fileURLToPath(new URL("../../../../plugins/memory/core-runtime-fixture.ts", import.meta.url));
  const module = fixtureModuleSchema.parse(await vi.importActual<unknown>(fixturePath));
  const sdk: FixtureSdk = {
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
  };
  const fixture = fixtureSchema.parse(await module.createTaskMemoryFixture(projectId, sdk));
  return {
    memory: fixture.memory,
    async remember(name: string, summary: string) {
      return z.object({ summary: z.string() }).parse(await fixture.remember(name, summary));
    },
    async bind(threadId: string) {
      z.void().parse(await fixture.bind(threadId));
    },
    async dispose() {
      z.void().parse(await fixture.dispose());
    },
  };
}
