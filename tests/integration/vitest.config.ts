import { defineWorkspaceTestConfig, sharedWorkerProjects } from "../../vitest.shared.js";

const parsedTimeoutScale = Number(process.env.BB_TEST_TIMEOUT_SCALE ?? 1);
const timeoutScale =
  Number.isFinite(parsedTimeoutScale) && parsedTimeoutScale > 0
    ? parsedTimeoutScale
    : 1;

const startupShutdownProjects = sharedWorkerProjects({
  pkgDir: __dirname,
  name: "@bb/integration-tests:startup-shutdown",
  include: ["fake/thread-startup-shutdown.test.ts"],
}).map((project) => typeof project !== "object" || project === null || !("test" in project) ? project : {
  ...project,
  test: {
    ...project.test,
    globalSetup: ["../../apps/server/test/setup/migrated-db-template.ts"],
    setupFiles: [
      "../../apps/server/test/setup/stored-event-decode-freeze.ts",
      "../../apps/server/test/setup/warm-test-harness.ts",
    ],
  },
});

export default defineWorkspaceTestConfig({
  test: {
    hookTimeout: Math.ceil(60_000 * timeoutScale),
    env: {
      BB_DATA_DIR: "/tmp/bb-integration-test",
      BB_SERVER_PORT: "49161",
      BB_SERVER_URL: "http://127.0.0.1:49161",
      BB_HOST_DAEMON_PORT: "49162",
      SCRIPTED_ECHO_OPTIONS: JSON.stringify({ uniqueProviderThreadIds: true }),
    },
    silent: "passed-only",
    testTimeout: Math.ceil(60_000 * timeoutScale),
    projects: [
      {
        extends: true,
        test: {
          name: "@bb/integration-tests",
          fileParallelism: true,
          isolate: false,
          globalSetup: ["./global-setup.ts"],
          include: ["fake/**/*.test.ts"],
          exclude: ["fake/thread-startup-shutdown.test.ts", "fake/smoke/product-analytics-mcp-consumer.test.ts", "fake/smoke/product-analytics-file-conflict.test.ts"],
        },
      },
      ...startupShutdownProjects,
      {
        extends: true,
        test: {
          name: "@bb/integration-tests:native-roots-golden",
          include: ["native-roots-golden/**/*.test.ts"],
        },
      },
      ...sharedWorkerProjects({
        pkgDir: __dirname,
        name: "@bb/integration-tests:analytics",
        include: ["fake/smoke/product-analytics-mcp-consumer.test.ts", "fake/smoke/product-analytics-file-conflict.test.ts"],
      }).map((project) => {
        if (typeof project !== "object" || project === null || !("test" in project) || typeof project.test !== "object" || project.test === null) throw new Error("Analytics fixtures require an inline test project");
        return { ...project, test: { ...project.test, isolate: true, globalSetup: ["./global-setup.ts"] } };
      }),
    ],
  },
});
