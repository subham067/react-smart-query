/**
 * src/services/requestLock.service.ts
 *
 * In-flight request deduplication.
 * Concurrent calls with the same key share one Promise — only one fetch fires.
 */

const inFlight = new Map<string, Promise<unknown>>();

export function fetchWithLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;

  const promise = fn().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

export const inFlightCount = (): number => inFlight.size;
export const inFlightKeys = (): string[] => Array.from(inFlight.keys());
