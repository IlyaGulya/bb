import { act, renderHook, waitFor } from "@testing-library/react";
import { z } from "zod";
import { loadPluginApp, renderSlot, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { usePanelPluginPanels } from "@/components/secondary-panel/usePanelPluginPanels";
import { useThreadFileTabs } from "@/components/secondary-panel/useThreadFileTabs";
import { resetRecentlyClosedPanelTabsForTest } from "@/components/secondary-panel/recentlyClosedPanelTabs";
import { resetFixedPanelTabsStateForTest } from "@/lib/fixed-panel-tabs";
import { getFixedPanelTabsStateStorageKey, type PluginPanelFixedPanelTab } from "@/lib/fixed-panel-tabs-state";
import { parsePersistedPluginPanelParams } from "@/lib/plugin-json-value";
import { runPluginMessageAction } from "@/lib/plugin-message-actions";
import { createQueryClientTestHarness } from "./queryClientTestHarness";
import type { TaskArtifactReviewFixture } from "./task-artifact-review-fixture";

export function loadTaskArtifactApp() {
  return loadPluginApp(() => import("../../../../plugins/tasks/app"));
}

export function artifactConsumerRpc(fixture: TaskArtifactReviewFixture) {
  return new Proxy({}, {
    get(_target, method) {
      if (typeof method !== "string") return undefined;
      return (input: unknown) => fixture.harness.callRpc(method, input);
    },
  });
}

type ActionPanel = {
  slot: RenderedSlot;
  tab: PluginPanelFixedPanelTab;
  storageKey: string;
  close: () => void;
};

export async function withArtifactActionPanel(
  fixture: TaskArtifactReviewFixture,
  options: { text: string; selectedText?: string; panelStateId: string },
  run: (panel: ActionPanel) => Promise<void>,
) {
  const source = fixture.threads.get("thr_work_source");
  if (!source) throw new Error("Synthetic action source is missing");
  source.text = options.text;
  const app = await loadTaskArtifactApp();
  const action = app.messageActions.find(entry => entry.id === "save-task-artifact");
  const panel = app.threadPanelActions.find(entry => entry.id === "save-artifact");
  if (!action || !panel?.component) throw new Error("Actual Tasks artifact action or panel is missing");
  const storageKey = getFixedPanelTabsStateStorageKey({ threadId: options.panelStateId });
  const previousStorage = window.localStorage.getItem(storageKey);
  window.localStorage.removeItem(storageKey);
  const query = createQueryClientTestHarness();
  const actions = app.threadPanelActions.map(entry => ({ ...entry, pluginId: "tasks" }));
  const hook = renderHook(() => {
    const tabs = useThreadFileTabs({
      panelStateId: options.panelStateId,
      syncThreadId: null,
      environmentId: null,
      storageFiles: undefined,
      terminalSessions: undefined,
    });
    const openThreadPanel = usePanelPluginPanels({
      actions,
      isFocused: true,
      openPluginPanel: tabs.openPluginPanel,
      reveal() {},
      slot: "threadPanelAction",
    });
    return { tabs, openThreadPanel };
  }, { wrapper: query.wrapper });
  let slot: RenderedSlot | undefined;
  try {
    act(() => runPluginMessageAction({
      slot: { ...action, pluginId: "tasks", generation: 1 },
      threadId: "thr_work_source",
      message: {
        id: "synthetic-source-message",
        threadId: "thr_work_source",
        role: "assistant",
        text: options.text,
        sourceSeqEnd: 11,
        experimental_messageSeq: 7,
      },
      ...(options.selectedText === undefined ? {} : { selectedText: options.selectedText }),
      composerHost: null,
      openThreadPanel: hook.result.current.openThreadPanel,
    }));
    const tab = await waitFor(() => {
      const current = hook.result.current.tabs.orderedSecondaryFileTabs.find(entry => entry.kind === "plugin-panel");
      if (!current || current.kind !== "plugin-panel") throw new Error("Message action did not open its real panel tab");
      return current;
    });
    await waitFor(() => z.string().parse(window.localStorage.getItem(storageKey)));
    slot = renderSlot({ component: panel.component }, {
      threadId: "thr_work_source",
      params: parsePersistedPluginPanelParams(tab.paramsJson),
    }, {
      pluginId: "tasks",
      rpc: artifactConsumerRpc(fixture),
      sdk: {
        threads: {
          get: input => fixture.bb.sdk.threads.get(input),
          message: input => fixture.bb.sdk.threads.message(input),
        },
      },
    });
    await run({
      slot,
      tab,
      storageKey,
      close: () => {
        slot?.unmount();
        slot = undefined;
        act(() => hook.result.current.tabs.closeTab(tab.id));
      },
    });
  } finally {
    slot?.unmount();
    hook.unmount();
    query.queryClient.clear();
    resetRecentlyClosedPanelTabsForTest();
    resetFixedPanelTabsStateForTest();
    if (previousStorage === null) window.localStorage.removeItem(storageKey);
    else window.localStorage.setItem(storageKey, previousStorage);
  }
}
