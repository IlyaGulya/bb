import { describe, expect, it } from "vitest";
import { getThread, listEvents, saveModelConnection } from "@bb/db";
import { modelConnectionSchema } from "@bb/domain";
import { createThreadRequestSchema } from "@bb/server-contract";
import { createThreadFromRequest } from "../../src/services/threads/thread-create.js";
import { advanceThreadProvisioning } from "../../src/services/threads/thread-provisioning.js";
import { listQueuedThreadCommands } from "../helpers/commands.js";
import { seedEnvironment, seedHostSession, seedProjectWithSource } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("native execution-context preparation", () => {
  it("reaches an owned ready workspace without an origin, queued model turn or provider session", async () => {
    await withTestHarness(async harness => {
      const { host } = seedHostSession(harness.deps, { id: "preparation-host" });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id, path: "/tmp/preparation-project" });
      const environment = seedEnvironment(harness.deps, { hostId: host.id, projectId: project.id, path: "/tmp/preparation-owned-workspace" });
      const request = createThreadRequestSchema.parse({
        projectId: project.id, providerId: "codex", origin: "sdk", preparationOnly: true,
        input: [], title: "Native workflow preparation", environment: { type: "reuse", environmentId: environment.id },
      });
      const context = await createThreadFromRequest(harness.deps, request);
      await advanceThreadProvisioning(harness.deps, { threadId: context.id });
      const prepared = getThread(harness.db, context.id);
      expect(prepared?.status).toBe("idle");
      expect(prepared?.environmentId).toBe(environment.id);
      expect(prepared?.sourceThreadId).toBeNull();
      expect(listEvents(harness.db, { threadId: context.id }).filter(event => event.type === "client/turn/requested")).toEqual([]);
      expect(listQueuedThreadCommands(harness, "thread.start", context.id)).toEqual([]);
    });
  });
  it("does not bypass authoritative account revocation during preparation", async () => {
    await withTestHarness(async harness => {
      const { host } = seedHostSession(harness.deps, { id: "revoked-preparation-host" });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, { hostId: host.id, projectId: project.id });
      const account = saveModelConnection(harness.db, modelConnectionSchema.parse({ id: "revoked-account", name: "Revoked personal account", provider: "codex", hostId: host.id, revoked: true, createdAt: 1, updatedAt: 1 }));
      await expect(createThreadFromRequest(harness.deps, {
        projectId: project.id, providerId: "codex", modelConnectionId: account.id, origin: "sdk", startedOnBehalfOf: null,
        preparationOnly: true, input: [], title: "Rejected native preparation", environment: { type: "reuse", environmentId: environment.id },
      })).rejects.toMatchObject({ status: 409 });
    });
  });
  it.each([
    { input: [{ type: "text", text: "Unexpected implementation turn" }] },
    { sendAt: 10 },
    { sourceThreadId: "another-session" },
    { parentThreadId: "another-session" },
    { title: undefined },
  ])("refuses ambiguous preparation requests rather than executing their hidden turn: %j", patch => {
    const parsed = createThreadRequestSchema.safeParse({ projectId: "project", providerId: "codex", origin: "sdk", preparationOnly: true, input: [], title: "Prepare workspace", environment: { type: "reuse", environmentId: "owned-environment" }, ...patch });
    expect(parsed.success).toBe(false);
  });
});
