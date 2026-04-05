# React Smart Query Documentation

Welcome to the detailed documentation for `react-smart-query`. This library provides a robust, offline-first, normalized data orchestration layer tailored for React Native and Web applications, built on top of TanStack Query.

## Table of Contents

1. [Core Concepts](#core-concepts)
2. [Hooks API](#hooks-api)
   - [`useSmartQuery`](#usesmartquery)
   - [`useInfiniteSmartQuery`](#useinfinitesmartquery)
   - [`useSmartMutation`](#usesmartmutation)
   - [`useSmartQuerySelector`](#usesmartqueryselector)
3. [Factory API](#factory-api)
   - [`createTypedQuery`](#createtypedquery)
4. [Advanced Features](#advanced-features)
   - [Offline Queue](#offline-queue)
   - [Normalization & Cache](#normalization--cache)
   - [Debugging](#debugging)

---

## Core Concepts

### Normalization
Instead of keeping duplicate instances of data items in memory across different query responses (especially in paginated lists), `react-smart-query` stores data in a normalized cache (`byId` map and `allIds` array). This ensures that updates to an item in one place immediately reflect everywhere that item is rendered.

### Offline-First Architecture
Mutations made while the device is offline are pushed to a persistent queue. When the device regains connectivity, the queue is processed automatically, ensuring no data loss.

### Deterministic Sorting
For infinite lists, `react-smart-query` maintains a strictly ordered aggregate list (`allIds`). When new items are added, they are inserted using binary search (O(log n)), guaranteeing perfectly sorted lists without "flickering".

---

## Hooks API

### `useSmartQuery`
A drop-in enhancement for TanStack's `useQuery`. It seamlessly reads from and writes to the normalized store.

**Example Usage:**
```tsx
import { useSmartQuery } from 'react-smart-query';

const { data, isLoading, error } = useSmartQuery({
  queryKey: ['userProfile', userId],
  queryFn: () => fetchUserProfile(userId),
});
```

### `useInfiniteSmartQuery`
The flagship hook for handling paginated data. It abstracts away the complexity of infinite scrolling, normalization, and sorting.

**Key Props:**
- `queryKey`: Unique identifier for the query.
- `queryFn`: Function to fetch a page of data.
- `getNextCursor`: Function to extract the next page token from a response.
- `getItemId`: Function extracting a unique ID from an item.
- `sortComparator`: Function sorting items in the list.

**Example Usage:**
```tsx
import { useInfiniteSmartQuery } from 'react-smart-query';

const { data, addItem, removeItem, fetchNextPage } = useInfiniteSmartQuery({
  queryKey: ['feed'],
  queryFn: ({ pageParam }) => fetchFeed(pageParam),
  getNextCursor: (res) => res.nextCursor,
  select: (res) => res.items,
  getItemId: (item) => item.id,
  sortComparator: (a, b) => b.timestamp - a.timestamp,
});

// Mutating the list
const onPostCreated = (newPost) => addItem(newPost);
const onPostDeleted = (postId) => removeItem(postId);
```

### `useSmartMutation`
Handles creating, updating, or deleting items. It integrates with the offline queue and provides optimistic UI updates.

**Example Usage:**
```tsx
import { useSmartMutation } from 'react-smart-query';

const mutate = useSmartMutation({
  mutationFn: (newExpense) => api.post('/expenses', newExpense),
  onMutate: (newExpense) => {
    // Optimistically update UI
  },
});
```

### `useSmartQuerySelector`
Allows fine-grained subscriptions to a slice of the cached data, preventing unnecessary re-renders.

**Example Usage:**
```tsx
import { useSmartQuerySelector } from 'react-smart-query';

const specificItem = useSmartQuerySelector(['expenses'], (data) => data.find(i => i.id === '123'));
```

---

## Factory API

### `createTypedQuery`
Provides a way to create strongly-typed query configurations that can be reused across your application, ensuring type safety and consistency.

**Example Usage:**
```tsx
import { createTypedQuery } from 'react-smart-query';

export const userQuery = createTypedQuery({
  queryKeyBase: ['users'],
  queryFn: (id: string) => fetchUser(id),
});

// In component:
const { data } = useSmartQuery(userQuery.buildConfig('user-123'));
```

---

## Advanced Features

### Offline Queue
The library automatically handles queuing mutations when offline.
To interact with it manually (rarely needed):
```tsx
import { getQueue, clearQueue, processQueue } from 'react-smart-query';
```

### Normalization & Cache
While hooks handle normalization automatically, you can interact with the raw cache:
```tsx
import { readCache, writeCache, clearAllSmartCache } from 'react-smart-query';
```

### Debugging
For development, you can enable verbose logging and snapshot tools.
```tsx
// In your App entry point (DEV ONLY)
import "react-smart-query/debug";

// Access the debugger window or call globally (if attached)
import { smartQueryDebug } from 'react-smart-query';
smartQueryDebug.snapshot();
```
