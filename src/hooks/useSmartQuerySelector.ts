/**
 * src/hooks/useSmartQuerySelector.ts
 *
 * Derived data selector — subscribe to a slice of a cached list.
 *
 * Problem:
 *   When an expense list of 500 items has one item updated, every component
 *   calling useSmartQuery rerenders. For a row component this is O(n) renders.
 *
 * Solution:
 *   useSmartQuerySelector subscribes to the TanStack Query cache for a specific
 *   queryKey and applies a selector function. The component only rerenders
 *   when the SELECTOR OUTPUT changes (checked with fast-deep-equal).
 *
 * @example
 *   // Only rerenders when THIS expense changes
 *   const expense = useSmartQuerySelector(
 *     ["expenses", tripId],
 *     (expenses: Expense[]) => expenses.find((e) => e.id === expenseId)
 *   );
 *
 * @example
 *   // Total amount — only rerenders when the total changes
 *   const total = useSmartQuerySelector(
 *     ["expenses", tripId],
 *     (expenses: Expense[]) => expenses.reduce((s, e) => s + e.amount, 0)
 *   );
 */

import { useCallback, useRef } from "react";
import { useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import equal from "fast-deep-equal";

/**
 * Subscribe to a derived slice of a TanStack Query cache entry.
 *
 * @param queryKey   Must match a useSmartQuery / useInfiniteSmartQuery key.
 * @param selector   Pure function — receives the cached data, returns derived value.
 * @param equalityFn Override the equality check. Defaults to fast-deep-equal.
 */
export function useSmartQuerySelector<TData, TSelected>(
  queryKey: readonly unknown[],
  selector: (data: TData | undefined) => TSelected,
  equalityFn: (a: TSelected, b: TSelected) => boolean = equal
): TSelected {
  const queryClient = useQueryClient();
  const selectedRef = useRef<TSelected>(selector(queryClient.getQueryData<TData>(queryKey)));

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      // TanStack Query cache emits on every update to any key.
      // We filter to our key and equality-check the selector output.
      return queryClient.getQueryCache().subscribe((event) => {
        // Only react to updates for our specific query key
        if (
          event.type !== "updated" &&
          event.type !== "added" &&
          event.type !== "removed"
        ) return;

        const cacheKey = JSON.stringify(queryKey);
        const eventKey = JSON.stringify(event.query.queryKey);
        if (cacheKey !== eventKey) return;

        const newSelected = selector(queryClient.getQueryData<TData>(queryKey));

        if (!equalityFn(selectedRef.current, newSelected)) {
          selectedRef.current = newSelected;
          onStoreChange();
        }
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryClient, JSON.stringify(queryKey), selector, equalityFn]
  );

  const getSnapshot = useCallback(
    () => selectedRef.current,
    []
  );

  const getServerSnapshot = useCallback(
    () => selector(undefined),
    [selector]
  );

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
