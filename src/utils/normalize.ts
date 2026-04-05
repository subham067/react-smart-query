/**
 * src/utils/normalize.ts
 *
 * NormalizedList — O(1) lookup, O(log n) sorted mutations.
 *
 * The `getItemId` function is passed explicitly — no hardcoded field name.
 * This lets you use `_id`, `uuid`, numeric ids, or composite keys.
 */

import type { AnyItem, GetItemId, GetItemVersion, NormalizedList, SortComparator } from "../types";

export type { NormalizedList };

// ─── Constructors ─────────────────────────────────────────────────────────────

export function emptyList<T extends AnyItem>(): NormalizedList<T> {
  return { byId: Object.create(null) as Record<string, T>, allIds: [] };
}

export function fromArray<T extends AnyItem>(
  items: T[],
  getItemId: GetItemId<T>,
  comparator?: SortComparator<T>
): NormalizedList<T> {
  const byId: Record<string, T> = Object.create(null);
  const allIds: string[] = new Array(items.length);

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const id = getItemId(item);
    byId[id] = item;
    allIds[i] = id;
  }

  if (comparator) allIds.sort((a, b) => comparator(byId[a], byId[b]));

  return { byId, allIds };
}

export function toArray<T extends AnyItem>(list: NormalizedList<T>): T[] {
  const out = new Array<T>(list.allIds.length);
  for (let i = 0; i < list.allIds.length; i++) out[i] = list.byId[list.allIds[i]];
  return out;
}

// ─── Binary search ────────────────────────────────────────────────────────────

function binaryIdx<T extends AnyItem>(
  allIds: string[],
  byId: Record<string, T>,
  item: T,
  getItemId: GetItemId<T>,
  cmp: SortComparator<T>
): number {
  const itemId = getItemId(item);
  let lo = 0, hi = allIds.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const midItem = byId[allIds[mid]];
    let res = cmp(midItem, item);

    // Tie-breaker for stable sorting
    if (res === 0) {
      res = allIds[mid].localeCompare(itemId);
    }

    res <= 0 ? (lo = mid + 1) : (hi = mid);
  }
  return lo;
}

// ─── Mutations (all return new NormalizedList — immutable) ────────────────────

export function normalizedAdd<T extends AnyItem>(
  list: NormalizedList<T>,
  item: T,
  getItemId: GetItemId<T>,
  comparator: SortComparator<T>,
  getItemVersion?: GetItemVersion<T>
): NormalizedList<T> {
  const id = getItemId(item);
  const existing = list.byId[id];

  // Conflict protection: if item exists, check for staleness
  if (existing && getItemVersion) {
    const vExisting = getItemVersion(existing);
    const vNew = getItemVersion(item);
    if (vNew < vExisting) return list; // Ignore stale update
  }

  const newById = { ...list.byId, [id]: item };
  const existingIdx = list.allIds.indexOf(id);

  const workingIds = list.allIds.slice();
  if (existingIdx !== -1) workingIds.splice(existingIdx, 1);

  const insertIdx = binaryIdx(workingIds, newById, item, getItemId, comparator);
  workingIds.splice(insertIdx, 0, id);

  return { byId: newById, allIds: workingIds };
}

export function normalizedUpdate<T extends AnyItem>(
  list: NormalizedList<T>,
  item: T,
  getItemId: GetItemId<T>,
  comparator: SortComparator<T>,
  getItemVersion?: GetItemVersion<T>
): NormalizedList<T> {
  const id = getItemId(item);
  const oldItem = list.byId[id];

  if (!oldItem) return list;

  // Conflict protection: if item exists, check for staleness
  if (getItemVersion) {
    const vExisting = getItemVersion(oldItem);
    const vNew = getItemVersion(item);
    if (vNew < vExisting) return list; // Ignore stale update
  }

  // Optimization: If sort key is unchanged, simple in-place object substitution
  if (comparator(oldItem, item) === 0) {
    return {
      allIds: list.allIds, // Keep same reference if possible, but immutable is safer
      byId: { ...list.byId, [id]: item },
    };
  }

  // Otherwise, full re-sort/re-insert logic
  return normalizedAdd(list, item, getItemId, comparator, getItemVersion);
}

