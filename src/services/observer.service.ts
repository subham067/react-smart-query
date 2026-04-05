/**
 * src/services/observer.service.ts
 *
 * Pluggable observability — emit structured events to any analytics backend.
 *
 * Zero coupling: the library emits; you decide where it goes.
 * Attach observers at app startup; they receive every internal event.
 *
 * @example
 *   // Sentry breadcrumbs
 *   addObserver((event) => {
 *     if (event.type === "fetch_error") {
 *       Sentry.addBreadcrumb({ message: event.type, data: event });
 *     }
 *   });
 *
 * @example
 *   // Datadog / Mixpanel
 *   addObserver((event) => {
 *     analytics.track(event.type, event);
 *   });
 *
 * @example
 *   // Simple console logger in dev
 *   if (__DEV__) addObserver(console.log);
 */

import type { ObservabilityEvent, ObserverFn } from "../types";

const observers = new Set<ObserverFn>();

/**
 * Register an observer. Returns an unsubscribe function.
 *
 * @example
 *   const unsub = addObserver(myLogger);
 *   // Later:
 *   unsub();
 */
export function addObserver(fn: ObserverFn): () => void {
  observers.add(fn);
  return () => observers.delete(fn);
}

/** Remove a specific observer */
export function removeObserver(fn: ObserverFn): void {
  observers.delete(fn);
}

/** Remove all observers */
export function clearObservers(): void {
  observers.clear();
}

/**
 * @internal — emit an event to all registered observers.
 * Called by cache.service, queue.service, and useSmartQuery.
 * Never throws — observer errors are swallowed to protect the data path.
 */
export function emit(event: ObservabilityEvent): void {
  if (observers.size === 0) return; // fast path — no observers registered
  for (const fn of observers) {
    try { fn(event); } catch { /* observer error must not crash the app */ }
  }
}
