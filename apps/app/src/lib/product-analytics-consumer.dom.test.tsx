// @vitest-environment jsdom

import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { PRODUCT_ANALYTICS_HEADERS as headers } from "@bb/server-contract";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginContext } from "@/components/plugin/plugin-context";
import { useUpdateProject } from "@/hooks/mutations/project-mutations";
import { useRpc } from "./plugin-sdk-hooks";
import { createAppQueryClient } from "./query-client";
import { productAnalyticsInput, setProductAnalyticsView } from "./product-analytics";
import { withBrowserAnalyticsConsumer } from "@/test/product-analytics-fixture";

const contract = defineRpcContract({ rename: { input: z.object({ projectId: z.string(), name: z.string() }), output: z.object({ name: z.string() }) } });
const pluginSource = `import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
export default function plugin(bb) {
  bb.rpc.register(defineRpcContract({ rename: { input: z.object({ projectId: z.string(), name: z.string() }), output: z.object({ name: z.string() }) } }), { rename: async ({ projectId, name }) => { const project = await bb.sdk.projects.update({ projectId, name }); return { name: project.name }; } });
}`;

function RpcConsumer({ projectId }: { projectId: string }) {
  const rpc = useRpc<typeof contract>();
  const [name, setName] = useState("Before action");
  return <><button onClickCapture={(event) => productAnalyticsInput(event.nativeEvent)} onClick={() => { void rpc.call("rename", { projectId, name: "Changed through shared RPC" }).then((result) => setName(result.name)); }}>Rename through plugin</button><output>{name}</output></>;
}

function MutationConsumer({ projectId }: { projectId: string }) {
  const mutation = useUpdateProject({ showErrorToast: false });
  return <><button onClickCapture={(event) => productAnalyticsInput(event.nativeEvent)} onClick={() => mutation.mutate({ id: projectId, name: "Changed through mutation" })}>Rename through mutation</button><output>{mutation.data?.name ?? "Before action"}</output></>;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); setProductAnalyticsView({ kind: "instance" }, "web"); });

describe("analytics actual shared plugin useRpc", () => {
  it("carries captured browser provenance through the shared hook and scopes the real Core action to Work", async () => {
    await withBrowserAnalyticsConsumer({ pluginSource }, async ({ forward, report, work, personal, pluginId }) => {
      if (pluginId === null) throw new Error("Owned RPC plugin was not installed");
      const requests: Request[] = [];
      vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? new Request(input, init) : new Request(new URL(String(input), "http://localhost"), init);
        requests.push(request.clone());
        return forward(request);
      });
      setProductAnalyticsView({ kind: "project", projectId: work.id }, "web");
      render(<PluginContext.Provider value={pluginId}><RpcConsumer projectId={work.id} /></PluginContext.Provider>);
      fireEvent.click(screen.getByRole("button", { name: "Rename through plugin" }));
      await waitFor(() => expect(screen.getByText("Changed through shared RPC")).toBeTruthy());
      const request = requests.find((value) => value.url.endsWith(`/rpc/rename`));
      expect(request?.headers.get(headers.project)).toBe(work.id);
      expect(request?.headers.get(headers.intent)).toBe("use");
      expect(request?.headers.get(headers.actor)).toBe("unknown");
      expect(request?.headers.get(headers.surface)).toBe("web");
      expect(request?.headers.get(headers.operation)).toMatch(/^[0-9a-f-]{36}$/);
      const result = await report(work.id);
      expect(result.rows.find((row) => row.featureId === `plugin.${pluginId}` && row.action === "rpc.rename")).toMatchObject({ attempts: 1, successes: 1, human: 0, unknown: 1 });
      expect(result.rows.find((row) => row.featureId === "core.projects" && row.action === "update")).toMatchObject({ attempts: 1, successes: 1, human: 0, unknown: 1 });
      for (const projectId of [personal.id, undefined]) expect((await report(projectId)).rows.find((row) => row.featureId === "core.projects" && row.action === "update")).toMatchObject({ attempts: 0, successes: 0 });
    });
  });
});

describe("analytics TanStack asynchronous action provenance", () => {
  it("retains click scope and one operation through asynchronous onMutate and a lost-response retry", async () => {
    await withBrowserAnalyticsConsumer({}, async ({ forward, report, work, personal }) => {
      const requests: Request[] = [];
      let loseFirstResponse = true;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? new Request(input, init) : new Request(new URL(String(input), "http://localhost"), init);
        const isUpdate = request.method === "PATCH" && new URL(request.url).pathname === `/api/v1/projects/${work.id}`;
        if (isUpdate) requests.push(request.clone());
        const result = await forward(request);
        if (isUpdate && loseFirstResponse) { loseFirstResponse = false; throw new TypeError("Failed to fetch"); }
        return result;
      });
      const queryClient = createAppQueryClient({ showMutationErrorToasts: false, defaultOptions: { mutations: { retry: 1, retryDelay: 0, onMutate: async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); } } } });
      try {
        setProductAnalyticsView({ kind: "project", projectId: work.id }, "web");
        render(<QueryClientProvider client={queryClient}><MutationConsumer projectId={work.id} /></QueryClientProvider>);
        fireEvent.click(screen.getByRole("button", { name: "Rename through mutation" }));
        setProductAnalyticsView({ kind: "project", projectId: personal.id }, "web");
        await waitFor(() => expect(screen.getByText("Changed through mutation")).toBeTruthy());
        expect(requests.map((request) => request.headers.get(headers.project))).toEqual([work.id, work.id]);
        expect(requests.map((request) => request.headers.get(headers.intent))).toEqual(["use", "use"]);
        expect(requests[0]?.headers.get(headers.operation)).toMatch(/^[0-9a-f-]{36}$/);
        expect(requests[1]?.headers.get(headers.operation)).toBe(requests[0]?.headers.get(headers.operation));
        expect((await report(work.id)).rows.find((row) => row.featureId === "core.projects" && row.action === "update")).toMatchObject({ attempts: 1, successes: 1, human: 0, unknown: 1 });
        expect((await report(personal.id)).rows.find((row) => row.featureId === "core.projects" && row.action === "update")).toMatchObject({ attempts: 0, successes: 0 });
      } finally {
        queryClient.clear();
      }
    });
  });
});
