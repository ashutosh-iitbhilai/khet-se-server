/**
 * Regression tests for problems the independent algorithm checker (npm run algo:check) found:
 * expired / stale produce was offered, listings with less stock than one minimum order were
 * shown but could not be ordered, and checkout rounded the distance at the delivery-area edge.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Inventory } from '../src/models/Inventory';
import { addListing, createFarm, eastKm, http, quote, RAIPUR, useDatabase } from './helpers';

useDatabase();
const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().slice(0, 10);

describe('only sellable produce is offered', () => {
  let farm: Awaited<ReturnType<typeof createFarm>>;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    farm = await createFarm({ name: 'Sellable Test Farm', lng: eastKm(1), lat: RAIPUR.lat, radiusKm: 10 });
    ids.fresh = await addListing(farm.token, 'tomato');
    ids.stale = await addListing(farm.token, 'spinach', { harvestDate: iso(2 * DAY) }); // created fresh, aged below
    ids.dry = await addListing(farm.token, 'dried-red-chilli');
    ids.expired = await addListing(farm.token, 'kasuri-methi');
    ids.short = await addListing(farm.token, 'potato', { minOrderQty: 2, quantityAvailable: 50 });
    // Age the data directly (the API rightly refuses expired dates on new listings).
    await Inventory.updateOne({ _id: ids.stale }, { $set: { harvestDate: new Date(Date.now() - 6 * DAY) } }); // spinach keeps 3 days
    await Inventory.updateOne({ _id: ids.expired }, { $set: { processedDate: new Date(Date.now() - 400 * DAY), expiryDate: new Date(Date.now() - DAY) } });
    await Inventory.updateOne({ _id: ids.short }, { $set: { quantityAvailable: 1.5 } }); // below the 2 kg minimum
  });

  it('search, farm profile and product page leave out stale, expired and under-minimum listings', async () => {
    const res = await http().get(`/api/inventory?lng=${RAIPUR.lng}&lat=${RAIPUR.lat}&limit=50`);
    const shown = res.body.data.map((l: { id: string }) => l.id);
    expect(shown).toEqual(expect.arrayContaining([ids.fresh, ids.dry]));
    for (const hidden of [ids.stale, ids.expired, ids.short]) expect(shown).not.toContain(hidden);

    const profile = await http().get(`/api/farmers/${farm.farmerId}?lng=${RAIPUR.lng}&lat=${RAIPUR.lat}`);
    const onProfile = profile.body.data.listings.map((l: { id: string }) => l.id);
    expect(onProfile).not.toContain(ids.expired);
    expect((await http().get(`/api/inventory/${ids.expired}`)).status).toBe(404);
    expect((await http().get(`/api/inventory/${ids.fresh}`)).status).toBe(200);
  });

  it('checkout refuses them with a clear reason', async () => {
    const q = await quote([{ listing: ids.stale, quantity: 1 }, { listing: ids.expired, quantity: 1 }, { listing: ids.short, quantity: 2 }]);
    const byId = Object.fromEntries(q.issues.map((i: { listing: string }) => [i.listing, i]));
    expect(byId[ids.stale].message).toMatch(/past its shelf life/);
    expect(byId[ids.expired].message).toMatch(/past its expiry date/);
    expect(byId[ids.short].code).toBe('INSUFFICIENT_STOCK');
  });
});

describe('delivery-area edge', () => {
  it('search and checkout agree just outside a farm’s delivery area', async () => {
    const farm = await createFarm({ name: 'Edge Farm', lng: RAIPUR.lng, lat: RAIPUR.lat, radiusKm: 3 });
    const listing = await addListing(farm.token, 'coriander');
    // 3.03 km away: rounds to 3.0 km for display, but is outside the 3 km area.
    const at = { lng: eastKm(3.03), lat: RAIPUR.lat };
    const search = await http().get(`/api/inventory?lng=${at.lng}&lat=${at.lat}&limit=50`);
    expect(search.body.data.map((l: { id: string }) => l.id)).not.toContain(listing);
    const q = await quote([{ listing, quantity: 1 }], at);
    expect(q.issues[0].code).toBe('NOT_DELIVERABLE');
  });
});
