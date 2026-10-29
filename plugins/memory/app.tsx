import { Fragment, useCallback, useEffect, useState } from "react";
import {
  definePluginApp,
  useRpc,
  type PluginRpcResult,
} from "@get-bb/plugin-sdk/app";
import { MemoryWorkspace } from "./memory-workspace.js";
import type { MemorySelection } from "./lineage.js";
import type { memoryRpcContract } from "./server.js";
import { isMemoryKind, MEMORY_KINDS } from "./memory-kinds.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

type MemoryRecord = PluginRpcResult<
  (typeof memoryRpcContract)["listMemories"]
>["memories"][number];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function MemoryEditor({
  memory,
  selection,
  onCancel,
  onSaved,
}: {
  memory: MemoryRecord;
  selection: MemorySelection;
  onCancel: () => void;
  onSaved: (memory: MemoryRecord) => void;
}) {
  const rpc = useRpc<typeof memoryRpcContract>();
  const [draft, setDraft] = useState(memory);
  const [tags, setTags] = useState(memory.tags.join(", "));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="@container/memory-editor space-y-3 rounded-md border border-border bg-muted/20 p-3">
      <div className="grid gap-3 @min-[36rem]/memory-editor:grid-cols-2">
        <label className="space-y-1 text-xs text-muted-foreground">
          Summary
          <Input
            aria-label="Memory summary"
            value={draft.summary}
            maxLength={400}
            onChange={(event) =>
              setDraft({ ...draft, summary: event.target.value })
            }
          />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          Tags
          <Input
            aria-label="Memory tags"
            value={tags}
            placeholder="comma, separated"
            onChange={(event) => setTags(event.target.value)}
          />
        </label>
      </div>
      <label className="block space-y-1 text-xs text-muted-foreground">
        Details
        <Textarea
          aria-label="Memory details"
          value={draft.details}
          maxLength={16_000}
          className="min-h-28 resize-y text-sm"
          onChange={(event) =>
            setDraft({ ...draft, details: event.target.value })
          }
        />
      </label>
      <div className="grid gap-3 @min-[32rem]/memory-editor:grid-cols-3">
        <label className="space-y-1 text-xs text-muted-foreground">
          Kind
          <select
            aria-label="Memory kind"
            value={draft.kind}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
            onChange={(event) => {
              if (isMemoryKind(event.target.value)) {
                setDraft({ ...draft, kind: event.target.value });
              }
            }}
          >
            {MEMORY_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          Importance
          <Input
            aria-label="Memory importance"
            type="number"
            min={0}
            max={100}
            value={draft.importance}
            onChange={(event) =>
              setDraft({ ...draft, importance: Number(event.target.value) })
            }
          />
        </label>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <Switch
            aria-label="Pinned memory"
            checked={draft.pinned}
            onCheckedChange={(pinned) => setDraft({ ...draft, pinned })}
          />
          Pinned
        </label>
      </div>
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={saving}
          onClick={() => {
            setSaving(true);
            setError(null);
            void rpc
              .call("updateMemory", {
                selection,
                id: draft.id,
                expectedVersion: draft.version,
                summary: draft.summary,
                details: draft.details,
                kind: draft.kind,
                tags: tags
                  .split(",")
                  .map((tag) => tag.trim())
                  .filter(Boolean),
                importance: draft.importance,
                pinned: draft.pinned,
              })
              .then((result) => result.memory)
              .then(onSaved)
              .catch((saveError: unknown) => setError(errorMessage(saveError)))
              .finally(() => setSaving(false));
          }}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

function GeneralMemories({ selection }: { selection: MemorySelection }) {
  const rpc = useRpc<typeof memoryRpcContract>();
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setMemories((await rpc.call("listMemories", selection)).memories);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [rpc, selection]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading memories…</p>;
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        General notes only. Task/context records are excluded from this catalog.
        Global notes are explicitly shared across projects; project notes stay in the selected project.
      </p>
      {error ? (
        <div>
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
        <Button variant="ghost" size="sm" onClick={() => void load()}>Retry memories</Button>
        </div>
      ) : null}
      {memories.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No memories stored yet.
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full table-fixed text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="w-auto px-3 py-2 font-medium">Memory</th>
                <th className="w-24 px-3 py-2 font-medium">Scope</th>
                <th className="w-28 px-3 py-2 text-right font-medium">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {memories.map((memory) => (
                <Fragment key={memory.id}>
                  <tr className="align-top">
                    <td className="min-w-0 px-3 py-3">
                      <div className="truncate font-medium text-foreground">
                        {memory.pinned ? "Pinned · " : ""}
                        {memory.name}
                      </div>
                      <div className="mt-1 line-clamp-2 break-words text-muted-foreground">
                        {memory.summary}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span>{memory.kind}</span>
                        <span>importance {memory.importance}</span>
                        <span>
                          updated{" "}
                          {new Date(memory.updatedAt).toLocaleDateString()}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      <div>{memory.scope}</div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col items-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Edit ${memory.name}`}
                          onClick={() =>
                            setEditingId((current) =>
                              current === memory.id ? null : memory.id,
                            )
                          }
                        >
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={confirmingId === memory.id ? `Confirm delete ${memory.name}` : `Delete ${memory.name}`}
                          disabled={deletingId === memory.id}
                          className="text-destructive hover:text-destructive"
                          onClick={() => {
                            if (confirmingId !== memory.id) {
                              setConfirmingId(memory.id);
                              return;
                            }
                            setDeletingId(memory.id);
                            setError(null);
                            void rpc
                              .call("deleteMemory", {
                                id: memory.id,
                                selection,
                                expectedVersion: memory.version,
                              })
                              .then(() => {
                                setConfirmingId(null);
                                setMemories((current) =>
                                  current.filter(
                                    (entry) => entry.id !== memory.id,
                                  ),
                                );
                                setEditingId((current) =>
                                  current === memory.id ? null : current,
                                );
                              })
                              .catch((deleteError: unknown) =>
                                setError(errorMessage(deleteError)),
                              )
                              .finally(() => setDeletingId(null));
                          }}
                        >
                          {deletingId === memory.id ? "Deleting…" : confirmingId === memory.id ? `Confirm delete ${memory.name}` : "Delete"}
                        </Button>
                        {confirmingId === memory.id ? <Button variant="ghost" size="sm" disabled={deletingId === memory.id} onClick={() => setConfirmingId(null)}>Keep {memory.name}</Button> : null}
                      </div>
                    </td>
                  </tr>
                  {editingId === memory.id ? (
                    <tr>
                      <td colSpan={3} className="bg-muted/10 p-3">
                        <MemoryEditor
                          selection={selection}
                          memory={memory}
                          onCancel={() => setEditingId(null)}
                          onSaved={(updated) => {
                            setMemories((current) =>
                              current.map((entry) =>
                                entry.id === updated.id ? updated : entry,
                              ),
                            );
                            setEditingId(null);
                          }}
                        />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function MemorySettings() {
  return <MemoryWorkspace general={GeneralMemories} />;
}

function MemoryThreadPanel({ threadId }: { threadId: string }) {
  return <MemoryWorkspace general={GeneralMemories} threadId={threadId} />;
}

function MemoryPage({ subPath }: { subPath: string }) {
  const rpc = useRpc<typeof memoryRpcContract>();
  const taskKey = /^\/?task\/([^/]+)\/?$/.exec(subPath)?.[1] ?? null;
  type Resolved = PluginRpcResult<(typeof memoryRpcContract)["resolveMemoryTask"]>;
  const [page, setPage] = useState<{ key: string; result: Resolved } | { key: string; error: string } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!taskKey) return;
    let active = true;
    setPage(null);
    void rpc.call("resolveMemoryTask", { taskKey }).then((result) => {
      if (active) setPage({ key: taskKey, result });
    }).catch((failure: unknown) => { if (active) setPage({ key: taskKey, error: errorMessage(failure) }); });
    return () => { active = false; };
  }, [rpc, taskKey, retry]);
  if (!taskKey) return subPath && subPath !== "/" ? <p role="alert" className="text-sm text-destructive">Invalid task memory address. Open Memory and select a named task.</p> : <MemorySettings />;
  if (!page || page.key !== taskKey) return <p role="status" className="text-sm text-muted-foreground">Resolving the selected task's project…</p>;
  if ("error" in page) return <div className="space-y-3"><p role="alert" className="text-sm text-destructive">{page.error}</p><Button variant="outline" onClick={() => setRetry((value) => value + 1)}>Retry task memory</Button></div>;
  return <MemoryWorkspace key={page.result.task.id} general={GeneralMemories} initialTask={page.result} />;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "memory",
    title: "Memory",
    icon: "Brain",
    path: "memory",
    component: MemoryPage,
  });
  app.slots.threadPanelAction({
    id: "task-memory",
    title: "Task memory",
    icon: "Brain",
    component: MemoryThreadPanel,
  });
  app.slots.settingsSection({
    id: "memory",
    title: "Memory",
    description:
      "Review explicit task/context lineage or general provider-independent memories.",
    component: MemorySettings,
  });
});
