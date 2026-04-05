# 🧠 react-smart-query

**Offline-first normalized data layer for React Native & Web**

[![npm version](https://img.shields.io/npm/v/react-smart-query.svg)](https://www.npmjs.com/package/react-smart-query)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## ⚡ Quick Example

Get started in seconds. It looks just like the tools you already know, but with superpowers.

```tsx
import { useSmartQuery } from 'react-smart-query';

const { data, isLoading } = useSmartQuery({
  queryKey: ["expenses"],
  queryFn: fetchExpenses
});
```

---

## 🚨 The Problem

TanStack Query (React Query) handles data fetching brilliantly. But as your app grows, real-world constraints start to show. Complex apps often struggle with:

- **Pagination + Mutation Bugs**: Updating a single item buried inside page 3 of an infinite list requires complex, error-prone manual cache traversals.
- **Offline Sync**: Surviving patchy networks and syncing user actions when they come back online.
- **Unnecessary Re-renders**: UI components rendering more often than they need to.
- **Large List Updates**: Finding and updating items in massive arrays without freezing the UI.

---

## 💡 The Solution

`react-smart-query` intercepts your API responses and stores them intelligently.

- **Adds offline-first support** right out of the box.
- **Uses normalized storage** (a flat dictionary) behind the scenes for lighting-fast updates.
- **Fixes pagination + mutation issues** automatically. No more manual cache traversal!
- **Works on top of React Query**. It enhances your existing setup without replacing it.

---

## ✨ Key Features

- 📶 **Offline-first caching** (MMKV for mobile, IndexedDB for web)
- 🚀 **Normalized data structure** (`{ byId, allIds }` map) for `O(1)` updates
- 🧠 **Smart diff updates** (minimal, surgically precise re-renders)
- 📜 **Infinite query with normalized pagination** (no more page-splicing bugs)
- 🌍 **Global mutation system** (add/update/remove from anywhere, without hooks)
- 📱 **Cross-platform support**
- 🛡️ **Memory protection** (maxItems to elegantly trim huge lists)

---

## ⚖️ Why Not Just TanStack Query?

React Smart Query takes the heavy lifting out of state mutability. It delegates the networking to TanStack Query and completely upgrades the storage.

| Feature | TanStack Query | react-smart-query |
| :--- | :---: | :---: |
| **Offline queue** | ❌ | ✅ |
| **Normalized cache** | ❌ | ✅ |
| **Pagination + mutation fix** | ❌ | ✅ |
| **Global mutations** | ❌ | ✅ |

### How it compares to WatermelonDB

While **WatermelonDB** is a full relational database (SQLite), **React Smart Query** is a "Smart Cache."

- **WatermelonDB** is best for apps with **100k+ records** requiring complex SQL joins.
- **React Smart Query** is best for apps with **up to 10k items** where you want **zero native overhead** and **instant integration** with TanStack Query.

[Read the full comparison guide →](./docs/COMPETITION_ANALYSIS.md)

---

## 📦 Installation

Install the library alongside its peer dependencies:

```bash
npm install react-smart-query @tanstack/react-query react-native-mmkv
```

---

## 🚦 Quick Start

### 1. Setup

Just wrap your app like you normally would. Your data layer is instantly primed.

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const queryClient = new QueryClient();

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <YourApp />
    </QueryClientProvider>
  );
}
```

### 2. Standard Query

```tsx
import { useSmartQuery } from 'react-smart-query';

function UserProfile({ userId }) {
  const { data } = useSmartQuery({
    queryKey: ['users', userId],
    queryFn: () => api.getUser(userId),
    select: (res) => res.user,
  });

  return <Text>{data?.name}</Text>;
}
```

### 3. Infinite Query

This is where the magic happens. Mutating paged data is now effortless.

```tsx
import { useInfiniteSmartQuery } from 'react-smart-query';

function Feed() {
  const { data, addItem } = useInfiniteSmartQuery({
    queryKey: ['feed'],
    queryFn: ({ pageParam }) => api.getFeed({ cursor: pageParam }),
    getNextCursor: (res) => res.nextCursor,
    select: (res) => res.items,
    getItemId: (item) => item.id,
    sortComparator: (a, b) => b.createdAt - a.createdAt,
  });

  // Adding an item automatically sorts it into the exact right place!
  const onNewPost = (post) => addItem(post);

  return <FlatList data={data} renderItem={...} />;
}
```

---

## 💼 Example Use Case

**Scenario: An Expense Tracking App**

Imagine a user is traveling through the subway and logs an expense. 
1. `react-smart-query` immediately intercepts this.
2. It pushes the action to an **Offline Queue**.
3. It performs a **Global Mutation**, inserting the new expense into the normalized store.
4. Your Infinite List jumps to life—it finds the expense, uses your `sortComparator` via binary search to place it at exactly the top of the list, and triggers a surgically precise re-render.
5. When the user exits the subway, the queue detects the network and syncs the expense to your server.

**Perfect for:** Expense Apps, Chat Apps, Social Feeds, and Dashboards.

---

## 🛠️ API Overview

- **`useSmartQuery`**: Drop-in enhancement for viewing and caching standard API calls.
- **`useInfiniteSmartQuery`**: The flagship hook. Takes paginated API chunks, flattens them, sorts them globally, and gives you `addItem`, `updateItem`, and `removeItem` helpers.
- **`getSmartQueryActions`**: A global API to mutate data from outside of React components (e.g., from a push notification background handler).

---

## 🏗️ Architecture

```text
       UI (React Components)
               ↓
       Smart Query Hooks
               ↓
    TanStack Query (Networking)
               ↓
 Normalized Cache + Offline Queue
               ↓
   Storage (MMKV / IndexedDB)
```

---

## 🕵️ Debug Tools

For power users, `react-smart-query` comes with built-in development inspection tools to see exactly how your data is normalizing.

```tsx
import "react-smart-query/debug";
import { smartQueryDebug } from "react-smart-query";

// Prints the exact current state of the global { byId, allIds } maps to your console!
await smartQueryDebug.snapshot();
```

---

## 🤔 When to Use / Not Use

✅ **Use if:**
- You are building offline-first apps.
- You have large, paginated lists.
- You have high-frequency data updates (websocket chats, real-time feeds).

❌ **Avoid if:**
- You are building a very small app without offline needs.
- Your data is purely static and never mutates locally.

---

## 🗺️ Roadmap

- [ ] DevTools UI (Visual Inspector)
- [ ] Built-in WebSocket sync adapter
- [ ] Lightweight Plugin System

---

## 🤝 Contributing

We welcome contributions! Whether you're fixing a bug, adding a feature, or improving documentation, check out our repository and open a Pull Request.

---

## 📄 License

MIT © 2024 React Smart Query Team
