/**
 * src/hooks/useInfiniteSmartQuery.ts
 *
 * Cursor-based infinite scroll hook.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  readCache,
  writeCache,
  cacheKeyFor,
  isCacheStale,
} from "../services/cache.service";
import { fetchWithLock } from "../services/requestLock.service";
import { emit } from "../services/observer.service";
import {
  NormalizedList,
  fromArray,
  toArray,
  normalizedAdd,
  normalizedUpdate,
  normalizedRemove,
  emptyList,
} from "../utils/normalize";
import type {
  AnyItem,
  GetItemId,
  GetItemVersion,
  SortComparator,
  UnifiedNormalizedInfiniteData,
  SmartQueryError,
  PaginationMode,
} from "../types";
import {
  derivePages,
  mergeNormalizedData,
  trimNormalizedList,
} from "../utils/normalize";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InfiniteSmartQueryOptions<TRaw, TItem extends AnyItem> {
  queryKey: readonly unknown[];

  /**
   * Fetches one page. Receives `pageParam` (the cursor).
   * First call receives `initialPageParam`.
   */
  queryFn: (ctx: { pageParam: unknown }) => Promise<TRaw>;

  /**
   * Extract the cursor for the NEXT page from the raw page response.
   * Return null when there are no more pages.
   */
  getNextCursor: (raw: TRaw) => unknown | null;

  /**
   * Transform raw page response → TItem[].
   * Use to unwrap response envelopes.
   */
  select: (raw: TRaw) => TItem[];

  /** Extract stable string id from an item */
  getItemId: GetItemId<TItem>;

  /** Sort order within each page (and across pages) */
  sortComparator?: SortComparator<TItem>;

  /** Cursor to use for the first page. Default: undefined */
  initialPageParam?: unknown;

  /**
   * "normalized" (default) -> data: TItem[]
   * "pages" -> data: { pages: TItem[][] }
   */
  paginationMode?: PaginationMode;

  /** Optional. Inferred from first page if not provided. */
  pageSize?: number;

  /** Maximum items to keep in the unified normalized list. Default: 1000 */
  maxItems?: number;

  /** Optional. Extracts version/timestamp for conflict resolution. */
  getItemVersion?: GetItemVersion<TItem>;

  cacheTtl?: number;
  strictFreshness?: boolean;
  onError?: (error: SmartQueryError) => void;
}

export interface InfiniteSmartQueryResult<TItem extends AnyItem> {
  /**
   * If paginationMode: "normalized", data is TItem[]
   * If paginationMode: "pages", data is { pages: TItem[][] }
   */
  data: TItem[] | { pages: TItem[][] };
  isLoading: boolean;
  isFetchingNextPage: boolean;
  isFetching: boolean;
  isRefreshing: boolean;
  hasNextPage: boolean;
  error: SmartQueryError | null;
  totalCount: number;
  fetchNextPage(): void;
  refetch(): void;
  addItem(item: TItem): void;
  updateItem(item: TItem): void;
  removeItem(id: string): void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

export function useInfiniteSmartQuery<TRaw, TItem extends AnyItem>(
  options: InfiniteSmartQueryOptions<TRaw, TItem>
): InfiniteSmartQueryResult<TItem> {
  const {
    queryKey,
    queryFn,
    getNextCursor,
    select,
    getItemId,
    getItemVersion,
    sortComparator,
    initialPageParam = undefined,
    paginationMode = "normalized",
    pageSize: pageSizeProp,
    maxItems = 1000,
    cacheTtl = DEFAULT_TTL,
    strictFreshness = false,
    onError,
  } = options;

  const storageKey = useMemo(
    () => cacheKeyFor(queryKey),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(queryKey)]
  );

  // ── State ──────────────────────────────────────────────────────────────────
  const [infiniteData, setInfiniteData] = useState<UnifiedNormalizedInfiniteData<TItem>>({
    data: emptyList<TItem>(),
    meta: {
      nextCursor: initialPageParam ?? null,
      pageParams: [],
    },
  });
  const [pageSize, setPageSize] = useState<number | undefined>(pageSizeProp);
  const [isCacheLoading, setIsCacheLoading] = useState(true);
  const [isFetchingNextPage, setIsFetchingNextPage] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [error, setError] = useState<SmartQueryError | null>(null);

  const infiniteRef = useRef(infiniteData);

  function setAndNotify(next: UnifiedNormalizedInfiniteData<TItem>) {
    infiniteRef.current = next;
    setInfiniteData(next);
  }

  // ── ① Load from cache ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setIsCacheLoading(true);

