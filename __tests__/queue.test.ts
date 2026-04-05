/**
 * __tests__/queue.test.ts
 *
 * Tests for queue.service:
 *   • enqueueMutation persists to storage
 *   • processQueue calls executor and removes on success
 *   • Exponential backoff — failed mutation is scheduled for retry
 *   • Coalescing — ADD + UPDATE → single ADD with latest payload
 *   • Coalescing — any + REMOVE → single REMOVE
 *   • Max retries → mutation is dropped after N failures
 *   • clearQueue removes all entries
 */

import {
  enqueueMutation,
  processQueue,
  clearQueue,
  getQueue,
  registerExecutor,
} from "../src/services/queue.service";
import {
  SmartQueryTestProvider,
  clearTestCache,
} from "../src/testing";

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  await clearTestCache(); // clears storage including queue key
});

// ─── 1. Enqueue persists ──────────────────────────────────────────────────────

test("enqueueMutation persists to storage", async () => {
  await enqueueMutation({
    type: "ADD_ITEM",
    queryKey: ["expenses", "t1"],
    payload: { id: "e1", amount: 50 } as Record<string, any>,
  });

  const queue = await getQueue();
  expect(queue).toHaveLength(1);
  expect(queue[0].type).toBe("ADD_ITEM");
  expect((queue[0].payload as { id: string }).id).toBe("e1");
});

// ─── 2. Executor called and removed on success ────────────────────────────────

test("processQueue calls executor and removes mutation on success", async () => {
  const executed: unknown[] = [];

  registerExecutor("ADD_ITEM", async (m) => {
    executed.push(m.payload);
  });

  await enqueueMutation({
    type: "ADD_ITEM",
    queryKey: ["expenses", "t1"],
    payload: { id: "e2" } as Record<string, any>,
  });

  await processQueue();

  expect(executed).toHaveLength(1);
  const remaining = await getQueue();
  expect(remaining).toHaveLength(0);
});

// ─── 3. Failed executor → scheduled for retry ─────────────────────────────────

test("failed mutation is rescheduled with backoff", async () => {
  registerExecutor("UPDATE_ITEM", async () => {
    throw new Error("Network error");
  });

  await enqueueMutation({
    type: "UPDATE_ITEM",
    queryKey: ["expenses", "t1"],
    payload: { id: "e3" } as Record<string, any>,
    maxRetries: 3,
  });

  await processQueue();

  const queue = await getQueue();
  expect(queue).toHaveLength(1);
  expect(queue[0].retryCount).toBe(1);
  expect(queue[0].nextRetryAt).toBeGreaterThan(Date.now());
});

// ─── 4. Max retries → mutation dropped ───────────────────────────────────────

test("mutation dropped after maxRetries failures", async () => {
  registerExecutor("CUSTOM", async () => { throw new Error("always fails"); });

  await enqueueMutation({
    type: "CUSTOM",
    queryKey: ["expenses", "t1"],
    payload: { id: "e4" } as Record<string, any>,
    maxRetries: 1, // drops after first failure
  });

  await processQueue();

  const queue = await getQueue();
  expect(queue).toHaveLength(0); // dropped
});

// ─── 5. Coalescing — ADD + UPDATE → single ADD ────────────────────────────────

test("coalescing: ADD_ITEM + UPDATE_ITEM → single ADD with latest payload", async () => {
  const executed: unknown[] = [];
  registerExecutor("ADD_ITEM", async (m) => { executed.push(m); });
  registerExecutor("UPDATE_ITEM", async (m) => { executed.push(m); });

  const entityKey = "expense:e5";

  await enqueueMutation({
    type: "ADD_ITEM",
    queryKey: ["expenses", "t1"],
    payload: { id: "e5", amount: 100 },
    entityKey,
  });

  await enqueueMutation({
    type: "UPDATE_ITEM",
    queryKey: ["expenses", "t1"],
    payload: { id: "e5", amount: 200 }, // updated amount
    entityKey,
  });

  await processQueue();

  // Should fire only ONE executor (ADD with latest payload)
  expect(executed).toHaveLength(1);
  const fired = executed[0] as { type: string; payload: { amount: number } };
  expect(fired.type).toBe("ADD_ITEM");
  expect(fired.payload.amount).toBe(200);
});

// ─── 6. Coalescing — any + REMOVE → single REMOVE ────────────────────────────

test("coalescing: ADD + UPDATE + REMOVE → single REMOVE", async () => {
  const executed: unknown[] = [];
  registerExecutor("ADD_ITEM", async (m) => { executed.push(m); });
  registerExecutor("UPDATE_ITEM", async (m) => { executed.push(m); });
  registerExecutor("REMOVE_ITEM", async (m) => { executed.push(m); });

  const entityKey = "expense:e6";

  await enqueueMutation({
    type: "ADD_ITEM",
    queryKey: ["expenses", "t1"],
    payload: { id: "e6" },
    entityKey,
  });

  await enqueueMutation({
    type: "UPDATE_ITEM",
    queryKey: ["expenses", "t1"],
    payload: { id: "e6", amount: 50 },
    entityKey,
  });

  await enqueueMutation({
    type: "REMOVE_ITEM",
    queryKey: ["expenses", "t1"],
    payload: { id: "e6" },
    entityKey,
  });

  await processQueue();

  expect(executed).toHaveLength(1);
  expect((executed[0] as { type: string }).type).toBe("REMOVE_ITEM");
});

// ─── 7. clearQueue removes all entries ───────────────────────────────────────

test("clearQueue empties the persistent queue", async () => {
  await enqueueMutation({ type: "ADD_ITEM", queryKey: ["q"], payload: {} });
  await enqueueMutation({ type: "UPDATE_ITEM", queryKey: ["q"], payload: {} });

  await clearQueue();

  const queue = await getQueue();
  expect(queue).toHaveLength(0);
});

// ─── 8. nextRetryAt guard — skips mutations not yet due ──────────────────────

test("skips mutations whose nextRetryAt is in the future", async () => {
  const executed: unknown[] = [];
  registerExecutor("ADD_ITEM", async (m) => { executed.push(m); });

  // Directly seed a mutation with future nextRetryAt
  const futureEntry = {
    id: "mut_future",
    type: "ADD_ITEM",
    queryKey: ["expenses", "t1"],
    payload: { id: "future" },
    enqueuedAt: Date.now(),
    retryCount: 1,
    maxRetries: 5,
    nextRetryAt: Date.now() + 60_000, // 1 minute from now
  };

  const { getStorage } = await import("../src/services/storage.adapter");
  await getStorage().set(
    "sq2:mutation_queue",
    JSON.stringify([futureEntry])
  );

  await processQueue();

  expect(executed).toHaveLength(0); // not yet due
  const queue = await getQueue();
  expect(queue).toHaveLength(1); // still in queue
});