export function normalizedRemove<T extends AnyItem>(
  list: NormalizedList<T>,
  id: string
): NormalizedList<T> {
  if (!(id in list.byId)) return list;

  const newById = { ...list.byId };
  delete newById[id];

  const idx = list.allIds.indexOf(id);
  const newAllIds = list.allIds.slice();
  if (idx !== -1) newAllIds.splice(idx, 1);

  return { byId: newById, allIds: newAllIds };
}

/**
 * Merge new items into existing normalized list.
 * Handles deduplication and maintains sort order via binary search.
 */
export function mergeNormalizedData<T extends AnyItem>(
  existing: NormalizedList<T>,
  incomingIds: string[],
  incomingById: Record<string, T>,
  getItemId: GetItemId<T>,
  comparator?: SortComparator<T>
): NormalizedList<T> {
  const newById = { ...existing.byId, ...incomingById };
  const allIds = [...existing.allIds];
  const seen = new Set(existing.allIds);

  for (const id of incomingIds) {
    if (seen.has(id)) {
      // If already exists, we updated it in newById already via spread
      // We might need to re-sort if the item changed in a way that affects sort
      continue;
    }
    seen.add(id);
    if (comparator) {
      const item = incomingById[id];
      const insertIdx = binaryIdx(allIds, newById, item, getItemId, comparator);
      allIds.splice(insertIdx, 0, id);
    } else {
      allIds.push(id);
    }
  }

  // If comparator is provided, and we had existing items, 
  // we might need a full sort if updates changed the order.
  // For performance, we usually assume updates to existing items 
  // don't break sort order often, or we re-sort the whole thing if needed.
  if (comparator && incomingIds.some(id => existing.byId[id])) {
    allIds.sort((a, b) => comparator(newById[a], newById[b]));
  }

  return { byId: newById, allIds };
}

/**
 * Derive a single page of items from a normalized list.
 */
export function getPage<T extends AnyItem>(
  allIds: string[],
  byId: Record<string, T>,
  pageIndex: number,
  pageSize: number
): T[] {
  const start = pageIndex * pageSize;
  const ids = allIds.slice(start, start + pageSize);
  return ids.map(id => byId[id]);
}

/**
 * Derive all pages from a normalized list.
 */
export function derivePages<T extends AnyItem>(
  allIds: string[],
  byId: Record<string, T>,
  pageSize: number
): T[][] {
  const totalItems = allIds.length;
  const totalPages = Math.ceil(totalItems / pageSize);
  const pages: T[][] = [];

  for (let i = 0; i < totalPages; i++) {
    pages.push(getPage(allIds, byId, i, pageSize));
  }

  return pages;
}

export function isNormalizedEmpty<T extends AnyItem>(list: NormalizedList<T>): boolean {
  return list.allIds.length === 0;
}

/**
 * Soft Trim list to maxItems. 
 * Instead of a hard cut every time, we remove 20% of the oldest items
 * to avoid constant array slicing on every single insert.
 * Assumes list is already sorted.
 */
export function trimNormalizedList<T extends AnyItem>(
  list: NormalizedList<T>,
  maxItems: number
): NormalizedList<T> {
  if (list.allIds.length <= maxItems) return list;

  // Remove 20% of items or at least enough to get back under limit
  const removeCount = Math.max(
    Math.ceil(list.allIds.length * 0.2),
    list.allIds.length - maxItems
  );
  
  const newSize = list.allIds.length - removeCount;
  const newAllIds = list.allIds.slice(0, newSize);
  const newById: Record<string, T> = {};
  
  for (const id of newAllIds) {
    newById[id] = list.byId[id];
  }

  return { byId: newById, allIds: newAllIds };
}
