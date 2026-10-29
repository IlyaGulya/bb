import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createNodeBbSdk, experimental_createProductAnalyticsFetch, type ExperimentalProductAnalyticsContext } from "@bb/sdk/node";
import type { ProductAnalyticsEvent, ProductAnalyticsReportQuery } from "@bb/server-contract";
import { getPrivateProductAnalytics } from "../../src/services/system/product-analytics.js";
import { seedEnvironment, seedHostSession, seedProjectWithSource, seedThread, seedThreadRuntimeState } from "./seed.js";
import { createTestAppHarness, type TestAppHarness } from "./test-app.js";

export function consumerSdk(harness: TestAppHarness, context: ExperimentalProductAnalyticsContext) {
  return createNodeBbSdk({
    baseUrl: "http://localhost",
    fetch: experimental_createProductAnalyticsFetch(context, (input, init) => harness.app.request(new Request(input, init))),
  });
}

export async function createAnalyticsConsumer() {
  const harness = await createTestAppHarness({ productAnalyticsMode: "production", isDevelopment: false });
  const collector = getPrivateProductAnalytics(harness.db);
  try {
    const { host, session } = seedHostSession(harness.deps);
    const { project: work } = seedProjectWithSource(harness.deps, { hostId: host.id, name: "Work", path: "/owned/work" });
    const { project: personal } = seedProjectWithSource(harness.deps, { hostId: host.id, name: "Personal", path: "/owned/personal" });
    const environment = seedEnvironment(harness.deps, { hostId: host.id, projectId: work.id, status: "ready" });
    const thread = seedThread(harness.deps, { projectId: work.id, environmentId: environment.id, status: "starting" });
    seedThreadRuntimeState(harness.deps, { threadId: thread.id, environmentId: environment.id, providerThreadId: "owned-provider-thread" });
    return { harness, collector, host, session, work, personal, environment, thread, async close() { collector.stop(); await harness.cleanup(); } };
  } catch (error) {
    collector.stop();
    await harness.cleanup();
    throw error;
  }
}

export async function withAnalyticsConsumer<T>(run: (fixture: {
  harness: TestAppHarness;
  collector: ReturnType<typeof getPrivateProductAnalytics>;
  host: ReturnType<typeof seedHostSession>["host"];
  session: ReturnType<typeof seedHostSession>["session"];
  work: ReturnType<typeof seedProjectWithSource>["project"];
  personal: ReturnType<typeof seedProjectWithSource>["project"];
  environment: ReturnType<typeof seedEnvironment>;
  thread: ReturnType<typeof seedThread>;
}) => Promise<T>): Promise<T> {
  const fixture = await createAnalyticsConsumer();
  try {
    return await run(fixture);
  } finally {
    await fixture.close();
  }
}

export function consumerReport(collector: ReturnType<typeof getPrivateProductAnalytics>, projectId?: string, mode: ProductAnalyticsReportQuery["mode"] = "production") {
  collector.flush();
  return collector.report({ days: 7, mode, ...(projectId === undefined ? {} : { projectId }) });
}

export function clientCompletion(action: string, operationId: string, projectId: string): ProductAnalyticsEvent {
  return { operationId, featureId: "plugin.analytics-consumer", action, version: 1, scope: { kind: "project", projectId }, mode: "production", actorKind: "human", actorSessionId: null, surface: "web", stage: "completed", outcome: "succeeded", errorCode: "none", durationMs: 12, timestamp: Date.now() };
}

export async function installConsumerPlugin(harness: TestAppHarness, serverSource: string) {
  const root = join(harness.config.dataDir, "owned-plugin");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "bb-plugin-analytics-consumer", version: "0.1.0", type: "module", bb: { name: "Owned analytics consumer", description: "Consumer regression fixture", branding: { icon: "Zap" }, server: "./server.ts" } }));
  await writeFile(join(root, "server.ts"), serverSource);
  const installed = await harness.pluginService.installPath(root);
  if (installed.status !== "running") throw new Error(`Owned plugin did not load: ${installed.statusDetail}`);
  return { root, pluginId: installed.id };
}
