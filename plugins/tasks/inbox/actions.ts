import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { publishTasksChanged, type TasksApiStore } from "../api/index.js";
import type { InboxStore } from "./store.js";

export function linkTaskFromInbox(bb: BbPluginApi, store: TasksApiStore, inbox: InboxStore, id: string, taskId: string) {
  if (!store.tasks.getTask(taskId)) throw new Error("Task not found");
  const before = inbox.get(id);
  if (before.sourceKind === "task_route") throw new Error("Routing attention is not new intake. Open its original incoming item before linking a task.");
  const item = inbox.link(id, taskId);
  if (before.taskId !== item.taskId || before.state !== item.state) bb.realtime.publish("inbox:changed", { id: item.id });
  return { item };
}

export function createTaskFromInbox(bb: BbPluginApi, store: TasksApiStore, inbox: InboxStore, id: string, projectId: string) {
  let created = false;
  const item = store.transaction(() => {
    const current = inbox.get(id);
    if (current.sourceKind === "task_route") throw new Error("Routing attention is not new intake. Open its original incoming item before creating a task.");
    if (current.taskId) return current;
    if (!store.tasks.getProject(projectId)) throw new Error("Project not found");
    const task = store.tasks.createTask({ projectId, title: current.title, description: current.body, status: "todo" });
    created = true;
    return inbox.link(current.id, task.id);
  });
  if (created) {
    publishTasksChanged(bb, item.taskId!, projectId);
    bb.realtime.publish("inbox:changed", { id: item.id });
  }
  return { item };
}
