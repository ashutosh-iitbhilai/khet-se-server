import { beforeAll, describe, expect, it } from 'vitest';
import { Farmer } from '../src/models/Farmer';
import { Inventory } from '../src/models/Inventory';
import { RAIPUR, addListing, auth, createFarm, eastKm, http, northKm, useDatabase } from './helpers';

useDatabase();

const q = (path: string, params: Record<string, string | number | boolean> = {}) =>
  http().get(path).query({ lng: RAIPUR.lng, lat: RAIPUR.lat, ...params });

/**
 * Layout (distance from the customer at RAIPUR):
 *   near      2 km  organic, 4.8★     — tomato ₹45, spinach
 *   mid       6 km  not organic        — tomato ₹30 (cheapest)
 *   far      12 km  radius 20          — tomato ₹38   (only after expansion beyond 8 km)
 *   noReach   5 km  radius 3           — never shown: its delivery area doesn't reach the customer
 */
let near: Awaited<ReturnType<typeof createFarm>>;
let mid: Awaited<ReturnType<typeof createFarm>>;
let far: Awaited<ReturnType<typeof createFarm>>;
let noReach: Awaited<ReturnType<typeof createFarm>>;

beforeAll(async () => {
  near = await createFarm({ name: 'Near Farm', lng: eastKm(2), radiusKm: 10 });
  mid = await createFarm({ name: 'Mid Farm', lat: northKm(6), radiusKm: 10 });
  far = await createFarm({ name: 'Far Farm', lng: eastKm(12), radiusKm: 20 });
  noReach = await createFarm({ name: 'Small Radius Farm', lat: northKm(-5), radiusKm: 3 });

  await Farmer.updateOne({ _id: near.farmerId }, { $set: { 'organicCertification.status': 'verified', ratingAvg: 4.8, ratingCount: 50 } });
  await addListing(near.token, 'tomato', { price: 45 });
  await addListing(near.token, 'spinach', { price: 30 });
  await addListing(mid.token, 'tomato', { price: 30 });
  await addListing(far.token, 'tomato', { price: 38 });
  await addListing(noReach.token, 'tomato', { price: 20 });
});

describe('nearby farms', () => {
  it('widens the radius when too few farms are close, and excludes farms that do not deliver here', async () => {
    const res = await q('/api/recommendations/farmers');
    expect(res.status).toBe(200);
    const names = res.body.data.map((f: { farm: { name: string } }) => f.farm.name);
    expect(names).toEqual(expect.arrayContaining(['Near Farm', 'Mid Farm', 'Far Farm']));
    expect(names).not.toContain('Small Radius Farm');
    expect(res.body.meta.expanded).toBe(true);
    expect(res.body.meta.radiusKm).toBeGreaterThan(8);
  });

  it('respects an explicit radius exactly', async () => {
    const res = await q('/api/farmers/nearby', { radiusKm: 4 });
    expect(res.body.data.map((f: { farm: { name: string } }) => f.farm.name)).toEqual(['Near Farm']);
    expect(res.body.meta.expanded).toBe(false);
  });

  it('distances come from MongoDB and sort correctly', async () => {
    const res = await q('/api/farmers/nearby', { sort: 'distance' });
    const d = res.body.data.map((f: { distanceKm: number }) => f.distanceKm);
    expect(d).toEqual([...d].sort((a, b) => a - b));
    expect(d[0]).toBeCloseTo(2, 0);
  });

  it('filters by organic verification', async () => {
    const res = await q('/api/farmers/nearby', { organic: true });
    expect(res.body.data.map((f: { farm: { name: string } }) => f.farm.name)).toEqual(['Near Farm']);
  });

  it('ranks the close, organic, well-rated farm first', async () => {
    const res = await q('/api/recommendations/farmers');
    expect(res.body.data[0].farm.name).toBe('Near Farm');
    for (const f of res.body.data) {
      expect(f.score).toBeGreaterThanOrEqual(0);
      expect(f.score).toBeLessThanOrEqual(1);
    }
  });

  it('rejects requests without a valid location', async () => {
    expect((await http().get('/api/farmers/nearby')).status).toBe(400);
    expect((await http().get('/api/farmers/nearby').query({ lng: 999, lat: 21 })).status).toBe(400);
  });
});

describe('nearby listings', () => {
  it('compares like-for-like prices: cheapest tomato gets the full price score', async () => {
    const res = await q('/api/inventory', { q: 'tomato', sort: 'price_asc' });
    const tomatoes = res.body.data.filter((l: { product: { name: string } }) => l.product.name === 'Tomato');
    expect(tomatoes[0].price).toBe(30);
    expect(tomatoes[0].scoreBreakdown.price).toBe(1);
    expect(tomatoes.map((t: { farm: { name: string } }) => t.farm.name)).not.toContain('Small Radius Farm');
  });

  it('stock changes show up immediately (cache invalidated on write)', async () => {
    const before = await q('/api/inventory', { q: 'spinach' });
    expect(before.body.data).toHaveLength(1);
    const listing = before.body.data[0].id;
    await http().patch(`/api/inventory/${listing}/stock`).set(auth(near.token)).send({ mode: 'set', quantity: 0 }).expect(200);
    const after = await q('/api/inventory', { q: 'spinach' });
    expect(after.body.data).toHaveLength(0);
    await Inventory.updateOne({ _id: listing }, { $set: { quantityAvailable: 30 } });
  });

  it('listing detail says whether the farm delivers to you', async () => {
    const list = await q('/api/inventory', { q: 'tomato', farm: mid.farmId });
    const res = await q(`/api/inventory/${list.body.data[0].id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.item.deliversToYou).toBe(true);
    expect(res.body.data.item.distanceKm).toBeCloseTo(6, 0);
  });
});
