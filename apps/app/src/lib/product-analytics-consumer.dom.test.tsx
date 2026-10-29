// @vitest-environment jsdom

import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Provider, createStore, useAtomValue, useStore } from "jotai";
import { MemoryRouter } from "react-router-dom";
import type { PluginThreadActionTarget } from "@get-bb/plugin-sdk/app";
import type { ExperimentalAnalyticsQueueStore } from "@bb/sdk/browser";
import { notificationsThreadAction, type ThreadNotificationsData } from "../../../../plugins/push-notifications/notificationsAction";
import { pushNotificationsRpcContract } from "../../../../plugins/push-notifications/contract";
import { instrumentPluginLocalRegistration } from "./plugin-local-analytics";
import { bindThreadAction } from "./thread-actions/thread-action-registry";
import { BrowserAnalyticsStore } from "./product-analytics-store";
import { productAnalyticsOutbox } from "./product-analytics";
import { closePanesForThreadsAtom, splitLayoutAtom } from "./split-layout/atoms";
import { splitPane, setFocus, listPanes } from "./split-layout/ops";
import type { SplitLayout } from "./split-layout/types";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { PRODUCT_ANALYTICS_HEADERS as headers } from "@bb/server-contract";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginContext } from "@/components/plugin/plugin-context";
import { useUpdateProject } from "@/hooks/mutations/project-mutations";
import { useRpc, useSdk, useBbNavigate } from "./plugin-sdk-hooks";
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

function bindConsumerQueue(queue: ExperimentalAnalyticsQueueStore) {
  const admissions: Promise<boolean>[] = [];
  const spies = [
    vi.spyOn(BrowserAnalyticsStore.prototype, "enqueue").mockImplementation((entry) => { const admitted = queue.enqueue(entry); admissions.push(admitted); return admitted; }),
    vi.spyOn(BrowserAnalyticsStore.prototype, "batch").mockImplementation(() => queue.batch()),
    vi.spyOn(BrowserAnalyticsStore.prototype, "settle").mockImplementation((entries) => queue.settle(entries)),
    vi.spyOn(BrowserAnalyticsStore.prototype, "health").mockImplementation(() => queue.health()),
  ];
  return async () => {
    try {
      await Promise.all(admissions);
      await productAnalyticsOutbox.flush();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  };
}

function NotificationsConsumer({ target, pluginId }: { target: PluginThreadActionTarget; pluginId: string }) {
  const rpc = useRpc<typeof pushNotificationsRpcContract>();
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const [stored, setStored] = useState("inherit");
  const data: ThreadNotificationsData = {
    levels: new Map(),
    defaults: { defaultLevel: "all", childLevel: "input-only" },
    async setLevel(threadId, level) {
      await rpc.call("threadNotifications.set", { threadId, level });
      const persisted = await rpc.call("threadNotifications.list", { threadIds: [threadId] });
      const preference = persisted.threads[threadId];
      if (preference === undefined) throw new Error("Owned notification preference was not persisted");
      setStored(preference.own);
    },
  };
  const registration = instrumentPluginLocalRegistration(pluginId, "threadActions", notificationsThreadAction);
  const item = registration.item({ thread: target, data, sdk, navigate });
  if (item === null) throw new Error("Owned notification target did not expose its action");
  const action = bindThreadAction(`${pluginId}/notifications`, item, () => { throw new Error("Notification action must not request a rename"); });
  return <><button onClickCapture={(event) => productAnalyticsInput(event.nativeEvent)} onClick={() => { void action.run("muted"); }}>Mute target notifications</button><output>{stored}</output></>;
}

describe("analytics returned thread-action target scope", () => {
  it.each(["work", "personal"] as const)("keeps a Work notification target scoped to Work while viewing %s", async (view) => {
    await withBrowserAnalyticsConsumer({ notifications: true }, async ({ forward, report, queue, work, personal, workThread, pluginId }) => {
      if (pluginId === null) throw new Error("Owned notifications consumer was not installed");
      const restoreQueue = bindConsumerQueue(queue);
      const queryClient = createAppQueryClient({ showMutationErrorToasts: false });
      const requests: Request[] = [];
      vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? new Request(input, init) : new Request(new URL(String(input), "http://localhost"), init);
        requests.push(request.clone());
        return forward(request);
      });
      try {
        setProductAnalyticsView({ kind: "project", projectId: view === "work" ? work.id : personal.id }, "web");
        const target: PluginThreadActionTarget = { ...workThread, parentThreadId: null, archivedAt: null, pinnedAt: null, sectionId: null, isUnread: false, status: "idle", environment: null };
        render(<MemoryRouter><QueryClientProvider client={queryClient}><PluginContext.Provider value={pluginId}><NotificationsConsumer target={target} pluginId={pluginId} /></PluginContext.Provider></QueryClientProvider></MemoryRouter>);
        fireEvent.click(screen.getByRole("button", { name: "Mute target notifications" }));
        await waitFor(() => expect(screen.getByText("muted")).toBeTruthy());
        await waitFor(async () => {
          await productAnalyticsOutbox.flush();
          const result = await report(work.id);
          expect(result.rows.find((row) => row.featureId === `ui.plugin.${pluginId}` && row.action === "slot.threadActions.notifications.run")).toMatchObject({ attempts: 1, successes: 1, unknown: 1, human: 0 });
          expect(result.rows.find((row) => row.featureId === `plugin.${pluginId}` && row.action === "rpc.threadNotifications.set")).toMatchObject({ attempts: 1, successes: 1 });
          expect(result.rows.find((row) => row.featureId === "core.threads" && row.action === "pluginMetadata.update")).toMatchObject({ attempts: 1, successes: 1 });
        });
        for (const projectId of [personal.id, undefined]) {
          const result = await report(projectId);
          expect(result.rows.find((row) => row.featureId === `ui.plugin.${pluginId}` && row.action === "slot.threadActions.notifications.run")).toMatchObject({ attempts: 0, successes: 0, lastUsedAt: null });
          expect(result.rows.find((row) => row.featureId === `plugin.${pluginId}` && row.action === "rpc.threadNotifications.set")).toMatchObject({ attempts: 0, successes: 0 });
          expect(result.rows.find((row) => row.featureId === "core.threads" && row.action === "pluginMetadata.update")).toMatchObject({ attempts: 0, successes: 0 });
        }
        const request = requests.find((value) => value.url.endsWith("/rpc/threadNotifications.set"));
        expect(request?.headers.get(headers.project)).toBe(work.id);
        expect(request?.headers.get(headers.intent)).toBe("use");
        expect(request?.headers.get(headers.actor)).toBe("unknown");
      } finally {
        cleanup();
        queryClient.clear();
        await restoreQueue();
      }
    });
  });
});

