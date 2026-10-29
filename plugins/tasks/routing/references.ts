import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TasksApiStore } from "../api/index.js";
import type { InboxEntry } from "../shared/inbox-contract.js";
import type { Task } from "../db/index.js";

type NativeThread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;

export async function resolveRouteReferences(bb: BbPluginApi, store: TasksApiStore, source: InboxEntry, explicit: string) {
  const tasks = new Map<string, Task>();
  const threads: NativeThread[] = [];
  const missing: string[] = [];
  if (source.taskId) {
    const task = store.tasks.getTask(source.taskId);
    if (!task) throw new Error("The linked native task is unavailable; do not substitute another executor");
    tasks.set(task.id, task);
  }
  const text = `${source.title}\n${source.body}\n${source.sourceUrl ?? ""}`;
  const explicitAddress = explicit.match(/\/task\/([^/?#]+)/)?.[1] ?? explicit.match(/\bthr_[A-Za-z0-9_-]+\b/)?.[0] ?? explicit;
  const addresses = explicitAddress ? [explicitAddress] : source.taskId ? [] : [
    ...(text.match(/\b[A-Za-z][A-Za-z0-9]{0,9}-\d+\b/g) ?? []),
    ...[...text.matchAll(/\/task\/([0-7][0-9A-HJKMNP-TV-Z]{25})(?:\b|\/)/gi)].map(match => match[1]!),
    ...(source.threadId ? [source.threadId] : text.match(/\bthr_[A-Za-z0-9_-]+\b/g) ?? []),
  ];
  const lexical = [...new Set(addresses)].map(address => ({ address, prefix: /^([A-Za-z][A-Za-z0-9]{0,9})-\d+$/.exec(address)?.[1]?.toUpperCase() ?? null }));
  const prefixes = JSON.stringify([...new Set(lexical.flatMap(candidate => candidate.prefix ? [candidate.prefix] : []))]);
  const known = new Set(store.database.prepare<[string, string], { prefix: string }>("SELECT prefix FROM projects WHERE prefix IN (SELECT value FROM json_each(?)) UNION SELECT prefix FROM task_key_aliases WHERE prefix IN (SELECT value FROM json_each(?))").all(prefixes, prefixes).map(row => row.prefix.toUpperCase()));
  const unique = lexical.filter(candidate => explicitAddress || !candidate.prefix || known.has(candidate.prefix) || text.includes(`/task/${candidate.address}`)).map(candidate => candidate.address);
  if (unique.length > 20) throw new Error("Too many native references. Explicitly choose one task or thread before previewing.");
  for (const address of unique) {
    const task = store.tasks.getTask(address) ?? store.tasks.getTaskByKey(address);
    if (task) { tasks.set(task.id, task); continue; }
    if (!address.startsWith("thr_")) { missing.push(address); continue; }
    const links = store.database.prepare<[string], { task_id: string }>("SELECT task_id FROM task_threads WHERE thread_id = ? ORDER BY task_id LIMIT 21").all(address);
    if (links.length > 20) throw new Error("Thread belongs to too many tasks to route safely; choose the intended task explicitly");
    if (links.length) {
      for (const link of links) {
        const linked = store.tasks.getTask(link.task_id);
        if (linked) tasks.set(linked.id, linked);
      }
    } else {
      const thread = await bb.sdk.threads.get({ threadId: address });
      if (thread.deletedAt !== null || thread.archivedAt !== null) throw new Error("The exact native thread is deleted or archived; no replacement was created");
      threads.push(thread);
    }
  }
  if (explicit && missing.length) throw new Error("The explicit native task/thread reference is unavailable. No semantic substitute was selected.");
  return { tasks: [...tasks.values()], threads, missing };
}
