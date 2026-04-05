/**
 * src/hooks/useSmartMutation.ts
 *
 * First-class write hook — the companion to useSmartQuery.
 *
 * Handles the full mutation lifecycle:
 *   1. Optimistic update via getSmartQueryActions (instant UI)
 *   2. API call via mutationFn
 *   3. On success: optionally update the optimistic item with the server response
 *   4. On error: automatic rollback of the optimistic update
 *   5. Offline: enqueue to the persistent mutation queue
 *
 * Usage:
 *   const { mutate, mutateAsync, isLoading, error } = useSmartMutation<Expense>({
 *     queryKey: ["expenses", tripId],
 *     mutationType: "ADD_ITEM",
 *     mutationFn: (expense) => api.post("/expenses", expense),
 *     getItemId: (e) => e.id,
 *   });
 *
 *   mutate(newExpense); // optimistic + API + queue if offline
 */

import { useCallback, useRef, useState } from "react";
import { getSmartQueryActions } from "../registry/smartQueryRegistry";
import {
  enqueueMutation,
  processQueue,
} from "../services/queue.service";
import { emit } from "../services/observer.service";
import type {
  AnyItem,
  GetItemId,
  MutationType,
  SmartQueryError,
} from "../types";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SmartMutationOptions<TItem extends AnyItem, TResponse = TItem> {
  /** The query key this mutation targets — must match the useSmartQuery key */
  queryKey: readonly unknown[];

  /** "ADD_ITEM" | "UPDATE_ITEM" | "REMOVE_ITEM" | custom string */
  mutationType: MutationType | string;

  /**
   * The API call. Receives the item and returns the server-confirmed version.
   * If the app is offline, this is skipped and the mutation is queued.
   */
  mutationFn: (item: TItem) => Promise<TResponse>;

  /**
   * Extract the stable id from an item.
   * Used to roll back or replace the optimistic item with the server response.
   */
  getItemId: GetItemId<TItem>;

  /**
   * Map the server response back to a TItem for the final cache update.
   * If omitted, the server response is used as-is (assumes TResponse = TItem).
   */
  toItem?: (response: TResponse) => TItem;

  /**
   * Whether to enqueue the mutation when offline.
   * Default: true.
   */
  enableOfflineQueue?: boolean;

  /**
   * Optional entity key for queue coalescing.
   * Example: (item) => `expense:${item.id}`
   */
  getEntityKey?: (item: TItem) => string;

  /** Called after the API call succeeds */
  onSuccess?: (response: TResponse, item: TItem) => void;

  /** Called when the API call fails (after rollback) */
  onError?: (error: SmartQueryError, item: TItem) => void;

  /** Check network status — defaults to navigator.onLine on web, true on native */
  isOnline?: () => boolean;
}

export interface SmartMutationResult<TItem extends AnyItem> {
  /** Fire-and-forget mutation */
  mutate(item: TItem): void;
  /** Async mutation — resolves after the API call completes */
  mutateAsync(item: TItem): Promise<void>;
  isPending: boolean;
  error: SmartQueryError | null;
  reset(): void;
}

// ─── Default online check ─────────────────────────────────────────────────────

function defaultIsOnline(): boolean {
  if (typeof navigator !== "undefined" && "onLine" in navigator) {
    return navigator.onLine;
  }
  return true; // Assume online on native (use NetInfo for accurate check)
}

// ─── Error normalizer ─────────────────────────────────────────────────────────

function normalizeError(cause: unknown): SmartQueryError {
  if (cause instanceof Error) {
    const err = cause as Error & { status?: number };
    const status = err.status;
    return {
      cause,
      message: cause.message,
      retryable: !status || status >= 500 || status === 429,
      statusCode: status,
    };
  }
  return { cause, message: String(cause), retryable: true };
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useSmartMutation<
  TItem extends AnyItem,
  TResponse = TItem
>(
  options: SmartMutationOptions<TItem, TResponse>
): SmartMutationResult<TItem> {
  const {
    queryKey,
    mutationType,
    mutationFn,
    getItemId,
    toItem,
    enableOfflineQueue = true,
    getEntityKey,
    onSuccess,
    onError,
    isOnline = defaultIsOnline,
  } = options;

  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<SmartQueryError | null>(null);
  const isMounted = useRef(true);

  // Get actions for this query key — stable reference via closure
  const getActions = useCallback(
    () => getSmartQueryActions<TItem>(queryKey),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(queryKey)]
  );

  const mutateAsync = useCallback(
    async (item: TItem): Promise<void> => {
      const actions = getActions();
      const itemId = getItemId(item);

      if (isMounted.current) {
        setIsPending(true);
        setError(null);
      }

      // ── Step 1: Optimistic update ────────────────────────────────────────
      if (mutationType === "ADD_ITEM" || mutationType === "CUSTOM") {
        await actions.addItem(item);
      } else if (mutationType === "UPDATE_ITEM") {
        await actions.updateItem(item);
      } else if (mutationType === "REMOVE_ITEM") {
        await actions.removeItem(itemId);
      }

      // ── Step 2: Offline path ─────────────────────────────────────────────
      if (!isOnline()) {
        if (enableOfflineQueue) {
          await enqueueMutation({
            type: mutationType,
            queryKey,
            payload: item,
            entityKey: getEntityKey?.(item),
          });
        }
        if (isMounted.current) setIsPending(false);
        return;
      }

      // ── Step 3: API call ─────────────────────────────────────────────────
      try {
        const response = await mutationFn(item);
        const confirmedItem = toItem ? toItem(response) : (response as unknown as TItem);

        // Replace optimistic item with server-confirmed version
        if (mutationType !== "REMOVE_ITEM") {
          await actions.updateItem(confirmedItem);
        }

        emit({
          type: "queue_success",
          mutationId: `${mutationType}:${itemId}`,
        });

        onSuccess?.(response, item);
        // Drain queue in case there are pending mutations for this key
        void processQueue();
      } catch (err) {
        // ── Step 4: Rollback ───────────────────────────────────────────────
        if (mutationType === "ADD_ITEM" || mutationType === "CUSTOM") {
          await actions.removeItem(itemId);
        } else if (mutationType === "UPDATE_ITEM") {
          // We don't have the original item here — just signal the error.
          // The next background fetch will restore correct state.
        } else if (mutationType === "REMOVE_ITEM") {
          await actions.addItem(item); // restore removed item
        }

        const structured = normalizeError(err);
        if (isMounted.current) setError(structured);
        onError?.(structured, item);
      } finally {
        if (isMounted.current) setIsPending(false);
      }
    },
    [
      getActions,
      getItemId,
      mutationType,
      mutationFn,
      toItem,
      enableOfflineQueue,
      getEntityKey,
      isOnline,
      onSuccess,
      onError,
      queryKey,
    ]
  );

  const mutate = useCallback(
    (item: TItem): void => { void mutateAsync(item); },
    [mutateAsync]
  );

  const reset = useCallback(() => {
    setError(null);
    setIsPending(false);
  }, []);

  return { mutate, mutateAsync, isPending, error, reset };
}
