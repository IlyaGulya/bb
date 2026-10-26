import os from "node:os";
import { executionContextSnapshotSchema } from "@bb/domain";
import {
  experimental_defineHostEntry,
  experimental_nativeRootsHostContract,
} from "@get-bb/plugin-sdk/host";
import { resolveClaudeNativeRoots } from "./native-roots.js";

export { experimental_providerBridge } from "./bridge/bridge.js";

export default experimental_defineHostEntry({
  contract: experimental_nativeRootsHostContract,
  handlers: {
    resolveNativeRoots: (input) =>
      resolveClaudeNativeRoots({
        cwd: input.cwd,
        homeDir: os.homedir(),
        env: process.env,
        executionContext: executionContextSnapshotSchema.optional().parse(
          "executionContext" in input ? input.executionContext : undefined,
        ),
      }),
  },
});
