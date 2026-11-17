import { describe, expect, it } from 'vitest';
import {
  diversify,
  freshnessScore,
  priceRanges,
  priceScore,
  proximityScore,
  ratingScore,
  stockScore,
  weightedScore,
} from './scoring';

const now = new Date('2026-11-17T12:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
const daysAhead = (d: number) => new Date(now.getTime() + d * 86_400_000);

describe('proximityScore', () => {
  it('is 1 at the door and 0 at the radius edge', () => {
    expect(proximityScore(0, 8)).toBe(1);
    expect(proximityScore(8, 8)).toBe(0);
    expect(proximityScore(4, 8)).toBeCloseTo(0.5);
  });
  it('clamps beyond the radius', () => {
    expect(proximityScore(12, 8)).toBe(0);
  });
});

describe('freshnessScore', () => {
  it('fresh: decays over shelf life', () => {
    expect(freshnessScore({ productType: 'fresh', harvestDate: now }, 7, now)).toBe(1);
    expect(freshnessScore({ productType: 'fresh', harvestDate: daysAgo(3.5) }, 7, now)).toBeCloseTo(0.5);
    expect(freshnessScore({ productType: 'fresh', harvestDate: daysAgo(10) }, 7, now)).toBe(0);
  });
  it('fresh: missing harvest date scores 0', () => {
    expect(freshnessScore({ productType: 'fresh' }, 7, now)).toBe(0);
  });
  it('dry: share of processed→expiry window remaining', () => {
    const s = freshnessScore({ productType: 'dry', processedDate: daysAgo(25), expiryDate: daysAhead(75) }, 365, now);
    expect(s).toBeCloseTo(0.75);
  });
  it('dry: expired scores 0', () => {
    expect(freshnessScore({ productType: 'dry', processedDate: daysAgo(100), expiryDate: daysAgo(1) }, 365, now)).toBe(0);
  });
});

describe('stockScore', () => {
  it('reaches 1 at target orders', () => {
    expect(stockScore(10, 1, 10)).toBe(1);
    expect(stockScore(5, 1, 10)).toBeCloseTo(0.5);
    expect(stockScore(500, 1, 10)).toBe(1);
  });
});

describe('ratingScore (Bayesian)', () => {
  it('a single 5★ review does not beat many 4.7★ reviews', () => {
    const single = ratingScore(5, 1, 3.5, 5);
    const many = ratingScore(4.7, 200, 3.5, 5);
    expect(many).toBeGreaterThan(single);
  });
  it('unrated farmers sit at the prior', () => {
    expect(ratingScore(0, 0, 3.5, 5)).toBeCloseTo((3.5 - 1) / 4);
  });
});

describe('priceScore', () => {
  it('cheapest is 1, dearest is 0', () => {
    expect(priceScore(30, 30, 50)).toBe(1);
    expect(priceScore(50, 30, 50)).toBe(0);
    expect(priceScore(40, 30, 50)).toBeCloseTo(0.5);
  });
  it('all-equal prices score 1', () => {
    expect(priceScore(40, 40, 40)).toBe(1);
  });
  it('compares only like-for-like groups', () => {
    const r = priceRanges([
      { product: 'tomato', unit: 'kg', price: 40 },
      { product: 'tomato', unit: 'kg', price: 60 },
      { product: 'chilli', unit: 'packet', packSizeGrams: 100, price: 50 },
      { product: 'chilli', unit: 'packet', packSizeGrams: 250, price: 110 },
    ]);
    expect(r.get('tomato|kg|')).toEqual({ min: 40, max: 60 });
    expect(r.get('chilli|packet|100')).toEqual({ min: 50, max: 50 });
  });
});

describe('diversify', () => {
  const items = [
    { id: 'a1', farm: 'A', s: 0.9 },
    { id: 'a2', farm: 'A', s: 0.89 },
    { id: 'a3', farm: 'A', s: 0.88 },
    { id: 'b1', farm: 'B', s: 0.8 },
  ];
  it('interleaves a slightly weaker farm instead of repeating one farm', () => {
    const out = diversify(items, (i) => i.s, (i) => i.farm, 0.85).map((i) => i.id);
    expect(out).toEqual(['a1', 'b1', 'a2', 'a3']);
  });
  it('re-ranks only the first `take` positions and keeps every item', () => {
    const out = diversify(items, (i) => i.s, (i) => i.farm, 0.85, 2).map((i) => i.id);
    expect(out.slice(0, 2)).toEqual(['a1', 'b1']);
    expect(out).toHaveLength(4);
    expect(new Set(out).size).toBe(4);
  });
  it('decay 1 keeps plain score order', () => {
    const out = diversify(items, (i) => i.s, (i) => i.farm, 1).map((i) => i.id);
    expect(out).toEqual(['a1', 'a2', 'a3', 'b1']);
  });
});

describe('weightedScore', () => {
  const w = { proximity: 0.3, freshness: 0.2, stock: 0.1, rating: 0.15, price: 0.15, organic: 0.1 };
  it('perfect parts score 1, empty parts score 0', () => {
    const ones = { proximity: 1, freshness: 1, stock: 1, rating: 1, price: 1, organic: 1 };
    const zeros = { proximity: 0, freshness: 0, stock: 0, rating: 0, price: 0, organic: 0 };
    expect(weightedScore(ones, w)).toBeCloseTo(1);
    expect(weightedScore(zeros, w)).toBe(0);
  });
  it('normalises by weight sum', () => {
    const parts = { proximity: 1, freshness: 0, stock: 0, rating: 0, price: 0, organic: 0 };
    expect(weightedScore(parts, { ...w, proximity: 3 })).toBeCloseTo(3 / (3 + 0.7));
  });
});
