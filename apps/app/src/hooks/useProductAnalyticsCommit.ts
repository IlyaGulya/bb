import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { beginProductAnalyticsAction, withProductAnalyticsOperation } from "@/lib/product-analytics";

export function useProductAnalyticsCommit<T>(featureId: string, action: string, value: T) {
  const pending = useRef<{ value: T; operation: ReturnType<typeof beginProductAnalyticsAction> } | null>(null);
  useLayoutEffect(() => {
    if (pending.current === null || !Object.is(pending.current.value, value)) return;
    void pending.current.operation.complete();
    pending.current = null;
  }, [value]);
  useEffect(() => () => {
    if (pending.current === null) return;
    void pending.current.operation.complete("cancelled", "cancelled");
    pending.current = null;
  }, []);
  return useCallback(<R,>(next: T, run: () => R): R => {
    if (Object.is(value, next)) return run();
    if (pending.current !== null) void pending.current.operation.complete("cancelled", "cancelled");
    const operation = beginProductAnalyticsAction(featureId, action);
    pending.current = { value: next, operation };
    try {
      return withProductAnalyticsOperation(operation, run);
    } catch (error) {
      pending.current = null;
      void operation.complete("failed", "internal");
      throw error;
    }
  }, [action, featureId, value]);
}
