/**
 * src/services/queue.service.ts
 *
 * Offline Mutation Queue — persist-first, retry-on-reconnect, with coalescing.
 *
 * Key design decisions:
 *   • Sequential FIFO processing preserves causal ordering
 *   • Coalescing: two mutations with the same entityKey are merged before send
 *     (prevents stale optimistic updates from racing each other)
 *   • Exponential backoff with full jitter — no thundering herd on reconnect
 *   • Observability events on enqueue / success / failure / drain
 *   • clearQueue() on logout prevents cross-user mutation leakage
 */

import { getStorage } from "./storage.adapter";
import { emit } from "./observer.service";
import type { QueuedMutation, MutationType } from "../types";

export type { QueuedMutation, MutationType };

// ─── Constants ────────────────────────────────────────────────────────────────

const QUEUE_KEY = "sq2:mutation_queue";
const DEFAULT_MAX_RETRIES = 5;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 120_000;

// ─── Executor registry ────────────────────────────────────────────────────────

type Executor<P = unknown> = (mutation: QueuedMutation<P>) => Promise<void>;
const executors = new Map<string, Executor>();

/**
 * Register an executor for a mutation type.
 * Must be called at app startup before mutations are enqueued.
 *
 * @example
 *   registerExecutor("ADD_ITEM", async (m) => {
 *     await api.post("/expenses", m.payload);
 *   });
 */
export function registerExecutor<TPayload>(
  type: string,
  fn: Executor<TPayload>
): void {
  executors.set(type, fn as Executor);
}

// ─── Queue coalescing ─────────────────────────────────────────────────────────

/**
 * Coalesce mutations with the same entityKey.
 *
 * Rules (applied in order for each entityKey group):
 *   • REMOVE_ITEM after any other mutation → keep only REMOVE_ITEM
 *   • Multiple UPDATE_ITEM → keep only the latest (highest enqueuedAt)
 *   • Multiple ADD_ITEM → keep only the latest (shouldn't normally happen)
 *   • ADD_ITEM then UPDATE_ITEM → merge into a single ADD_ITEM with latest payload
 *
 * Mutations without an entityKey are never coalesced.
 */
function coalesceQueue(queue: QueuedMutation[]): QueuedMutation[] {
  // Separate coalesable (have entityKey) from non-coalesable
  const byEntityKey = new Map<string, QueuedMutation[]>();
  const standalone: QueuedMutation[] = [];

  for (const m of queue) {
    if (!m.entityKey) { standalone.push(m); continue; }
    const group = byEntityKey.get(m.entityKey) ?? [];
    group.push(m);
    byEntityKey.set(m.entityKey, group);
  }

  const coalesced: QueuedMutation[] = [];

  for (const group of byEntityKey.values()) {
    // Sort by enqueuedAt ascending within each group
    group.sort((a, b) => a.enqueuedAt - b.enqueuedAt);

    const hasRemove = group.some((m) => m.type === "REMOVE_ITEM");
    if (hasRemove) {
      // Keep only the last REMOVE_ITEM — all preceding mutations are superseded
      const removeOp = [...group].reverse().find((m) => m.type === "REMOVE_ITEM")!;
      coalesced.push(removeOp);
      continue;
    }

    const addOp = group.find((m) => m.type === "ADD_ITEM");
    const updateOps = group.filter((m) => m.type === "UPDATE_ITEM");

    if (addOp && updateOps.length > 0) {
      // ADD + UPDATE(s) → single ADD with the latest payload
      const latestUpdate = updateOps[updateOps.length - 1];
      coalesced.push({ ...addOp, payload: latestUpdate.payload });
    } else if (addOp) {
      coalesced.push(addOp);
    } else if (updateOps.length > 0) {
      // Multiple UPDATEs → keep latest
      coalesced.push(updateOps[updateOps.length - 1]);
    } else {
      // CUSTOM or mixed — keep all
      coalesced.push(...group);
    }
  }

  // Restore original ordering by enqueuedAt
  return [...standalone, ...coalesced].sort((a, b) => a.enqueuedAt - b.enqueuedAt);
}

// ─── Persistence ──────────────────────────────────────────────────────────────

async function loadQueue(): Promise<QueuedMutation[]> {
  try {
    const raw = await getStorage().get(QUEUE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as QueuedMutation[];
  } catch { return []; }
}

async function saveQueue(queue: QueuedMutation[]): Promise<void> {
  try {
    await getStorage().set(QUEUE_KEY, JSON.stringify(queue));
  } catch {}
}

// ─── Backoff ──────────────────────────────────────────────────────────────────

function backoffMs(retryCount: number): number {
  const exp = Math.min(BACKOFF_BASE_MS * 2 ** retryCount, BACKOFF_MAX_MS);
  return Math.random() * exp; // full jitter
}

// ─── Processing ───────────────────────────────────────────────────────────────

let isProcessing = false;

/**
 * Process all pending mutations in FIFO order.
 * Coalesces before sending to minimize network calls.
 * Safe to call concurrently — guarded by isProcessing flag.
 */
export async function processQueue(): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;

  try {
    const raw = await loadQueue();
    if (raw.length === 0) return;

    const queue = coalesceQueue(raw);
    const now = Date.now();
    const remaining: QueuedMutation[] = [];

    for (const mutation of queue) {
      if (mutation.nextRetryAt > now) { remaining.push(mutation); continue; }

      const executor = executors.get(mutation.type);
      if (!executor) {
        if (__DEV__) {
          console.warn(`[SmartQuery] No executor for "${mutation.type}"`);
        }
        remaining.push(mutation);
        continue;
      }

      try {
        await executor(mutation);
        emit({ type: "queue_success", mutationId: mutation.id });
      } catch (err) {
        const nextRetry = mutation.retryCount + 1;
        emit({ type: "queue_failure", mutationId: mutation.id, retryCount: nextRetry });

        if (nextRetry >= mutation.maxRetries) {
          if (__DEV__) {
            console.error(
              `[SmartQuery] Mutation ${mutation.id} dropped after ${mutation.maxRetries} retries`,
              err
            );
          }
        } else {
          remaining.push({
            ...mutation,
            retryCount: nextRetry,
            nextRetryAt: now + backoffMs(nextRetry),
          });
        }
      }
    }

    await saveQueue(remaining);
    if (remaining.length === 0) emit({ type: "queue_drained" });
  } finally {
    isProcessing = false;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Add a mutation to the persistent queue.
 *
 * @param entityKey  Optional logical key for coalescing (e.g. "expense:exp_123").
 *                   Mutations with the same entityKey are merged before sending.
 */
export async function enqueueMutation<TPayload>(options: {
  type: MutationType | string;
  queryKey: readonly unknown[];
  payload: TPayload;
  entityKey?: string;
  maxRetries?: number;
}): Promise<void> {
  const queue = await loadQueue();
  const mutation: QueuedMutation<TPayload> = {
    id: `mut_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: options.type as MutationType,
    entityKey: options.entityKey,
    queryKey: options.queryKey,
    payload: options.payload,
    enqueuedAt: Date.now(),
    retryCount: 0,
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    nextRetryAt: 0,
  };
  queue.push(mutation as QueuedMutation);
  await saveQueue(queue);
  emit({ type: "queue_enqueue", mutationId: mutation.id, mutationType: mutation.type });
}

/** Process queue on app startup */
export async function initQueue(): Promise<void> {
  await processQueue();
}

/** Clear all pending mutations — call on logout */
export async function clearQueue(): Promise<void> {
  await saveQueue([]);
}

export const getQueue = loadQueue;
export const getQueueLength = async (): Promise<number> =>
  (await loadQueue()).length;
