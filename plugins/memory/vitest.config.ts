import { defineWorkspaceTestConfig, sharedWorkerProjects } from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  resolve: { tsconfigPaths: true },
  test: {
    silent: "passed-only",
    projects: sharedWorkerProjects({
      pkgDir: import.meta.dirname,
      name: "bb-plugin-memory",
      include: ["**/*.test.ts", "**/*.test.tsx"],
    }),
  },
});
