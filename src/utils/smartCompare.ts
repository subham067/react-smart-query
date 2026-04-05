/**
 * src/utils/smartCompare.ts
 *
 * Hybrid 5-tier comparison — short-circuits as early as possible.
 *
 * Tier 1  reference equality          O(1)
 * Tier 2  type / length               O(1)
 * Tier 3  id-set fingerprint          O(n)   — detects add / remove / reorder
 * Tier 4  version XOR fingerprint     O(n)   — detects field updates
 * Tier 5  fast-deep-equal fallback    O(n*f) — schema-less safety net
 */

import equal from "fast-deep-equal";
import type { AnyItem, GetItemId } from "../types";

export interface SmartCompareOptions {
  idField?: string;
  versionField?: string | null;
}

export interface CompareResult {
  isEqual: boolean;
  tier: 1 | 2 | 3 | 4 | 5;
}

export function smartCompare(
  oldData: unknown,
  newData: unknown,
  options: SmartCompareOptions = {}
): CompareResult {
  const idField = options.idField ?? "id";
  const versionField = options.versionField === undefined ? "updatedAt" : options.versionField;

  // Tier 1
  if (oldData === newData) return { isEqual: true, tier: 1 };

  const oldIsArr = Array.isArray(oldData);
  const newIsArr = Array.isArray(newData);

  // Tier 2
  if (oldIsArr !== newIsArr) return { isEqual: false, tier: 2 };
  if (!oldIsArr) return { isEqual: equal(oldData, newData), tier: 5 };

  const o = oldData as AnyItem[];
  const n = newData as AnyItem[];
  if (o.length !== n.length) return { isEqual: false, tier: 2 };
  if (o.length === 0) return { isEqual: true, tier: 2 };

  // Tier 3 — id fingerprint
  let oldIds = "";
  let newIds = "";
  for (let i = 0; i < o.length; i++) {
    oldIds += String(o[i][idField] ?? i) + "|";
    newIds += String(n[i][idField] ?? i) + "|";
  }
  if (oldIds !== newIds) return { isEqual: false, tier: 3 };

  // Tier 4 — version XOR
  if (versionField !== null) {
    let xorOld = 0;
    let xorNew = 0;
    for (let i = 0; i < o.length; i++) {
      xorOld ^= (Number(o[i][versionField] ?? 0) ^ i);
      xorNew ^= (Number(n[i][versionField] ?? 0) ^ i);
    }
    if (xorOld !== xorNew) return { isEqual: false, tier: 4 };
  }

  // Tier 5
  return { isEqual: equal(oldData, newData), tier: 5 };
}

export function isDataEqual(
  oldData: unknown,
  newData: unknown,
  options?: SmartCompareOptions
): boolean {
  return smartCompare(oldData, newData, options).isEqual;
}
