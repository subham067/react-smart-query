/**
 * src/utils/debug.ts
 *
 * Developer debug tools — zero production overhead.
 * Attach to globalThis only when __DEV__ is true.
 *
 * Import once as a side effect:
 *   import "react-smart-query/debug"; // in App.tsx
 *
 * Then use in debugger / console:
 *   await smartQueryDebug.snapshot()
 *   await smartQueryDebug.inspectCache(["expenses", "trip_1"])
 *   smartQueryDebug.inFlightKeys()
 */

import { cacheKeyFor, readCache } from "../services/cache.service";
import { getStorage } from "../services/storage.adapter";
import { getQueue, getQueueLength } from "../services/queue.service";
import { inFlightCount, inFlightKeys } from "../services/requestLock.service";

if (__DEV__) {
  const debug = {
    async inspectCache(queryKey: readonly unknown[]) {
      return readCache(cacheKeyFor(queryKey), queryKey);
    },
    async listCacheKeys() {
      const keys = await getStorage().keys();
      return keys.filter((k) => k.startsWith("sq2:"));
    },
    async clearCache() {
      await getStorage().clearAll();
      console.log("[SmartQuery] Cache cleared");
    },
    getQueue,
    getQueueLength,
    inFlightKeys,
    inFlightCount,
    async snapshot() {
      const [keys, queue] = await Promise.all([
        debug.listCacheKeys(),
        debug.getQueue(),
      ]);
      console.group("[SmartQuery] Debug Snapshot");
      console.log("Cache entries:", keys.length, keys);
      console.log("Queued mutations:", queue.length, queue);
      console.log("In-flight requests:", inFlightKeys());
      console.groupEnd();
    },
  };

  (globalThis as Record<string, unknown>).smartQueryDebug = debug;
  console.log("[SmartQuery] Debug tools ready → smartQueryDebug.snapshot()");
}

export {};
