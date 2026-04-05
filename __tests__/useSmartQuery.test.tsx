/**
 * __tests__/useSmartQuery.test.tsx
 *
 * Comprehensive test suite for useSmartQuery.
 *
 * Covers:
 *   • Cache hit → serves stale data, fetches in background
 *   • Cache miss → isLoading true, fetch resolves
 *   • Smart diff → no rerender when data identical
 *   • addItem / updateItem / removeItem → sorted, O(1)
 *   • strictFreshness → blocks render until fresh fetch
 *   • onSuccess / onError callbacks
 *   • fallbackData → shown when fetch fails with no cache
 *   • Cache versioning → stale schema entry discarded
 *   • select transformer
 */

import React from "react";
import { renderHook, act, waitFor } from "@testing-library/react-native";
import {
  SmartQueryTestProvider,
  seedCache,
  clearTestCache,
  mockQueryFn,
  mockErrorFn,
  waitForCacheLoad,
} from "../src/testing";
import { useSmartQuery } from "../src/hooks/useSmartQuery";
import type { SmartQueryOptions } from "../src/hooks/useSmartQuery";
import { CURRENT_CACHE_VERSION } from "../src/services/cache.service";
import { getStorage } from "../src/services/storage.adapter";

// ─── Test fixtures ────────────────────────────────────────────────────────────

interface Expense {
  id: string;
  amount: number;
  createdAt: number;
  updatedAt: number;
  [key: string]: any;
}

const makeExpense = (overrides: Partial<Expense> = {}): Expense => ({
  id: `exp_${Math.random().toString(36).slice(2, 8)}`,
  amount: 100,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
});

const TRIP_ID = "trip_1";
const QUERY_KEY = ["expenses", TRIP_ID] as const;

const byNewest = (a: Expense, b: Expense) => b.createdAt - a.createdAt;
const getId = (e: Expense) => e.id;

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(SmartQueryTestProvider, { children });
}

function useExpenses(
  queryFnOverride?: () => Promise<Expense[]>,
  extraOptions: Partial<SmartQueryOptions<Expense[], Expense[], Expense>> = {}
) {
  return useSmartQuery<Expense[], Expense[], Expense>({
    queryKey: QUERY_KEY,
    queryFn: queryFnOverride ?? mockQueryFn<Expense[]>([]),
    getItemId: getId,
    sortComparator: byNewest,
    cacheTtl: 5 * 60_000,
    ...extraOptions,
  } as any);
}

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeEach(async () => {
  await clearTestCache();
});

// ─── 1. Cache miss → isLoading ───────────────────────────────────────────────

describe("cache miss", () => {
  it("shows isLoading when no cache exists and fetch is pending", async () => {
    const expense = makeExpense();
    const { result } = renderHook(
      () => useExpenses(mockQueryFn([expense], 50)),
      { wrapper }
    );

    // Initially loading
    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeUndefined();

    // After fetch resolves
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data![0].id).toBe(expense.id);
  });
});

// ─── 2. Cache hit → SWR ───────────────────────────────────────────────────────

describe("cache hit (SWR)", () => {
  it("returns cached data instantly then updates from network", async () => {
    const cached = [makeExpense({ id: "cached_1", amount: 50 })];
    const fresh = [makeExpense({ id: "fresh_1", amount: 99 })];

    await seedCache(QUERY_KEY, cached);

    const { result } = renderHook(
      () => useExpenses(mockQueryFn(fresh, 20)),
      { wrapper }
    );

    await waitForCacheLoad();

    // Cache served immediately
    expect(result.current.isFromCache).toBe(true);
    expect(result.current.data![0].id).toBe("cached_1");

    // Fresh data replaces cache after fetch
    await waitFor(() => expect(result.current.isFromCache).toBe(false));
    expect(result.current.data![0].id).toBe("fresh_1");
  });
});

// ─── 3. Smart diff — no rerender on identical data ────────────────────────────

