# Best Practices & Guidelines

To get the most out of `react-smart-query`, follow these architectural guidelines.

## 1. Always provide an ID and a Sort Comparator
When using `useInfiniteSmartQuery`, `getItemId` and `sortComparator` are critical. Even if your API returns items in perfect order, the sort comparator is how `react-smart-query` knows where to insert *optimistic or newly added offline items*.

```typescript
// Good
sortComparator: (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
```

## 2. Leverage Background Fetch Guards
`react-smart-query` protects local mutations. If you add an item locally, and a subsequent background refetch (from `react-query`) does *not* contain that item, it won't be deleted if it was created locally within the guard window (default 5 minutes).

## 3. Keep Cache Keys Consistent
Use strongly typed cache keys or leverage `createTypedQuery` to ensure your keys match exactly across your application. Normalization ties items to keys; a typo in a key implies an entirely separate data store.

## 4. Handle Offline Sync Gracefully
The queue processes mutations automatically when the device comes online. Ensure your `mutationFn` in `useSmartMutation` is robust enough to handle data that might be slightly stale.

## 5. Don't Store Enormous Lists Indefinitely
The library automatically applies a soft trim when lists exceed a certain threshold to prevent memory bloat, but avoid querying 10,000 items in a single non-paginated `useSmartQuery`.
