import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { TasksAppShell } from "./shell/app-shell.js";
import { TasksSidebarAccessory } from "./shell/sidebar-accessory.js";
import { TasksNavigationPanel } from "./shell/navigation-panel.js";
import { TaskDirectiveCard, TaskEmbedPanel } from "./views/embed/index.js";
import { TaskArtifactPanel } from "./views/detail/artifact-panel.js";
import { markdownSelectionText } from "@bb/text-utils/markdown";
import { discardArtifactDraft, stageArtifactDraft } from "./views/detail/artifact-draft.js";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "tasks",
    title: "Tasks",
    icon: "ListTodo",
    path: "tasks",
    component: TasksAppShell,
    experimental_sidebarAccessory: TasksSidebarAccessory,
    fixedTabs: [
      {
        panelId: "tasks",
        id: "navigation",
        title: "Navigation",
        icon: "ListTodo",
        component: TasksNavigationPanel,
        layout: "flush",
      },
    ],
  });
  app.slots.threadPanelAction({
    id: "task",
    title: "Task",
    icon: "ListTodo",
    component: TaskEmbedPanel,
  });
  app.slots.messageDirective({ id: "task", component: TaskDirectiveCard });
  app.slots.threadPanelAction({
    id: "save-artifact",
    title: "Save decision to task",
    icon: "Bookmark",
    component: TaskArtifactPanel,
  });
  app.slots.messageAction({
    id: "save-task-artifact",
    title: "Save decision to task",
    icon: "Bookmark",
    run({ message, selectedText, openPanel }) {
      const source = { sourceThreadId: message.threadId, eventSeq: message.experimental_messageSeq };
      const quote = selectedText ?? markdownSelectionText(message.text);
      const revision = stageArtifactDraft(source, quote.length <= 4000 ? quote : "");
      if (!openPanel({
        actionId: "save-artifact",
        title: "Save decision to task",
        params: source,
      })) {
        discardArtifactDraft(source, revision);
        throw new Error("This surface cannot open the source-retention panel");
      }
    },
  });
});