    readCache<UnifiedNormalizedInfiniteData<TItem>>(storageKey, queryKey).then((entry) => {
      if (cancelled) return;
      if (entry !== null) {
        const isStale = isCacheStale(entry, cacheTtl);
        if (!strictFreshness || !isStale) {
          setAndNotify(entry.data);
        }
      }
      setIsCacheLoading(false);
    });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  // ── ② Fetch a single page ──────────────────────────────────────────────────
  const fetchPage = useCallback(
    async (cursor: unknown): Promise<void> => {
      const lockKey = `${storageKey}:${JSON.stringify(cursor)}`;
      emit({ type: "fetch_start", queryKey });

      try {
        const raw = await fetchWithLock(lockKey, () => queryFn({ pageParam: cursor }));
        const items = select(raw);
        const nextCursor = getNextCursor(raw);
        const pageIds = items.map(getItemId);
        const pageById = fromArray(items, getItemId).byId;
        const now = Date.now();

        emit({ type: "fetch_success", queryKey, durationMs: 0 });

        const current = infiniteRef.current;
        const alreadyFetched = current.meta.pageParams.includes(cursor);

        if (!pageSize && items.length > 0) {
          setPageSize(items.length);
        }

        let mergedList = mergeNormalizedData(
          current.data,
          pageIds,
          pageById,
          getItemId,
          sortComparator
        );

        mergedList = trimNormalizedList(mergedList, maxItems);

        const next: UnifiedNormalizedInfiniteData<TItem> = {
          data: mergedList,
          meta: {
            pageParams: alreadyFetched ? current.meta.pageParams : [...current.meta.pageParams, cursor],
            nextCursor,
            lastFetchedAt: now,
          },
        };

        setAndNotify(next);
        void writeCache(storageKey, next, queryKey);
        setError(null);
      } catch (err) {
        emit({ type: "fetch_error", queryKey, error: err });
        const structured = normalizeError(err);
        setError(structured);
        onError?.(structured);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storageKey, queryFn, select, getNextCursor, getItemId, sortComparator, maxItems]
  );

  // ── ③ Initial fetch ────────────────────────────────────────────────────────
  useEffect(() => {
    if (isCacheLoading) return;
    void (async () => {
      setIsFetching(true);
      await fetchPage(initialPageParam);
      setIsFetching(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCacheLoading]);

  // ── ④ Load next page ───────────────────────────────────────────────────────
  const inFlightRef = useRef<Set<string>>(new Set());

  const fetchNextPage = useCallback(() => {
    const { nextCursor, lastFetchedAt } = infiniteRef.current.meta;
    if (nextCursor === null || isFetchingNextPage) return;

    const cursorKey = JSON.stringify(nextCursor);
    if (inFlightRef.current.has(cursorKey)) return;

    if (lastFetchedAt && Date.now() - lastFetchedAt < 500) return;

    void (async () => {
      inFlightRef.current.add(cursorKey);
      setIsFetchingNextPage(true);
      await fetchPage(nextCursor);
      setIsFetchingNextPage(false);
      inFlightRef.current.delete(cursorKey);
    })();
  }, [fetchPage, isFetchingNextPage]);

  const refetch = useCallback(() => {
    void (async () => {
      setIsFetching(true);
      await fetchPage(initialPageParam);
      setIsFetching(false);
    })();
  }, [fetchPage, initialPageParam]);

  // ── ⑤ Single-item mutations across all pages ───────────────────────────────

  const applyItemMutation = useCallback(
    (fn: (data: NormalizedList<TItem>) => NormalizedList<TItem>) => {
      const current = infiniteRef.current;
      const next: UnifiedNormalizedInfiniteData<TItem> = {
        ...current,
        data: fn(current.data),
      };
      setAndNotify(next);
      void writeCache(storageKey, next, queryKey);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storageKey]
  );

  const updateItem = useCallback(
    (item: TItem) => {
      applyItemMutation((data) =>
        normalizedUpdate(
          data,
          item,
          getItemId,
          sortComparator ?? ((a, b) => 0),
          getItemVersion
        )
      );
    },
    [getItemId, sortComparator, getItemVersion, applyItemMutation]
  );

  const addItem = useCallback(
    (item: TItem) => {
      const id = getItemId(item);
      const current = infiniteRef.current;

      if (id in current.data.byId) {
        updateItem(item);
        return;
      }

      applyItemMutation((data) => {
        const next = normalizedAdd(
          data,
          item,
          getItemId,
          sortComparator ?? ((a, b) => 0),
          getItemVersion
        );
        return trimNormalizedList(next, maxItems);
      });
    },
    [getItemId, sortComparator, getItemVersion, applyItemMutation, updateItem, maxItems]
  );

  const removeItem = useCallback(
    (id: string) => {
      applyItemMutation((data) => normalizedRemove(data, id));
    },
    [applyItemMutation]
  );

  const flatData = useMemo(() => toArray(infiniteData.data), [infiniteData.data]);
  const isLoading = isCacheLoading || (flatData.length === 0 && isFetching);
  const isRefreshing = !!(flatData.length > 0 && isFetching && !isFetchingNextPage);
  const hasNextPage = infiniteRef.current.meta.nextCursor !== null;
  const totalCount = infiniteData.data.allIds.length;

  const derivedData = useMemo(() => {
    if (paginationMode === "pages") {
      return {
        pages: derivePages(
          infiniteData.data.allIds,
          infiniteData.data.byId,
          pageSize ?? flatData.length
        ),
      };
    }
    return flatData;
  }, [paginationMode, infiniteData.data.allIds, infiniteData.data.byId, pageSize, flatData]);

  return {
    data: derivedData as any,
    isLoading,
    isFetchingNextPage,
    isFetching,
    isRefreshing,
    hasNextPage,
    error,
    totalCount,
    fetchNextPage,
    refetch,
    addItem,
    updateItem,
    removeItem,
  };
}
