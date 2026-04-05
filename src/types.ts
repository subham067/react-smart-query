/**
 * src/types.ts
 *
 * Single source of truth for all shared public types.
 * No implementation logic — pure TypeScript interfaces and type aliases.
 */

// ─── Core item contract ───────────────────────────────────────────────────────

/**
 * Minimum shape required for list items.
 * The actual id field name is configured via `getItemId` — this type
 * only enforces that items are plain objects.
 */
export type AnyItem = Record<string, unknown>;

/**
 * Extracts the id of an item. Configurable so APIs using `_id`, `uuid`,
 * numeric ids, or composite keys all work without data transformation.
 *
 * @example
 *   getItemId: (item) => item.id          // "id: string"
 *   getItemId: (item) => String(item._id) // MongoDB ObjectId
 *   getItemId: (item) => String(item.id)  // numeric id
 */
export type GetItemId<T extends AnyItem> = (item: T) => string;

/**
 * Comparator for sort order. Same contract as Array.sort comparator.
 * Return negative if a < b, positive if a > b, 0 if equal.
 */
export type SortComparator<T extends AnyItem> = (a: T, b: T) => number;

/**
 * Extracts a version sticker (timestamp or counter) from an item.
 * Used to prevent stale updates from overwriting fresher data.
 */
export type GetItemVersion<T extends AnyItem> = (item: T) => number | string;

// ─── Cache ────────────────────────────────────────────────────────────────────

export interface CacheEntry<T> {
  readonly version: number;
  readonly data: T;
  readonly cachedAt: number;
  readonly lastAccessedAt: number; // for LRU eviction
}

// ─── Normalized list ──────────────────────────────────────────────────────────

export interface NormalizedList<T extends AnyItem> {
  byId: Record<string, T>;
  allIds: string[];
}

// ─── Infinite list ────────────────────────────────────────────────────────────

export type PaginationMode = "normalized" | "pages";

export interface UnifiedNormalizedInfiniteData<T extends AnyItem> {
  data: NormalizedList<T>;
  meta: {
    nextCursor: unknown | null;
    pageParams: unknown[];
    lastFetchedAt?: number;
  };
}

/** Legacy support - will be used internally or for migration if needed */
export interface InfinitePagedData<T extends AnyItem> {
  pages: NormalizedList<T>[];
  pageParams: unknown[];
  nextCursor: unknown | null;
}

// ─── Observability ────────────────────────────────────────────────────────────

export type ObservabilityEvent =
  | { type: "cache_hit";   queryKey: readonly unknown[]; cachedAt: number }
  | { type: "cache_miss";  queryKey: readonly unknown[] }
  | { type: "cache_write"; queryKey: readonly unknown[]; dataSize: number }
  | { type: "fetch_start"; queryKey: readonly unknown[] }
  | { type: "fetch_success"; queryKey: readonly unknown[]; durationMs: number }
  | { type: "fetch_error";   queryKey: readonly unknown[]; error: unknown }
  | { type: "queue_enqueue"; mutationId: string; mutationType: string }
  | { type: "queue_success"; mutationId: string }
  | { type: "queue_failure"; mutationId: string; retryCount: number }
  | { type: "queue_drained" }
  | { type: "sync_conflict"; queryKey: readonly unknown[]; localVersion: unknown; serverVersion: unknown }
  | { type: "storage_quota_exceeded"; key: string };

export type ObserverFn = (event: ObservabilityEvent) => void;

// ─── Mutation queue ───────────────────────────────────────────────────────────

export type MutationType = "ADD_ITEM" | "UPDATE_ITEM" | "REMOVE_ITEM" | "CUSTOM";

export interface QueuedMutation<TPayload = unknown> {
  id: string;
  type: MutationType | string;
  /** Logical entity key for coalescing — e.g. "expense:exp_123" */
  entityKey?: string;
  queryKey: readonly unknown[];
  payload: TPayload;
  enqueuedAt: number;
  retryCount: number;
  maxRetries: number;
  nextRetryAt: number;
}

// ─── Error handling ───────────────────────────────────────────────────────────

export interface SmartQueryError {
  /** Original error from the API / network */
  cause: unknown;
  /** Human-readable message */
  message: string;
  /** Whether this error is retryable */
  retryable: boolean;
  /** HTTP status code if available */
  statusCode?: number;
}

// ─── Storage ──────────────────────────────────────────────────────────────────

export interface AsyncStorage {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  clearAll(): Promise<void>;
  keys(): Promise<string[]>;
}