describe("smart diff", () => {
  it("does not rerender when fresh data is identical to cache", async () => {
    const items = [makeExpense({ id: "e1", updatedAt: 1000 })];
    await seedCache(QUERY_KEY, items);

    let renderCount = 0;
    const { result } = renderHook(
      () => {
        renderCount++;
        return useExpenses(mockQueryFn(items)); // exact same data
      },
      { wrapper }
    );

    await waitForCacheLoad();
    const rendersAfterCache = renderCount;

    // Wait for fetch to complete
    await waitFor(() => expect(result.current.isFetching).toBe(false));

    // No extra render triggered by identical fresh data
    expect(renderCount).toBe(rendersAfterCache);
  });
});

// ─── 4. addItem ───────────────────────────────────────────────────────────────

describe("addItem", () => {
  it("inserts item at the correct sorted position", async () => {
    const old = makeExpense({ id: "old", createdAt: 1000 });
    await seedCache(QUERY_KEY, [old]);

    const { result } = renderHook(() => useExpenses(), { wrapper });
    await waitForCacheLoad();

    const newer = makeExpense({ id: "newer", createdAt: 2000 });

    act(() => { result.current.addItem(newer); });

    expect(result.current.data![0].id).toBe("newer"); // newest first
    expect(result.current.data![1].id).toBe("old");
  });

  it("persists the addition to cache", async () => {
    const { result } = renderHook(() => useExpenses(), { wrapper });
    await waitForCacheLoad();

    const item = makeExpense({ id: "persisted" });
    act(() => { result.current.addItem(item); });

    // Read back from storage
    await waitFor(async () => {
      const storage = getStorage();
      const raw = await storage.get('sq2:["expenses","trip_1"]');
      expect(raw).toContain("persisted");
    });
  });
});

// ─── 5. updateItem ────────────────────────────────────────────────────────────

describe("updateItem", () => {
  it("updates item in place without full array replacement", async () => {
    const item = makeExpense({ id: "u1", amount: 100, createdAt: 1000 });
    await seedCache(QUERY_KEY, [item]);

    const { result } = renderHook(() => useExpenses(), { wrapper });
    await waitForCacheLoad();

    act(() => {
      result.current.updateItem({ ...item, amount: 999 });
    });

    expect(result.current.data![0].amount).toBe(999);
    expect(result.current.data).toHaveLength(1); // no duplicates
  });

  it("re-sorts item when sort key changes", async () => {
    const a = makeExpense({ id: "a", createdAt: 2000 });
    const b = makeExpense({ id: "b", createdAt: 1000 });
    await seedCache(QUERY_KEY, [a, b]);

    const { result } = renderHook(() => useExpenses(), { wrapper });
    await waitForCacheLoad();

    // Initial order: a(2000), b(1000)
    expect(result.current.data![0].id).toBe("a");

    // Update b to be newest
    act(() => {
      result.current.updateItem({ ...b, createdAt: 3000 });
    });

    expect(result.current.data![0].id).toBe("b");
    expect(result.current.data![1].id).toBe("a");
  });
});

// ─── 6. removeItem ────────────────────────────────────────────────────────────

describe("removeItem", () => {
  it("removes the item and does not leave holes", async () => {
    const a = makeExpense({ id: "a" });
    const b = makeExpense({ id: "b" });
    await seedCache(QUERY_KEY, [a, b]);

    const { result } = renderHook(() => useExpenses(), { wrapper });
    await waitForCacheLoad();

    act(() => { result.current.removeItem("a"); });

    expect(result.current.data).toHaveLength(1);
    expect(result.current.data![0].id).toBe("b");
  });

  it("is a noop when id does not exist", async () => {
    const item = makeExpense({ id: "exists" });
    await seedCache(QUERY_KEY, [item]);

    const { result } = renderHook(() => useExpenses(), { wrapper });
    await waitForCacheLoad();

    act(() => { result.current.removeItem("does_not_exist"); });

    expect(result.current.data).toHaveLength(1);
  });
});

