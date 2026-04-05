/**
 * src/hooks/useSmartQuery.ts
 *
 * Core data-fetching hook — V2.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  useQuery,
  useQueryClient,
  QueryKey,
  QueryFunction,
  UseQueryOptions,
} from "@tanstack/react-query";

import {
  readCache,
  writeCache,
  deleteCache,
  cacheKeyFor,
  isCacheStale,
} from "../services/cache.service";
import { fetchWithLock } from "../services/requestLock.service";
import { storage } from "../services/storage.adapter";
import { emit } from "../services/observer.service";
import { isDataEqual, SmartCompareOptions } from "../utils/smartCompare";
import {
  NormalizedList,
  fromArray,
  toArray,
  normalizedAdd,
  normalizedUpdate,
  normalizedRemove,
  emptyList,
  trimNormalizedList,
} from "../utils/normalize";
import {
  _registerUpdater,
  _unregisterUpdater,
} from "../registry/smartQueryRegistry";
import type {
  AnyItem,
  GetItemId,
  GetItemVersion,
  SortComparator,
  SmartQueryError,
} from "../types";

// ─── Types ────────────────────────────────────────────────────────────────────

export type { AnyItem, GetItemId, SortComparator, SmartQueryError };

export interface SmartQueryOptions<
  TRaw,
  TData,
  TItem extends AnyItem = TData extends AnyItem[] ? TData[number] : AnyItem
> {
  queryKey: QueryKey;

  /**
   * Fetches raw data from the network.
   * Automatically wrapped in fetchWithLock — concurrent calls are deduplicated.
   */
  queryFn: QueryFunction<TRaw>;

  /**
   * Transform the raw API response before caching and exposing to the component.
   */
  select?: (raw: TRaw) => TData;

  /**
   * Extract a stable string id from a list item.
   */
  getItemId?: TData extends AnyItem[] ? GetItemId<TItem> : never;

  /**
   * Sort comparator for list data.
   */
  sortComparator?: TData extends AnyItem[] ? SortComparator<TItem> : never;

  /** Cache TTL in ms. Default: 5 minutes. */
  cacheTtl?: number;

  /** Maximum items to keep in the normalized list. Default: 1000 */
  maxItems?: number;

  /** Optional. Extracts version/timestamp for conflict resolution. */
  getItemVersion?: TData extends AnyItem[] ? GetItemVersion<TItem> : never;

  /**
   * When true, stale cache is never served — waits for a fresh fetch.
   */
  strictFreshness?: boolean;

  /** Data to show when there is no cache and the fetch fails */
  fallbackData?: TData;

  /** Smart diff configuration */
  compareOptions?: SmartCompareOptions;

  /** Called when a fresh fetch succeeds */
  onSuccess?: (data: TData) => void;

  /**
   * Called when a fetch fails.
   */
  onError?: (error: SmartQueryError) => boolean | void;

  /** Extra TanStack Query options */
  queryOptions?: Omit<
    UseQueryOptions<TRaw>,
    "queryKey" | "queryFn" | "initialData" | "enabled" | "select"
  >;
}

export interface SmartQueryResult<
  TData,
  TItem extends AnyItem = TData extends AnyItem[] ? TData[number] : AnyItem
