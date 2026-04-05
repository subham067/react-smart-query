/**
 * src/services/cache.service.ts
 *
 * Versioned, LRU-aware cache layer.
 *
 * Features:
 *   • Schema versioning — auto-invalidates stale entries on version bump
 *   • lastAccessedAt tracking — enables LRU eviction
 *   • Configurable max entries per prefix — prevents unbounded growth
 *   • Partial hydration — read a subset of a NormalizedList by ids
 *   • Observability events on hit / miss / write / quota exceeded
 */

import { getStorage } from "./storage.adapter";
import { emit } from "./observer.service";
import type { CacheEntry, NormalizedList, AnyItem } from "../types";

// ─── Versioning ───────────────────────────────────────────────────────────────

/**
 * Bump when CacheEntry shape or NormalizedList schema changes in a
 * breaking way. Any stored entry with a lower version is silently discarded.
 */
export const CURRENT_CACHE_VERSION = 2;

// ─── LRU config ───────────────────────────────────────────────────────────────

const DEFAULT_MAX_ENTRIES = 200;
let _maxEntries = DEFAULT_MAX_ENTRIES;

/** Override the global max entries limit (call before any reads/writes) */
export function setMaxCacheEntries(n: number): void {
  _maxEntries = n;
}

// ─── Key derivation ───────────────────────────────────────────────────────────

export function cacheKeyFor(queryKey: readonly unknown[]): string {
  return `sq2:${JSON.stringify(queryKey)}`;
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function readCache<T>(
  key: string,
  queryKey?: readonly unknown[]
): Promise<CacheEntry<T> | null> {
  try {
    const storage = getStorage();
    const raw = await storage.get(key);

    if (!raw) {
      if (queryKey) emit({ type: "cache_miss", queryKey });
      return null;
    }

    const entry = JSON.parse(raw) as CacheEntry<T>;

    if (entry.version !== CURRENT_CACHE_VERSION) {
      void storage.delete(key);
      if (queryKey) emit({ type: "cache_miss", queryKey });
      return null;
    }

    // Touch lastAccessedAt for LRU — fire-and-forget, non-blocking
    void storage.set(
      key,
      JSON.stringify({ ...entry, lastAccessedAt: Date.now() })
    );

    if (queryKey) emit({ type: "cache_hit", queryKey, cachedAt: entry.cachedAt });
    return entry;
  } catch {
    return null;
  }
}

// ─── Write ────────────────────────────────────────────────────────────────────

export async function writeCache<T>(
  key: string,
  data: T,
  queryKey?: readonly unknown[]
): Promise<void> {
  try {
    const storage = getStorage();
    const now = Date.now();
    const entry: CacheEntry<T> = {
      version: CURRENT_CACHE_VERSION,
      data,
      cachedAt: now,
      lastAccessedAt: now,
    };

    const serialized = JSON.stringify(entry);

    try {
      await storage.set(key, serialized);
      if (queryKey) {
        emit({ type: "cache_write", queryKey, dataSize: serialized.length });
      }
    } catch (quotaErr) {
      emit({ type: "storage_quota_exceeded", key });
      // Attempt LRU eviction then retry once
      await evictLRUEntries();
      await storage.set(key, serialized);
    }

    // Async LRU check — doesn't block the write
    void checkAndEvict();
  } catch {
    // Fail silently — a cache write failure must never crash the app
  }
}

// ─── Delete ───────────────────────────────────────────────────────────────────

export async function deleteCache(key: string): Promise<void> {
  try {
    await getStorage().delete(key);
  } catch {}
}

// ─── LRU eviction ─────────────────────────────────────────────────────────────

interface LRUMeta {
  key: string;
  lastAccessedAt: number;
}

async function checkAndEvict(): Promise<void> {
  const storage = getStorage();
  const allKeys = await storage.keys();
  const sqKeys = allKeys.filter((k) => k.startsWith("sq2:"));

  if (sqKeys.length <= _maxEntries) return;

  await evictLRUEntries(sqKeys);
}

async function evictLRUEntries(sqKeys?: string[]): Promise<void> {
  const storage = getStorage();
  const keys = sqKeys ?? (await storage.keys()).filter((k) => k.startsWith("sq2:"));

  // Read lastAccessedAt for each entry — lightweight parse
  const metas: LRUMeta[] = [];
  await Promise.all(
    keys.map(async (key) => {
      try {
        const raw = await storage.get(key);
        if (!raw) return;
        const parsed = JSON.parse(raw) as Partial<CacheEntry<unknown>>;
        metas.push({ key, lastAccessedAt: parsed.lastAccessedAt ?? 0 });
      } catch {}
    })
  );

  // Sort oldest-first and evict the bottom 20%
  metas.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
  const evictCount = Math.max(1, Math.floor(metas.length * 0.2));
  const toEvict = metas.slice(0, evictCount);

  await Promise.all(toEvict.map(({ key }) => storage.delete(key)));
}

// ─── Partial hydration ────────────────────────────────────────────────────────

/**
 * Read a subset of a NormalizedList cache entry by item ids.
 *
 * Use for pagination, lazy loading, or detail views that only need
 * a handful of items from a large cached list.
 *
 * @returns null if the cache entry doesn't exist.
 *          Empty array if none of the requested ids are cached.
 *
 * @example
 *   const items = await getPartialCache<Expense>(
 *     cacheKeyFor(["expenses", tripId]),
 *     ["exp_1", "exp_2"]
 *   );
 */
export async function getPartialCache<T extends AnyItem>(
  key: string,
  ids: string[]
): Promise<T[] | null> {
  const entry = await readCache<NormalizedList<T>>(key);
  if (!entry) return null;

  const { byId } = entry.data;
  const result: T[] = [];
  for (const id of ids) {
    if (id in byId) result.push(byId[id]);
  }
  return result;
}

// ─── TTL check ────────────────────────────────────────────────────────────────

export function isCacheStale(entry: CacheEntry<unknown>, ttlMs: number): boolean {
  return Date.now() - entry.cachedAt > ttlMs;
}
