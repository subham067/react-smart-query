/**
 * __tests__/smartCompare.test.ts
 *
 * Tests for every tier of the smartCompare utility.
 */

import { smartCompare, isDataEqual } from "../src/utils/smartCompare";

const item = (id: string, updatedAt: number, extra = {}) => ({
  id, updatedAt, ...extra,
});

// ─── Tier 1: Reference equality ───────────────────────────────────────────────

test("tier 1: same reference → equal", () => {
  const arr = [item("a", 1)];
  const result = smartCompare(arr, arr);
  expect(result.isEqual).toBe(true);
  expect(result.tier).toBe(1);
});

// ─── Tier 2: Length / type ────────────────────────────────────────────────────

test("tier 2: different lengths → not equal", () => {
  const result = smartCompare([item("a", 1)], [item("a", 1), item("b", 2)]);
  expect(result.isEqual).toBe(false);
  expect(result.tier).toBe(2);
});

test("tier 2: empty arrays → equal", () => {
  const result = smartCompare([], []);
  expect(result.isEqual).toBe(true);
  expect(result.tier).toBe(2);
});

test("tier 2: array vs non-array → not equal", () => {
  const result = smartCompare([item("a", 1)], { id: "a", updatedAt: 1 });
  expect(result.isEqual).toBe(false);
  expect(result.tier).toBe(2);
});

// ─── Tier 3: ID fingerprint ───────────────────────────────────────────────────

test("tier 3: same length but different ids → not equal", () => {
  const result = smartCompare([item("a", 1)], [item("b", 1)]);
  expect(result.isEqual).toBe(false);
  expect(result.tier).toBe(3);
});

test("tier 3: reordered ids → not equal", () => {
  const result = smartCompare(
    [item("a", 1), item("b", 1)],
    [item("b", 1), item("a", 1)]
  );
  expect(result.isEqual).toBe(false);
  expect(result.tier).toBe(3);
});

// ─── Tier 4: updatedAt XOR ────────────────────────────────────────────────────

test("tier 4: same ids, one updatedAt changed → not equal", () => {
  const result = smartCompare(
    [item("a", 1000), item("b", 2000)],
    [item("a", 1000), item("b", 9999)] // b updated
  );
  expect(result.isEqual).toBe(false);
  expect(result.tier).toBe(4);
});

test("tier 4: same ids, same updatedAt → passes to tier 5", () => {
  // Items have same id and updatedAt but different fields not in updatedAt
  const old = [{ id: "a", updatedAt: 1, name: "Alice" }];
  const fresh = [{ id: "a", updatedAt: 1, name: "Alicia" }];
  const result = smartCompare(old, fresh);
  // Must reach tier 5 and detect the name difference
  expect(result.isEqual).toBe(false);
  expect(result.tier).toBe(5);
});

// ─── Tier 5: Deep equal fallback ─────────────────────────────────────────────

test("tier 5: identical objects with no updatedAt → equal", () => {
  const result = smartCompare({ a: 1, b: [1, 2, 3] }, { a: 1, b: [1, 2, 3] });
  expect(result.isEqual).toBe(true);
  expect(result.tier).toBe(5);
});

test("tier 5: nested objects differ → not equal", () => {
  const result = smartCompare({ a: { b: 1 } }, { a: { b: 2 } });
  expect(result.isEqual).toBe(false);
  expect(result.tier).toBe(5);
});

// ─── Custom idField ───────────────────────────────────────────────────────────

test("custom idField: detects change using _id", () => {
  const result = smartCompare(
    [{ _id: "x", v: 1 }],
    [{ _id: "y", v: 1 }],
    { idField: "_id", versionField: "v" }
  );
  expect(result.isEqual).toBe(false);
  expect(result.tier).toBe(3);
});

// ─── versionField: null disables tier 4 ──────────────────────────────────────

test("versionField: null skips tier 4", () => {
  // Same ids, different updatedAt — but versionField disabled → reaches tier 5
  const old = [{ id: "a", updatedAt: 1 }];
  const fresh = [{ id: "a", updatedAt: 999 }];
  const result = smartCompare(old, fresh, { versionField: null });
  expect(result.tier).toBe(5);
  expect(result.isEqual).toBe(false); // deep equal catches it
});

// ─── isDataEqual convenience wrapper ─────────────────────────────────────────

test("isDataEqual returns boolean", () => {
  expect(isDataEqual([item("a", 1)], [item("a", 1)])).toBe(true);
  expect(isDataEqual([item("a", 1)], [item("b", 1)])).toBe(false);
});