function SplitCloseConsumer({ threadId }: { threadId: string }) {
  const store = useStore();
  const layout = useAtomValue(splitLayoutAtom);
  const panes = layout === null ? [] : listPanes(layout.root);
  return <><button onClickCapture={(event) => productAnalyticsInput(event.nativeEvent)} onClick={() => store.set(closePanesForThreadsAtom, [threadId])}>Close target pane</button><output>{panes.map((pane) => pane.content.kind === "thread" ? pane.content.threadId : pane.content.kind).join(",")}</output></>;
}

describe("analytics split-close removed owner", () => {
  it.each(["personal", "work"] as const)("attributes closing Work to the removed owner when the survivor is %s", async (survivor) => {
    await withBrowserAnalyticsConsumer({}, async ({ forward, report, queue, work, personal, workThread, secondWorkThread, personalThread }) => {
      const restoreQueue = bindConsumerQueue(queue);
      const store = createStore();
      vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => forward(input instanceof Request ? new Request(input, init) : new Request(new URL(String(input), "http://localhost"), init)));
      try {
        setProductAnalyticsView({ kind: "project", projectId: work.id }, "web");
        const remaining = survivor === "work" ? secondWorkThread : personalThread;
        const initial: SplitLayout = { root: { type: "pane", paneId: "removed", content: { kind: "thread", projectId: work.id, threadId: workThread.id } }, focusedPaneId: "removed" };
        store.set(splitLayoutAtom, setFocus(splitPane(initial, "removed", "right", { kind: "thread", projectId: remaining.projectId, threadId: remaining.id }), "removed"));
        render(<Provider store={store}><SplitCloseConsumer threadId={workThread.id} /></Provider>);
        fireEvent.click(screen.getByRole("button", { name: "Close target pane" }));
        await waitFor(() => expect(screen.getByText(remaining.id)).toBeTruthy());
        expect(store.get(splitLayoutAtom)).toMatchObject({ root: { type: "pane", content: { kind: "thread", threadId: remaining.id, projectId: remaining.projectId } } });
        await waitFor(async () => {
          await productAnalyticsOutbox.flush();
          expect((await report(work.id)).rows.find((row) => row.featureId === "ui.splits" && row.action === "close")).toMatchObject({ attempts: 1, successes: 1, unknown: 1, human: 0 });
        });
        for (const projectId of [personal.id, undefined]) expect((await report(projectId)).rows.find((row) => row.featureId === "ui.splits" && row.action === "close")).toMatchObject({ attempts: 0, successes: 0, lastUsedAt: null });
      } finally {
        cleanup();
        store.set(splitLayoutAtom, null);
        await restoreQueue();
      }
    });
  });
});
