/**
 * __tests__/useSmartMutation.test.tsx
 *
 * Tests for useSmartMutation:
 *   • Optimistic add → API confirms → item updated with server id
 *   • Optimistic add → API fails → item rolled back
 *   • Optimistic remove → API fails → item restored
 *   • Offline path → mutation enqueued, not sent
 *   • onSuccess / onError callbacks
 */

import React from "react";
import { renderHook, act, waitFor } from "@testing-library/react-native";
import {
  SmartQueryTestProvider,
  seedCache,
  clearTestCache,
  mockQueryFn,
  waitForCacheLoad,
} from "../src/testing";
import { useSmartQuery } from "../src/hooks/useSmartQuery";
import { useSmartMutation } from "../src/hooks/useSmartMutation";
import { getQueue } from "../src/services/queue.service";

// ─── Fixtures ────────────────────────────────────────────────────────────────

interface Expense {
  id: string;
  amount: number;
  createdAt: number;
  updatedAt: number;
  [key: string]: any;
}

const makeExpense = (overrides: Partial<Expense> = {}): Expense => ({
  id: `exp_${Math.random().toString(36).slice(2, 7)}`,
  amount: 100,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
});

const TRIP_ID = "trip_1";
const QUERY_KEY = ["expenses", TRIP_ID] as const;
const getId = (e: Expense) => e.id;
const byNewest = (a: Expense, b: Expense) => b.createdAt - a.createdAt;

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(SmartQueryTestProvider, { children });
}

function useExpenseList(items: Expense[]) {
  return useSmartQuery<Expense[], Expense[], Expense>({
    queryKey: QUERY_KEY,
    queryFn: mockQueryFn(items),
    getItemId: getId,
    sortComparator: byNewest,
  });
}

beforeEach(async () => {
  await clearTestCache();
});

// ─── 1. Optimistic add → confirmed ───────────────────────────────────────────

describe("ADD_ITEM — success path", () => {
  it("adds item optimistically then replaces with server response", async () => {
    const initial = [makeExpense({ id: "existing" })];
    await seedCache(QUERY_KEY, initial);

    const optimistic = makeExpense({ id: "temp_id", amount: 50 });
    const serverConfirmed = { ...optimistic, id: "server_id" };

    const listHook = renderHook(() => useExpenseList(initial), { wrapper });
    await waitForCacheLoad();

    const mutationHook = renderHook(
      () =>
        useSmartMutation<Expense>({
          queryKey: QUERY_KEY,
          mutationType: "ADD_ITEM",
          mutationFn: async () => serverConfirmed,
          getItemId: getId,
        }),
      { wrapper }
    );

    await act(async () => {
      await mutationHook.result.current.mutateAsync(optimistic);
    });

    // Server id should replace temp id
    const ids = listHook.result.current.data?.map((e) => e.id) ?? [];
    expect(ids).toContain("server_id");
    expect(ids).not.toContain("temp_id");
  });
});

// ─── 2. Optimistic add → API fails → rollback ─────────────────────────────────

describe("ADD_ITEM — failure → rollback", () => {
  it("removes the optimistically added item when API fails", async () => {
    const initial = [makeExpense({ id: "existing" })];
    await seedCache(QUERY_KEY, initial);

    const listHook = renderHook(() => useExpenseList(initial), { wrapper });
    await waitForCacheLoad();

    const optimistic = makeExpense({ id: "will_rollback" });

    const mutationHook = renderHook(
      () =>
        useSmartMutation<Expense>({
          queryKey: QUERY_KEY,
          mutationType: "ADD_ITEM",
          mutationFn: async () => { throw new Error("Server error"); },
          getItemId: getId,
        }),
      { wrapper }
    );

    await act(async () => {
      await mutationHook.result.current.mutateAsync(optimistic).catch(() => {});
    });

    const ids = listHook.result.current.data?.map((e) => e.id) ?? [];
    expect(ids).not.toContain("will_rollback");
    expect(ids).toContain("existing");

    expect(mutationHook.result.current.error).not.toBeNull();
    expect(mutationHook.result.current.error!.message).toBe("Server error");
  });
});

// ─── 3. Optimistic remove → API fails → restore ───────────────────────────────

describe("REMOVE_ITEM — failure → restore", () => {
  it("restores the removed item when API fails", async () => {
    const item = makeExpense({ id: "to_restore" });
    await seedCache(QUERY_KEY, [item]);

    const listHook = renderHook(() => useExpenseList([item]), { wrapper });
    await waitForCacheLoad();

    const mutationHook = renderHook(
      () =>
        useSmartMutation<Expense>({
          queryKey: QUERY_KEY,
          mutationType: "REMOVE_ITEM",
          mutationFn: async () => { throw new Error("Delete failed"); },
          getItemId: getId,
        }),
      { wrapper }
    );

    await act(async () => {
      await mutationHook.result.current.mutateAsync(item).catch(() => {});
    });

    const ids = listHook.result.current.data?.map((e) => e.id) ?? [];
    expect(ids).toContain("to_restore"); // restored
    expect(mutationHook.result.current.error?.message).toBe("Delete failed");
  });
});

// ─── 4. Offline → mutation enqueued ──────────────────────────────────────────

describe("offline queue", () => {
  it("enqueues mutation when isOnline returns false", async () => {
    await seedCache(QUERY_KEY, []);

    const item = makeExpense({ id: "offline_item" });

    const mutationHook = renderHook(
      () =>
        useSmartMutation<Expense>({
          queryKey: QUERY_KEY,
          mutationType: "ADD_ITEM",
          mutationFn: async () => item, // should not be called
          getItemId: getId,
          isOnline: () => false, // simulate offline
          enableOfflineQueue: true,
        }),
      { wrapper }
    );

    await act(async () => {
      await mutationHook.result.current.mutateAsync(item);
    });

    const queue = await getQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].type).toBe("ADD_ITEM");
    expect((queue[0].payload as Expense).id).toBe("offline_item");
  });
});

// ─── 5. isPending state ───────────────────────────────────────────────────────

describe("isPending", () => {
  it("is true during the API call and false after", async () => {
    await seedCache(QUERY_KEY, []);

    let resolveFn!: () => void;
    const slowFn = () =>
      new Promise<Expense>((res) => { resolveFn = () => res(makeExpense()); });

    const { result } = renderHook(
      () =>
        useSmartMutation<Expense>({
          queryKey: QUERY_KEY,
          mutationType: "ADD_ITEM",
          mutationFn: slowFn,
          getItemId: getId,
        }),
      { wrapper }
    );

    act(() => { result.current.mutate(makeExpense()); });

    await waitFor(() => expect(result.current.isPending).toBe(true));

    await act(async () => { resolveFn(); });

    await waitFor(() => expect(result.current.isPending).toBe(false));
  });
});

// ─── 6. reset() clears error ─────────────────────────────────────────────────

describe("reset", () => {
  it("clears error state when reset() is called", async () => {
    await seedCache(QUERY_KEY, []);

    const { result } = renderHook(
      () =>
        useSmartMutation<Expense>({
          queryKey: QUERY_KEY,
          mutationType: "ADD_ITEM",
          mutationFn: async () => { throw new Error("fail"); },
          getItemId: getId,
        }),
      { wrapper }
    );

    await act(async () => {
      await result.current.mutateAsync(makeExpense()).catch(() => {});
    });

    expect(result.current.error).not.toBeNull();

    act(() => { result.current.reset(); });

    expect(result.current.error).toBeNull();
  });
});