> {
  data: TData | undefined;
  isLoading: boolean;
  isFetching: boolean;
  isFromCache: boolean;
  isCacheLoading: boolean;
  error: SmartQueryError | null;
  refetch: () => void;
  // List mutations
  addItem: TData extends AnyItem[] ? (item: TItem) => void : never;
  updateItem: TData extends AnyItem[] ? (item: TItem) => void : never;
  removeItem: TData extends AnyItem[] ? (id: string) => void : never;
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

const DEFAULT_TTL = 5 * 60_000;

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useSmartQuery<
  TRaw,
  TData,
  TItem extends AnyItem = TData extends AnyItem[] ? TData[number] : AnyItem
>(
  options: SmartQueryOptions<TRaw, TData, TItem>
): SmartQueryResult<TData, TItem> {
  const {
    queryKey,
    queryFn,
    select,
    getItemId,
    sortComparator,
    cacheTtl = DEFAULT_TTL,
    maxItems = 1000,
    getItemVersion,
    strictFreshness = false,
    fallbackData,
    compareOptions,
    onSuccess,
    onError,
    queryOptions = {},
  } = options;

  const queryClient = useQueryClient();

  const storageKey = useMemo(
    () => cacheKeyFor(queryKey as readonly unknown[]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(queryKey)]
  );

  const listMode = typeof sortComparator === "function" && typeof getItemId === "function";

  // ── State ──────────────────────────────────────────────────────────────────
  const [viewData, setViewData] = useState<TData | undefined>(undefined);
  const [isCacheLoading, setIsCacheLoading] = useState(true);
  const [isFromCache, setIsFromCache] = useState(false);
  const [shouldFetch, setShouldFetch] = useState(false);
  const [smartError, setSmartError] = useState<SmartQueryError | null>(null);

  const prevRawRef = useRef<unknown>(undefined);
  const normalizedRef = useRef<NormalizedList<TItem>>(emptyList<TItem>());

  // ── ① Read storage on mount ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setIsCacheLoading(true);

    readCache<unknown>(storageKey, queryKey as readonly unknown[]).then((entry) => {
      if (cancelled) return;

      if (entry !== null) {
        const isStale = isCacheStale(entry, cacheTtl);
        const usable = !strictFreshness || !isStale;

        if (usable) {
          if (listMode) {
            let normalized: NormalizedList<TItem>;
            if (Array.isArray(entry.data)) {
              normalized = fromArray(
                entry.data as TItem[],
                getItemId as GetItemId<TItem>,
                sortComparator as SortComparator<TItem>
              );
            } else {
              normalized = entry.data as NormalizedList<TItem>;
            }
            normalizedRef.current = normalized;
            const view = toArray(normalized) as unknown as TData;
            prevRawRef.current = normalized;
            queryClient.setQueryData(queryKey, view);
            setViewData(view);
          } else {
            prevRawRef.current = entry.data;
            queryClient.setQueryData(queryKey, entry.data as TData);
            setViewData(entry.data as TData);
          }
          setIsFromCache(true);
          setShouldFetch(isStale);
        } else {
          setShouldFetch(true);
        }
      } else {
        setShouldFetch(true);
      }

      setIsCacheLoading(false);
    });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  // ── ② Dedup + select wrapped queryFn ──────────────────────────────────────
  const wrappedQueryFn: QueryFunction<TData> = useCallback(
    async (ctx) => {
      emit({ type: "fetch_start", queryKey: queryKey as readonly unknown[] });
      const start = Date.now();
      try {
        const raw = await fetchWithLock(storageKey, () => queryFn(ctx) as Promise<TRaw>);
        const transformed = select ? select(raw) : (raw as unknown as TData);
        emit({
          type: "fetch_success",
          queryKey: queryKey as readonly unknown[],
          durationMs: Date.now() - start,
        });
        return transformed;
      } catch (err) {
        emit({ type: "fetch_error", queryKey: queryKey as readonly unknown[], error: err });
        throw err;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storageKey, queryFn, select]
  );

  // ── ③ TanStack Query ───────────────────────────────────────────────────────
  const {
    data: freshData,
    isFetching,
    error: tqError,
    refetch: tqRefetch,
  } = useQuery<TData>({
    queryKey,
    queryFn: wrappedQueryFn,
    enabled: !isCacheLoading && shouldFetch,
    staleTime: cacheTtl,
    gcTime: cacheTtl * 2,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    networkMode: "offlineFirst",
    ...(queryOptions as any),
  });

  // ── ④ Handle TQ errors ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!tqError) { setSmartError(null); return; }
    const structured = normalizeError(tqError);
    const suppressed = onError?.(structured);
    if (!suppressed) setSmartError(structured);
  }, [tqError, onError]);

  // ── ⑤ Smart diff + persist ────────────────────────────────────────────────
  useEffect(() => {
    if (freshData === undefined || isFetching) return;

    if (listMode) {
      const freshNormalized = fromArray(
        freshData as unknown as TItem[],
        getItemId as GetItemId<TItem>,
        sortComparator as SortComparator<TItem>
      );

      if (!isDataEqual(prevRawRef.current, freshNormalized, compareOptions)) {
        prevRawRef.current = freshNormalized;
        normalizedRef.current = freshNormalized;
        const view = toArray(freshNormalized) as unknown as TData;
        queryClient.setQueryData(queryKey, view);
        setViewData(() => view);
        setIsFromCache(false);

        const trimmed = trimNormalizedList(freshNormalized, maxItems);
        void writeCache(storageKey, trimmed, queryKey as readonly unknown[]);
        onSuccess?.(view);
      }
    } else {
      if (!isDataEqual(prevRawRef.current, freshData, compareOptions)) {
        prevRawRef.current = freshData;
        queryClient.setQueryData(queryKey, freshData);
        setViewData(() => freshData as TData);
        setIsFromCache(false);
        void writeCache(storageKey, freshData, queryKey as readonly unknown[]);
        onSuccess?.(freshData as TData);
      }
    }
  }, [freshData, isFetching]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── ⑥ List mutations ───────────────────────────────────────────────────────

  const applyMutation = useCallback(
    (fn: (current: NormalizedList<TItem>) => NormalizedList<TItem>) => {
      const next = trimNormalizedList(fn(normalizedRef.current), maxItems);
      normalizedRef.current = next;
      prevRawRef.current = next;
      const view = toArray(next) as unknown as TData;
      queryClient.setQueryData(queryKey, view);
      setViewData(view);
      void writeCache(storageKey, next, queryKey as readonly unknown[]);
    },
    [queryClient, queryKey, storageKey, maxItems]
  );

  const addItem = useCallback(
    (item: TItem) => {
      if (!listMode) return;
      applyMutation((cur) =>
        normalizedAdd(
          cur, item,
          getItemId as GetItemId<TItem>,
          sortComparator as SortComparator<TItem>,
          getItemVersion as GetItemVersion<TItem>
        )
      );
    },
    [listMode, getItemId, sortComparator, getItemVersion, applyMutation]
  );

  const updateItem = useCallback(
    (item: TItem) => {
      if (!listMode) return;
      applyMutation((cur) =>
        normalizedUpdate(
          cur, item,
          getItemId as GetItemId<TItem>,
          sortComparator as SortComparator<TItem>,
          getItemVersion as GetItemVersion<TItem>
        )
      );
    },
    [listMode, getItemId, sortComparator, getItemVersion, applyMutation]
  );

  const removeItem = useCallback(
    (id: string) => {
      if (!listMode) return;
      applyMutation((cur) => normalizedRemove(cur, id));
    },
    [listMode, applyMutation]
  );

  // ── ⑦ Registry registration ────────────────────────────────────────────────
  const addRef = useRef(addItem);
  const updateRef = useRef(updateItem);
  const removeRef = useRef(removeItem);
  useEffect(() => { addRef.current = addItem; }, [addItem]);
  useEffect(() => { updateRef.current = updateItem; }, [updateItem]);
  useEffect(() => { removeRef.current = removeItem; }, [removeItem]);

  useEffect(() => {
    _registerUpdater(
      storageKey,
      {
        add: (item) => addRef.current(item as TItem),
        update: (item) => updateRef.current(item as TItem),
        remove: (id) => removeRef.current(id),
      },
      listMode && !!sortComparator && !!getItemId
        ? {
            comparator: sortComparator as SortComparator<AnyItem>,
            getItemId: getItemId as GetItemId<AnyItem>,
          }
        : null
    );
    return () => _unregisterUpdater(storageKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  // ── Assemble ───────────────────────────────────────────────────────────────
  const data = viewData ?? (tqError ? fallbackData : undefined);
  const isLoading = isCacheLoading || (data === undefined && isFetching);

  const refetch = useCallback(() => {
    setShouldFetch(true);
    tqRefetch();
  }, [tqRefetch]);

  return {
    data,
    isLoading,
    isFetching,
    isFromCache,
    isCacheLoading,
    error: smartError,
    refetch,
    addItem: addItem as SmartQueryResult<TData, TItem>["addItem"],
    updateItem: updateItem as SmartQueryResult<TData, TItem>["updateItem"],
    removeItem: removeItem as SmartQueryResult<TData, TItem>["removeItem"],
  };
}

export const invalidateSmartCache = (queryKey: QueryKey): Promise<void> =>
  deleteCache(cacheKeyFor(queryKey as readonly unknown[]));

export const clearAllSmartCache = (): Promise<void> =>
  storage.clearAll();
