import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { sharedWorkerProjects } from "../../vitest.shared";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      "tippy.js": "tippy.js/dist/tippy.esm.js",
    },
  },
  test: {
    silent: "passed-only",
    projects: sharedWorkerProjects({
      pkgDir: fileURLToPath(new URL(".", import.meta.url)),
      name: "bb-plugin-tasks",
      include: ["**/*.test.{ts,tsx,mjs}"],
      exclude: ["node_modules/**"],
    }),
    testTimeout: 20_000,
    setupFiles: ["./vitest.setup.ts"],
    server: {
      deps: {
        inline: ["@tiptap/extension-bubble-menu"],
      },
    },
  },
});
