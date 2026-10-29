import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import manifest from "./package.json" with { type: "json" };

import { createStore, registerTasksApi } from "./api";
import { registerAttachments } from "./attachments";
import { registerTasksCli } from "./cli";
import { registerDelegation, taskExecutionEffects } from "./delegate";
import { registerLifecycle } from "./lifecycle";
import { registerMentions } from "./mentions";
import { registerJiraSync } from "./jira";
import { registerInbox } from "./inbox/index.js";
import { repositoryHandlers } from "./repositories";
import { repositoryRpcContract } from "./shared/repositories";
import { registerTaskWorkflows } from "./workflow/index.js";
import { registerRouting } from "./routing/index.js";

import { registerTaskArtifacts } from "./artifacts/index.js";
const TASKS_PLUGIN_NAME = "Tasks";
const TASKS_PLUGIN_VERSION = manifest.version;

const tasksRpcContract = defineRpcContract({
  ping: {
    input: z.null(),
    output: z.object({ ok: z.literal(true), version: z.string() }),
  },
});

function statusPayload() {
  return { name: TASKS_PLUGIN_NAME, version: TASKS_PLUGIN_VERSION };
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info(`${TASKS_PLUGIN_NAME} ${TASKS_PLUGIN_VERSION} loaded`);
  for (const action of ["video.open", "video.play", "video.seek", "video.close", "video.error"]) {
    bb.experimental_productAnalytics.declareAction({ action, surfaces: ["web", "compact", "mobile", "desktop"], completionSource: "client" });
  }

  const store = createStore(bb);
  registerTasksApi(bb, store);
  registerAttachments(bb, store.tasks);
  registerTaskArtifacts(bb, store);
  const jiraHandlers = registerJiraSync(bb, store);
  const inboxHandlers = registerInbox(bb, store);
  const repositories = repositoryHandlers(
    bb,
    store,
    taskExecutionEffects(bb, store),
  );
  bb.rpc.register(repositoryRpcContract, repositories);
  const workflows = registerTaskWorkflows(bb, store);
  const routing = registerRouting(bb, store);
  registerTasksCli(
    bb,
    store,
    statusPayload(),
    jiraHandlers,
    inboxHandlers,
    repositories,
    workflows,
    routing,
  );
  registerDelegation(bb, store);
  registerMentions(bb, store);
  await registerLifecycle(bb, store);

  bb.rpc.register(tasksRpcContract, {
    ping(): { ok: true; version: string } {
      return { ok: true, version: TASKS_PLUGIN_VERSION };
    },
  });
}
