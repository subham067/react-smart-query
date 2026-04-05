/**
 * src/factory/createTypedQuery.ts
 *
 * Type-safe query factory — inspired by tRPC's router pattern.
 *
 * Problem:
 *   getSmartQueryActions<Expense>(["expenses", tripId]) — the Expense type
 *   is not connected to the queryKey. You can pass the wrong type silently.
 *   Every call site must repeat the type annotation and queryFn.
 *
 * Solution:
 *   Define the query once at module level (queryKey shape + queryFn + config).
 *   Call sites get pre-typed hooks and actions with full inference.
 *
 * @example
 *   // Define once (e.g. src/queries/expense.query.ts)
 *   export const expenseQuery = createTypedQuery({
 *     queryKey: (tripId: string) => ["expenses", tripId] as const,
 *     queryFn: (tripId: string) =>
 *       api.get(`/trips/${tripId}/expenses`).then((r) => r.data as Expense[]),
 *     getItemId: (e: Expense) => e.id,
 *     sortComparator: (a: Expense, b: Expense) => b.createdAt - a.createdAt,
 *     cacheTtl: 5 * 60_000,
 *   });
 *
 *   // Use anywhere — fully typed, no annotation needed
 *   const { data, addItem } = expenseQuery.useQuery(tripId);
 *   const actions = expenseQuery.getActions(tripId);
 *   await actions.addItem(newExpense); // TItem = Expense — inferred!
 */

import { useSmartQuery, SmartQueryOptions, SmartQueryResult } from "../hooks/useSmartQuery";
import { useSmartMutation, SmartMutationOptions, SmartMutationResult } from "../hooks/useSmartMutation";
import { getSmartQueryActions, SmartQueryActions } from "../registry/smartQueryRegistry";
import { invalidateSmartCache } from "../hooks/useSmartQuery";
import type { AnyItem, GetItemId, SortComparator } from "../types";

// ─── Types ────────────────────────────────────────────────────────────────────

type AnyArgs = readonly unknown[];

export interface TypedQueryDefinition<
  TArgs extends AnyArgs,
  TRaw,
  TData,
  TItem extends AnyItem = TData extends AnyItem[] ? TData[number] : AnyItem
> {
  /**
   * Pre-typed useSmartQuery hook.
   * Pass the same args you defined in `queryKey(args)`.
   */
  useQuery(
    ...args: TArgs
  ): SmartQueryResult<TData, TItem>;

  /**
   * Pre-typed useSmartMutation hook.
   * Requires only the mutation-specific options (queryKey is pre-filled).
   */
  useMutation(
    ...args: [...TArgs, Omit<SmartMutationOptions<TItem>, "queryKey" | "getItemId">]
  ): SmartMutationResult<TItem>;

  /**
   * Get pre-typed global actions for this query key.
   * Call from anywhere — no React required.
   */
  getActions(...args: TArgs): SmartQueryActions<TItem>;

  /** Invalidate this query's cache entry */
  invalidate(...args: TArgs): Promise<void>;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export interface CreateTypedQueryConfig<
  TArgs extends AnyArgs,
  TRaw,
  TData,
  TItem extends AnyItem = TData extends AnyItem[] ? TData[number] : AnyItem
> {
  /** Build the query key array from args */
  queryKey(...args: TArgs): readonly unknown[];

  /** Async function that fetches data — receives the same args */
  queryFn(...args: TArgs): Promise<TRaw>;

  /** Transform raw response (optional) */
  select?: (raw: TRaw) => TData;

  /** Required for list queries */
  getItemId?: TData extends AnyItem[] ? GetItemId<TItem> : never;

  /** Required for list queries */
  sortComparator?: TData extends AnyItem[] ? SortComparator<TItem> : never;

  cacheTtl?: number;
  strictFreshness?: boolean;

  /** Extra SmartQueryOptions applied to every call */
  defaultOptions?: Partial<SmartQueryOptions<TRaw, TData, TItem>>;
}

/**
 * Create a type-safe query definition.
 * Returns a typed query object with useQuery, useMutation, getActions, invalidate.
 */
export function createTypedQuery<
  TArgs extends AnyArgs,
  TRaw,
  TData,
  TItem extends AnyItem = TData extends AnyItem[] ? TData[number] : AnyItem
>(
  config: CreateTypedQueryConfig<TArgs, TRaw, TData, TItem>
): TypedQueryDefinition<TArgs, TRaw, TData, TItem> {
  return {
    useQuery(...args: TArgs) {
      const qk = config.queryKey(...args);
      // eslint-disable-next-line react-hooks/rules-of-hooks
      return useSmartQuery<TRaw, TData, TItem>({
        queryKey: qk,
        queryFn: () => config.queryFn(...args),
        select: config.select,
        getItemId: config.getItemId,
        sortComparator: config.sortComparator,
        cacheTtl: config.cacheTtl,
        strictFreshness: config.strictFreshness,
        ...config.defaultOptions,
      });
    },

    useMutation(
      ...argsAndOptions: [...TArgs, Omit<SmartMutationOptions<TItem>, "queryKey" | "getItemId">]
    ) {
      const mutationOptions = argsAndOptions[argsAndOptions.length - 1] as Omit<
        SmartMutationOptions<TItem>,
        "queryKey" | "getItemId"
      >;
      const args = argsAndOptions.slice(0, -1) as unknown as TArgs;
      const qk = config.queryKey(...args);

      if (!config.getItemId) {
        throw new Error(
          "[SmartQuery] useMutation requires getItemId to be defined in createTypedQuery"
        );
      }

      // eslint-disable-next-line react-hooks/rules-of-hooks
      return useSmartMutation<TItem>({
        queryKey: qk,
        getItemId: config.getItemId as GetItemId<TItem>,
        ...mutationOptions,
      });
    },

    getActions(...args: TArgs): SmartQueryActions<TItem> {
      const qk = config.queryKey(...args);
      return getSmartQueryActions<TItem>(qk);
    },

    invalidate(...args: TArgs): Promise<void> {
      const qk = config.queryKey(...args);
      return invalidateSmartCache(qk);
    },
  };
}
