import { defineWorkspaceTestConfig, sharedWorkerProjects } from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  test: {
    testTimeout: 120000,
    hookTimeout: 120000,
    silent: "passed-only",
    projects: sharedWorkerProjects({
      pkgDir: __dirname,
      name: "@bb/integration-tests:capture-process",
      include: ["private-capture-process/**/*.test.ts"],
    }),
  },
});
