/**
 * react-smart-query — Public API
 *
 * Import from the package root:
 *   import { useSmartQuery, createTypedQuery, ... } from "react-smart-query";
 *
 * Test utilities (separate entry point to keep test deps out of prod bundle):
 *   import { SmartQueryTestProvider, seedCache } from "react-smart-query/testing";
 *
 * Debug tools (side-effect import, dev only):
 *   import "react-smart-query/debug";
 */

// ── Hooks ──────────────────────────────────────────────────────────────────────
export { useSmartQuery, invalidateSmartCache, clearAllSmartCache } from "./hooks/useSmartQuery";
export type { SmartQueryOptions, SmartQueryResult } from "./hooks/useSmartQuery";

export { useSmartMutation } from "./hooks/useSmartMutation";
export type { SmartMutationOptions, SmartMutationResult } from "./hooks/useSmartMutation";

export { useInfiniteSmartQuery } from "./hooks/useInfiniteSmartQuery";
export type { InfiniteSmartQueryOptions, InfiniteSmartQueryResult } from "./hooks/useInfiniteSmartQuery";

export { useSmartQuerySelector } from "./hooks/useSmartQuerySelector";

// ── Factory ────────────────────────────────────────────────────────────────────
export { createTypedQuery } from "./factory/createTypedQuery";
export type { TypedQueryDefinition, CreateTypedQueryConfig } from "./factory/createTypedQuery";

// ── Registry ───────────────────────────────────────────────────────────────────
export { getSmartQueryActions, batchUpdate, smartQueryDebug } from "./registry/smartQueryRegistry";
export type { SmartQueryActions } from "./registry/smartQueryRegistry";

// ── Queue ──────────────────────────────────────────────────────────────────────
export {
  registerExecutor,
  enqueueMutation,
  processQueue,
  initQueue,
  clearQueue,
  getQueue,
  getQueueLength,
} from "./services/queue.service";

// ── Observability ──────────────────────────────────────────────────────────────
export { addObserver, removeObserver, clearObservers } from "./services/observer.service";
export type { ObservabilityEvent, ObserverFn } from "./types";

// ── Cache ──────────────────────────────────────────────────────────────────────
export {
  readCache,
  writeCache,
  deleteCache,
  getPartialCache,
  cacheKeyFor,
  isCacheStale,
  CURRENT_CACHE_VERSION,
  setMaxCacheEntries,
} from "./services/cache.service";
export type { CacheEntry } from "./types";

// ── Normalize ──────────────────────────────────────────────────────────────────
export {
  fromArray,
  toArray,
  normalizedAdd,
  normalizedUpdate,
  normalizedRemove,
  emptyList,
  isNormalizedEmpty,
  trimNormalizedList,
} from "./utils/normalize";
export type { NormalizedList } from "./types";

// ── Smart compare ──────────────────────────────────────────────────────────────
export { smartCompare, isDataEqual } from "./utils/smartCompare";
export type { SmartCompareOptions, CompareResult } from "./utils/smartCompare";

// ── Shared types ───────────────────────────────────────────────────────────────
export type {
  AnyItem,
  GetItemId,
  GetItemVersion,
  SortComparator,
  SmartQueryError,
  QueuedMutation,
  MutationType,
  InfinitePagedData,
  AsyncStorage,
} from "./types";

// ── Request lock ───────────────────────────────────────────────────────────────
export { fetchWithLock, inFlightCount, inFlightKeys } from "./services/requestLock.service";
