/**
 * src/registry/smartQueryRegistry.ts
 *
 * Global mutation registry.
 * Call addItem / updateItem / removeItem from anywhere — no hook required.
 */

import { readCache, writeCache, cacheKeyFor } from "../services/cache.service";
import type { AnyItem, GetItemId, NormalizedList, SortComparator, UnifiedNormalizedInfiniteData } from "../types";
import {
  normalizedAdd,
  normalizedUpdate,
  normalizedRemove,
} from "../utils/normalize";

export { cacheKeyFor };

// ─── Internal ─────────────────────────────────────────────────────────────────

interface LiveUpdater {
  add(item: unknown): void;
  update(item: unknown): void;
  remove(id: string): void;
}

interface SortConfig<T extends AnyItem> {
  comparator: SortComparator<T>;
  getItemId: GetItemId<T>;
}

const liveRegistry = new Map<string, LiveUpdater>();
const sortConfigRegistry = new Map<string, SortConfig<AnyItem>>();

export function _registerUpdater(
  storageKey: string,
  updater: LiveUpdater,
  config: SortConfig<AnyItem> | null
): void {
  liveRegistry.set(storageKey, updater);
  if (config) sortConfigRegistry.set(storageKey, config);
}

export function _unregisterUpdater(storageKey: string): void {
  liveRegistry.delete(storageKey);
}

// ─── Cache-only mutation path ─────────────────────────────────────────────────

async function mutateStorageOnly<T extends AnyItem>(
  storageKey: string,
  queryKey: readonly unknown[],
  fn: (list: NormalizedList<T>, config: SortConfig<T>) => NormalizedList<T>
): Promise<void> {
  const config = sortConfigRegistry.get(storageKey) as SortConfig<T> | undefined;
  if (!config) return;

  const entry = await readCache<any>(storageKey, queryKey);
  if (!entry) return;

  const rawData = entry.data;
  const isUnified = "data" in rawData && "meta" in rawData;
  const currentList: NormalizedList<T> = isUnified ? rawData.data : (rawData as NormalizedList<T>);

  const nextList = fn(currentList, config);

  const nextData = isUnified
    ? { ...rawData, data: nextList }
    : nextList;

  await writeCache(storageKey, nextData, queryKey);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface SmartQueryActions<TItem extends AnyItem> {
  addItem(item: TItem): Promise<void>;
  updateItem(item: TItem): Promise<void>;
  removeItem(id: string): Promise<void>;
  isActive(): boolean;
}

export function getSmartQueryActions<TItem extends AnyItem>(
  queryKey: readonly unknown[]
): SmartQueryActions<TItem> {
  const storageKey = cacheKeyFor(queryKey);

  return {
    isActive: () => liveRegistry.has(storageKey),

    addItem: async (item) => {
      const live = liveRegistry.get(storageKey);
      if (live) { live.add(item); return; }
      await mutateStorageOnly<TItem>(storageKey, queryKey, (list, { comparator, getItemId }) =>
        normalizedAdd(list, item, getItemId, comparator)
      );
    },

    updateItem: async (item) => {
      const live = liveRegistry.get(storageKey);
      if (live) { live.update(item); return; }
      await mutateStorageOnly<TItem>(storageKey, queryKey, (list, { comparator, getItemId }) =>
        normalizedUpdate(list, item, getItemId, comparator)
      );
    },

    removeItem: async (id) => {
      const live = liveRegistry.get(storageKey);
      if (live) { live.remove(id); return; }
      await mutateStorageOnly<TItem>(storageKey, queryKey, (list) =>
        normalizedRemove(list, id)
      );
    },
  };
}

// ─── Debug Tools ─────────────────────────────────────────────────────────────

declare const __DEV__: boolean;

/**
 * Dev-only debug API. All methods are no-ops in production.
 */
export const smartQueryDebug = {
  /** Get the current normalized state for a query key. */
  getNormalizedState: async <T extends AnyItem>(
    queryKey: readonly unknown[]
  ): Promise<NormalizedList<T> | UnifiedNormalizedInfiniteData<T> | null> => {
    if (typeof __DEV__ !== "undefined" && !__DEV__) return null;
    const storageKey = cacheKeyFor(queryKey);
    const entry = await readCache<any>(storageKey, queryKey);
    return entry ? entry.data : null;
  },

  /** Log a detailed summary of the cache entry to the console. */
  inspectCache: async (queryKey: readonly unknown[]): Promise<void> => {
    if (typeof __DEV__ !== "undefined" && !__DEV__) return;
    const storageKey = cacheKeyFor(queryKey);
    const entry = await readCache<any>(storageKey, queryKey);
    if (!entry) {
      console.log(`[SmartQuery Debug] Cache MISS for:`, queryKey);
      return;
    }
    console.log(`[SmartQuery Debug] Cache HIT for:`, queryKey, {
      cachedAt: new Date(entry.cachedAt).toISOString(),
      size: JSON.stringify(entry.data).length,
      data: entry.data,
    });
  },

  /** Clear the cache entry for a query key. */
  clearCache: async (queryKey: readonly unknown[]): Promise<void> => {
    if (typeof __DEV__ !== "undefined" && !__DEV__) return;
    const storageKey = cacheKeyFor(queryKey);
    const { deleteCache } = await import("../services/cache.service");
    await deleteCache(storageKey);
  },

  /** Get the current state of the offline mutation queue. */
  getQueue: async (): Promise<any[]> => {
    if (typeof __DEV__ !== "undefined" && !__DEV__) return [];
    try {
      const { getStorage } = await import("../services/storage.adapter");
      const raw = await getStorage().get("sq_mutation_queue");
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  },

  /** Get list of all storage keys currently being fetched. */
  inFlightRequests: (): string[] => {
    if (typeof __DEV__ !== "undefined" && !__DEV__) return [];
    try {
      const { inFlightKeys } = require("../services/requestLock.service");
      return inFlightKeys();
    } catch {
      return [];
    }
  },
};

/**
 * Executes multiple mutations in a single logical batch.
 * If the hook is unmounted, it performs a single storage write.
 */
export async function batchUpdate(
  queryKey: readonly unknown[],
  fn: (actions: SmartQueryActions<any>) => void | Promise<void>
): Promise<void> {
  const storageKey = cacheKeyFor(queryKey);
  const actions = getSmartQueryActions(queryKey);
  
  const live = liveRegistry.has(storageKey);
  if (live) {
    await fn(actions);
    return;
  }

  const config = sortConfigRegistry.get(storageKey);
  if (!config) return;

  const entry = await readCache<any>(storageKey, queryKey);
  if (!entry) return;

  let currentData = entry.data;
  const isUnified = "data" in currentData && "meta" in currentData;
  let currentList = isUnified ? currentData.data : (currentData as NormalizedList<any>);

  const batchActions: SmartQueryActions<any> = {
    isActive: () => false,
    addItem: async (item) => {
      currentList = normalizedAdd(currentList, item, config.getItemId, config.comparator);
    },
    updateItem: async (item) => {
      currentList = normalizedUpdate(currentList, item, config.getItemId, config.comparator);
    },
    removeItem: async (id) => {
      currentList = normalizedRemove(currentList, id);
    },
  };

  await fn(batchActions);

  const nextData = isUnified
    ? { ...currentData, data: currentList }
    : currentList;

  await writeCache(storageKey, nextData, queryKey);
}
