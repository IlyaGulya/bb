import path from "path";
import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { forkablePluginPaths } from "./vite-forkable-plugin-paths.js";
import { sharedUiEnvSeam } from "./vite-shared-ui-seam.js";

export default defineWorkspaceTestConfig({
  plugins: [
    forkablePluginPaths(path.resolve(__dirname, "./src")),
    sharedUiEnvSeam(),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    silent: "passed-only",
    environment: "node",
    setupFiles: ["src/test/setup.ts"],
    testTimeout: 15_000,
    projects: [...sharedWorkerProjects({
      pkgDir: __dirname,
      aliases: { "@": path.resolve(__dirname, "./src") },
      name: "@bb/app",
      include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
      exclude: [
        "dist/**",
        "node_modules/**",
        "src/lib/product-analytics-consumer.dom.test.tsx",
        ...(process.env.BB_SIDEBAR_BENCH === "1"
          ? []
          : ["src/components/sidebar/sidebar.bench.test.tsx"]),
      ],
    }), ...sharedWorkerProjects({
      pkgDir: __dirname,
      aliases: { "@": path.resolve(__dirname, "./src") },
      name: "@bb/app:analytics-consumer",
      include: ["src/lib/product-analytics-consumer.dom.test.tsx"],
    }).map((project) => {
      if (typeof project !== "object" || project === null || !("test" in project) || typeof project.test !== "object" || project.test === null) throw new Error("Analytics fixture requires an inline test project");
      return { ...project, test: { ...project.test, globalSetup: [path.resolve(__dirname, "../server/test/helpers/product-analytics-dom-setup.ts")] } };
    })],
  },
});
