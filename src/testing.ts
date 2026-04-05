/**
 * src/testing.ts
 *
 * Test utilities for SmartQuery.
 *
 * Provides:
 *   • SmartQueryTestProvider  — wraps components with all required context
 *   • createMockStorage       — in-memory AsyncStorage (no MMKV, no IDB)
 *   • seedCache               — pre-populate cache before rendering
 *   • clearTestCache          — reset between tests
 *   • waitForCacheLoad        — await the initial async cache read
 *
 * Works with Jest, Vitest, and React Native Testing Library.
 *
 * @example
 *   import { render } from "@testing-library/react-native";
 *   import { SmartQueryTestProvider, seedCache } from "smart-query/testing";
 *
 *   beforeEach(() => seedCache(["expenses", "trip_1"], mockExpenses));
 *
 *   it("renders cached expenses", async () => {
 *     const { findAllByTestId } = render(
 *       <SmartQueryTestProvider>
 *         <ExpenseList tripId="trip_1" />
 *       </SmartQueryTestProvider>
 *     );
 *     const rows = await findAllByTestId("expense-row");
 *     expect(rows).toHaveLength(mockExpenses.length);
 *   });
 */

import React, { ReactNode, useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { _setStorageOverride } from "./services/storage.adapter";
import { writeCache, cacheKeyFor } from "./services/cache.service";
import type { AsyncStorage, AnyItem } from "./types";

// ─── In-memory storage ────────────────────────────────────────────────────────

export function createMockStorage(): AsyncStorage {
  const store = new Map<string, string>();
  return {
    get: (key) => Promise.resolve(store.get(key)),
    set: (key, value) => { store.set(key, value); return Promise.resolve(); },
    delete: (key) => { store.delete(key); return Promise.resolve(); },
    clearAll: () => { store.clear(); return Promise.resolve(); },
    keys: () => Promise.resolve(Array.from(store.keys())),
  };
}

// Module-level mock storage used by all test utilities
let _mockStorage: AsyncStorage | null = null;

function ensureMockStorage(): AsyncStorage {
  if (!_mockStorage) {
    _mockStorage = createMockStorage();
    _setStorageOverride(_mockStorage);
  }
  return _mockStorage;
}

// ─── SmartQueryTestProvider ───────────────────────────────────────────────────

interface TestProviderProps {
  children: ReactNode;
  /** Override the QueryClient (e.g. to set custom defaults) */
  queryClient?: QueryClient;
}

/**
 * Wrap your component tree in tests.
 * Automatically uses in-memory storage — no MMKV, no IndexedDB required.
 */
export function SmartQueryTestProvider({
  children,
  queryClient,
}: TestProviderProps): React.ReactElement {
  const client = queryClient ?? new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: Infinity,
      },
    },
  });

  useEffect(() => {
    ensureMockStorage();
    return () => {
      // Clean up override after the test
      _setStorageOverride(null);
      _mockStorage = null;
    };
  }, []);

  return React.createElement(
    QueryClientProvider,
    { client },
    children
  );
}

// ─── Cache seeding ────────────────────────────────────────────────────────────

/**
 * Pre-populate the cache before rendering a component.
 * Must be called before rendering (not inside a component).
 *
 * @example
 *   beforeEach(() => seedCache(["expenses", "trip_1"], mockExpenses));
 */
export async function seedCache<T>(
  queryKey: readonly unknown[],
  data: T
): Promise<void> {
  ensureMockStorage();
  const key = cacheKeyFor(queryKey);
  await writeCache(key, data);
}

/**
 * Clear all test cache entries between tests.
 *
 * @example
 *   afterEach(() => clearTestCache());
 */
export async function clearTestCache(): Promise<void> {
  await ensureMockStorage().clearAll();
}

/**
 * Wait for the initial cache read to complete.
 * Useful when you need to assert on cached data immediately after render.
 *
 * @example
 *   const { getByText } = render(<MyComponent />);
 *   await waitForCacheLoad();
 *   expect(getByText("Expense 1")).toBeTruthy();
 */
export function waitForCacheLoad(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Mock query factory ───────────────────────────────────────────────────────

/**
 * Create a mock queryFn that resolves with the provided data.
 * Use to test loading → success transitions.
 *
 * @example
 *   queryFn: mockQueryFn(mockExpenses, 100) // resolves after 100ms
 */
export function mockQueryFn<T>(data: T, delayMs = 0): () => Promise<T> {
  return () =>
    new Promise((resolve) => setTimeout(() => resolve(data), delayMs));
}

/**
 * Create a mock queryFn that rejects with the provided error.
 * Use to test error states.
 *
 * @example
 *   queryFn: mockErrorFn(new Error("Network error"))
 */
export function mockErrorFn(error: Error, delayMs = 0): () => Promise<never> {
  return () =>
    new Promise((_, reject) => setTimeout(() => reject(error), delayMs));
}
