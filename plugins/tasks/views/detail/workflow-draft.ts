import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { workflowSelectionSchema, type WorkflowDraft, type WorkflowSelection, type WorkflowSetupContract } from "../../shared/workflow-preparation.js";

export function useWorkflowDraft(taskId: string) {
  const rpc = useRpc<WorkflowSetupContract>();
  const [draft, setDraft] = useState<WorkflowDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const current = useRef<WorkflowDraft | null>(null);
  const desired = useRef<WorkflowSelection | null>(null);
  const pending = useRef<Promise<boolean> | null>(null);
  const failed = useRef(false);
  const mounted = useRef(true);
  const loadSequence = useRef(0);
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    try {
      const saved = await rpc.call("getTaskWorkflowDraft", { taskId });
      if (sequence !== loadSequence.current) return;
      current.current = saved;
      desired.current = saved.selection;
      failed.current = false;
      if (mounted.current) { setDraft(saved); setError(null); }
    } catch (cause) {
      if (mounted.current && sequence === loadSequence.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [rpc, taskId]);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load]);
  const flush = useCallback((): Promise<boolean> => {
    if (pending.current) return pending.current;
    if (failed.current || !current.current || !desired.current) return Promise.resolve(false);
    const work = (async () => {
      if (mounted.current) setSaving(true);
      try {
        while (current.current && desired.current && (current.current.revision === 0 || JSON.stringify(current.current.selection) !== JSON.stringify(desired.current))) {
          const selection = desired.current;
          const saved = await rpc.call("saveTaskWorkflowDraft", { taskId, revision: current.current.revision, selection });
          current.current = saved;
          if (mounted.current) setDraft({ ...saved, selection: desired.current });
        }
        if (mounted.current) setError(null);
        return true;
      } catch (cause) {
        failed.current = true;
        if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
        return false;
      } finally {
        if (mounted.current) setSaving(false);
      }
    })().finally(() => { pending.current = null; });
    pending.current = work;
    return work;
  }, [rpc, taskId]);
  function change(selection: WorkflowSelection) {
    const parsed = workflowSelectionSchema.parse(selection);
    loadSequence.current++;
    desired.current = parsed;
    if (current.current) setDraft({ ...current.current, selection: parsed });
    if (!failed.current) void flush();
  }
  async function retry() {
    failed.current = false;
    return flush();
  }
  async function keepLocalChoices() {
    if (!desired.current) return;
    try {
      const saved = await rpc.call("getTaskWorkflowDraft", { taskId });
      current.current = saved;
      failed.current = false;
      await flush();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return { draft, change, flush, reload: load, retry, keepLocalChoices, saving, error, savedRevision: () => current.current?.revision ?? 0 };
}