// ─── 7. select transformer ────────────────────────────────────────────────────

describe("select", () => {
  it("transforms the raw API response before exposing to the component", async () => {
    type RawResponse = { items: Expense[]; total: number };

    const raw: RawResponse = {
      items: [makeExpense({ id: "sel_1" })],
      total: 1,
    };

    const { result } = renderHook(
      () =>
        useSmartQuery<RawResponse, Expense[], Expense>({
          queryKey: QUERY_KEY,
          queryFn: mockQueryFn(raw),
          select: (r) => r.items,
          getItemId: getId,
          sortComparator: byNewest,
        }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(result.current.data![0].id).toBe("sel_1");
  });
});

// ─── 8. onSuccess callback ────────────────────────────────────────────────────

describe("onSuccess", () => {
  it("calls onSuccess with the transformed data after a successful fetch", async () => {
    const items = [makeExpense()];
    const onSuccess = jest.fn();

    const { result } = renderHook(
      () => useExpenses(mockQueryFn(items), { onSuccess }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(onSuccess).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ id: items[0].id }),
    ]));
  });
});

// ─── 9. onError + fallbackData ────────────────────────────────────────────────

describe("error handling", () => {
  it("sets structured error when fetch fails", async () => {
    const { result } = renderHook(
      () => useExpenses(mockErrorFn(new Error("Network failure"))),
      { wrapper }
    );

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error!.message).toBe("Network failure");
    expect(typeof result.current.error!.retryable).toBe("boolean");
  });

  it("shows fallbackData when fetch fails and there is no cache", async () => {
    const fallback = [makeExpense({ id: "fallback" })];

    const { result } = renderHook(
      () =>
        useExpenses(mockErrorFn(new Error("offline")), {
          fallbackData: fallback,
        }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.data![0].id).toBe("fallback");
  });

  it("calls onError and can suppress the error from the result", async () => {
    const onError = jest.fn().mockReturnValue(true); // suppress

    const { result } = renderHook(
      () => useExpenses(mockErrorFn(new Error("suppressed")), { onError }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull(); // suppressed
  });
});

// ─── 10. strictFreshness ─────────────────────────────────────────────────────

describe("strictFreshness", () => {
  it("does not serve stale cache when strictFreshness is true", async () => {
    // Seed with data that was cached 10 minutes ago (older than default TTL)
    const stale = [makeExpense({ id: "stale" })];
    const key = 'sq2:["expenses","trip_1"]';
    const staleEntry = JSON.stringify({
      version: CURRENT_CACHE_VERSION,
      data: stale,
      cachedAt: Date.now() - 10 * 60_000,
      lastAccessedAt: Date.now(),
    });
    await getStorage().set(key, staleEntry);

    const fresh = [makeExpense({ id: "fresh" })];

    const { result } = renderHook(
      () =>
        useExpenses(mockQueryFn(fresh, 10), {
          strictFreshness: true,
          cacheTtl: 5 * 60_000,
        }),
      { wrapper }
    );

    // Should NOT show stale cache
    await waitForCacheLoad();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data![0].id).toBe("fresh");
  });
});

// ─── 11. Cache versioning ─────────────────────────────────────────────────────

describe("cache versioning", () => {
  it("discards a cached entry with an old version number", async () => {
    // Manually write an entry with an old version
    const key = 'sq2:["expenses","trip_1"]';
    const oldEntry = JSON.stringify({
      version: 0, // outdated
      data: [makeExpense({ id: "old_schema" })],
      cachedAt: Date.now(),
      lastAccessedAt: Date.now(),
    });
    await getStorage().set(key, oldEntry);

    const fresh = [makeExpense({ id: "new_schema" })];

    const { result } = renderHook(
      () => useExpenses(mockQueryFn(fresh)),
      { wrapper }
    );

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    // Old entry discarded — only fresh data shown
    expect(result.current.data![0].id).toBe("new_schema");
  });
});
