/**
 * src/services/storage.adapter.ts
 *
 * Platform-aware storage with SSR safety.
 *
 *   iOS / Android  →  react-native-mmkv
 *   Web (browser)  →  IndexedDB
 *   SSR / Node.js  →  in-memory Map (safe no-op, hydrates on client)
 *
 * The SSR guard prevents "indexedDB is not defined" crashes in
 * Next.js / Expo Router SSR builds. Data written during SSR is discarded;
 * the client hydrates from real IDB on first mount.
 */

import { Platform } from "react-native";
import type { AsyncStorage } from "../types";

export type { AsyncStorage };

// ─── SSR / Node.js in-memory adapter ─────────────────────────────────────────

function createMemoryStorage(): AsyncStorage {
  const store = new Map<string, string>();
  return {
    get: (key) => Promise.resolve(store.get(key)),
    set: (key, value) => { store.set(key, value); return Promise.resolve(); },
    delete: (key) => { store.delete(key); return Promise.resolve(); },
    clearAll: () => { store.clear(); return Promise.resolve(); },
    keys: () => Promise.resolve(Array.from(store.keys())),
  };
}

// ─── Native adapter (iOS + Android) ──────────────────────────────────────────

function createNativeStorage(): AsyncStorage {
  const MMKV = require("react-native-mmkv").MMKV;
  const mmkv = new MMKV({ id: "react-smart-query-v2" });
  return {
    get: (key) => Promise.resolve(mmkv.getString(key) ?? undefined),
    set: (key, value) => Promise.resolve(void mmkv.set(key, value)),
    delete: (key) => Promise.resolve(void mmkv.delete(key)),
    clearAll: () => Promise.resolve(void mmkv.clearAll()),
    keys: () => Promise.resolve(mmkv.getAllKeys()),
  };
}

// ─── Web adapter (IndexedDB) with SSR guard ───────────────────────────────────

const IDB_NAME = "SmartQueryV2";
const IDB_STORE = "entries";
const IDB_VERSION = 1;

function isIDBAvailable(): boolean {
  return typeof globalThis !== "undefined" &&
    typeof (globalThis as unknown as Record<string, unknown>).indexedDB !== "undefined";
}

function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = (e) => resolve((e.target as IDBOpenDBRequest).result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IDB blocked by another tab"));
  });
}

let _idb: Promise<IDBDatabase> | null = null;
const getIDB = () => { _idb ??= openIDB(); return _idb; };

function idbWrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

function createWebStorage(): AsyncStorage {
  // SSR guard — return memory storage when IDB is unavailable
  if (!isIDBAvailable()) return createMemoryStorage();

  return {
    async get(key) {
      const db = await getIDB();
      return idbWrap<string | undefined>(
        db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(key)
      );
    },
    async set(key, value) {
      const db = await getIDB();
      await idbWrap(
        db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).put(value, key)
      );
    },
    async delete(key) {
      const db = await getIDB();
      await idbWrap(
        db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).delete(key)
      );
    },
    async clearAll() {
      const db = await getIDB();
      await idbWrap(
        db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).clear()
      );
    },
    async keys() {
      const db = await getIDB();
      const result = await idbWrap<IDBValidKey[]>(
        db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).getAllKeys()
      );
      return result.map(String);
    },
  };
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const storage: AsyncStorage =
  Platform.OS === "web" ? createWebStorage() : createNativeStorage();

/** Exposed for test utilities to inject a custom adapter */
let _overrideStorage: AsyncStorage | null = null;

export function getStorage(): AsyncStorage {
  return _overrideStorage ?? storage;
}

/** @internal — used by SmartQueryTestProvider only */
export function _setStorageOverride(s: AsyncStorage | null): void {
  _overrideStorage = s;
}
