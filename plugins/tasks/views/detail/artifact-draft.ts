import { useCallback, useSyncExternalStore } from "react";

export type ArtifactSourceIdentity = { sourceThreadId: string; eventSeq: number };
type ArtifactDraft = { quote: string; revision: number };

const drafts = new Map<string, ArtifactDraft>();
const subscribers = new Map<string, Set<() => void>>();
let pendingKey: string | null = null;
let nextRevision = 0;

function sourceKey(source: ArtifactSourceIdentity): string {
  return `${source.sourceThreadId}:${source.eventSeq}`;
}

export function stageArtifactDraft(source: ArtifactSourceIdentity, quote: string): number {
  if (pendingKey !== null && !subscribers.get(pendingKey)?.size) drafts.delete(pendingKey);
  const key = sourceKey(source);
  const revision = ++nextRevision;
  drafts.set(key, { quote, revision });
  pendingKey = key;
  subscribers.get(key)?.forEach(notify => notify());
  return revision;
}

export function discardArtifactDraft(source: ArtifactSourceIdentity, revision: number): void {
  const key = sourceKey(source);
  if (drafts.get(key)?.revision !== revision) return;
  drafts.delete(key);
  if (pendingKey === key) pendingKey = null;
  subscribers.get(key)?.forEach(notify => notify());
}

export function useArtifactDraft(source: ArtifactSourceIdentity): ArtifactDraft | null {
  const key = sourceKey(source);
  const subscribe = useCallback((notify: () => void) => {
    let listeners = subscribers.get(key);
    if (!listeners) {
      listeners = new Set();
      subscribers.set(key, listeners);
    }
    const current = listeners;
    current.add(notify);
    return () => {
      current.delete(notify);
      const revision = drafts.get(key)?.revision;
      queueMicrotask(() => {
        if (current.size !== 0 || subscribers.get(key) !== current) return;
        subscribers.delete(key);
        if (drafts.get(key)?.revision === revision) {
          drafts.delete(key);
          if (pendingKey === key) pendingKey = null;
        }
      });
    };
  }, [key]);
  return useSyncExternalStore(subscribe, () => drafts.get(key) ?? null, () => null);
}
