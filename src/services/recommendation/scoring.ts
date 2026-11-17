/**
 * Pure scoring functions for the hybrid weighted recommendation algorithm.
 * Every component score is normalised to [0, 1]; no I/O here so it is easy to test and tune.
 */
import type { Weights } from '../../config/recommendation';

const DAY_MS = 24 * 60 * 60 * 1000;

export const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** 1 at the customer's door, 0 at the edge of the search radius. */
export function proximityScore(distanceKm: number, radiusKm: number): number {
  if (radiusKm <= 0) return 0;
  return clamp01(1 - distanceKm / radiusKm);
}

/**
 * Fresh produce: share of shelf life remaining since harvest.
 * Dry produce: share of the processed→expiry window remaining.
 */
export function freshnessScore(
  listing: { productType: 'fresh' | 'dry'; harvestDate?: Date | string; processedDate?: Date | string; expiryDate?: Date | string },
  shelfLifeDays: number,
  now = new Date(),
): number {
  const t = now.getTime();
  if (listing.productType === 'fresh') {
    if (!listing.harvestDate) return 0;
    const ageDays = (t - new Date(listing.harvestDate).getTime()) / DAY_MS;
    return clamp01(1 - Math.max(0, ageDays) / Math.max(1, shelfLifeDays));
  }
  if (!listing.expiryDate) return 0;
  const expiry = new Date(listing.expiryDate).getTime();
  const start = listing.processedDate ? new Date(listing.processedDate).getTime() : expiry - shelfLifeDays * DAY_MS;
  const window = expiry - start;
  if (window <= 0) return 0;
  return clamp01((expiry - t) / window);
}

/** 1 when stock covers `targetOrders` minimum-size orders. */
export function stockScore(quantityAvailable: number, minOrderQty: number, targetOrders: number): number {
  const needed = Math.max(minOrderQty, 0.1) * targetOrders;
  return clamp01(quantityAvailable / needed);
}

/**
 * Bayesian average so one 5★ review doesn't outrank 200 reviews at 4.7★.
 * Mapped from the 1–5 star range to [0, 1].
 */
export function ratingScore(avg: number, count: number, prior: number, priorWeight: number): number {
  const bayes = (avg * count + prior * priorWeight) / (count + priorWeight);
  return clamp01((bayes - 1) / 4);
}

/** Cheapest offer for comparable items = 1, most expensive = 0, all equal = 1. */
export function priceScore(price: number, min: number, max: number): number {
  if (max <= min) return 1;
  return clamp01((max - price) / (max - min));
}

export type ScoreParts = Record<keyof Weights, number>;

/** Weighted mean of component scores, normalised by the weight sum. Returns [0, 1]. */
export function weightedScore(parts: ScoreParts, weights: Weights): number {
  let sum = 0;
  let wSum = 0;
  for (const key of Object.keys(weights) as (keyof Weights)[]) {
    const w = Math.max(0, weights[key]);
    sum += w * clamp01(parts[key]);
    wSum += w;
  }
  return wSum === 0 ? 0 : sum / wSum;
}

/**
 * Price comparison key: only like-for-like offers are compared
 * (same product, same unit, same packet size).
 */
export const priceGroupKey = (l: { product: unknown; unit: string; packSizeGrams?: number | null }) =>
  `${String(l.product)}|${l.unit}|${l.packSizeGrams ?? ''}`;

/** min / max price per comparable group. */
export function priceRanges<T extends { product: unknown; unit: string; packSizeGrams?: number | null; price: number }>(items: T[]) {
  const ranges = new Map<string, { min: number; max: number }>();
  for (const it of items) {
    const key = priceGroupKey(it);
    const r = ranges.get(key);
    if (!r) ranges.set(key, { min: it.price, max: it.price });
    else {
      r.min = Math.min(r.min, it.price);
      r.max = Math.max(r.max, it.price);
    }
  }
  return ranges;
}

/**
 * Greedy diversity re-rank: repeatedly pick the item with the best score after applying
 * `decay^k`, where k = items already picked from the same group (e.g. farm).
 * Only the first `take` positions are re-ranked (the page being served); the rest keep
 * their input order. Cost O(n · take) instead of O(n²). Original scores are not modified.
 */
export function diversify<T>(items: T[], score: (t: T) => number, group: (t: T) => string, decay: number, take = items.length): T[] {
  const remaining = [...items];
  const picked = new Map<string, number>();
  const out: T[] = [];
  while (remaining.length && out.length < take) {
    let bestIdx = 0;
    let best = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const adjusted = score(remaining[i]) * decay ** (picked.get(group(remaining[i])) ?? 0);
      if (adjusted > best) {
        best = adjusted;
        bestIdx = i;
      }
    }
    const [item] = remaining.splice(bestIdx, 1);
    picked.set(group(item), (picked.get(group(item)) ?? 0) + 1);
    out.push(item);
  }
  return out.concat(remaining);
}

export const round =(n: number, digits = 3) => Math.round(n * 10 ** digits) / 10 ** digits;
