import { describe, expect, it } from 'vitest';
import { Inventory } from '../src/models/Inventory';
import { addListing, auth, createFarm, eastKm, http, productId, registerUser, useDatabase } from './helpers';

useDatabase();

describe('farmer onboarding', () => {
  it('creates an empty farmer profile on registration and updates it', async () => {
    const f = await registerUser('farmer');
    const me = await http().get('/api/farmers/me').set(auth(f.token));
    expect(me.status).toBe(200);
    expect(me.body.data.farms).toEqual([]);

    const res = await http()
      .put('/api/farmers/profile')
      .set(auth(f.token))
      .send({ bio: 'Growing vegetables without chemicals for 15 years.', practices: ['natural-farming'], organicCertification: { certificateNumber: 'PGS-1', issuer: 'PGS-India' } });
    expect(res.status).toBe(200);
    expect(res.body.data.farmer.organicCertification.status).toBe('pending');
  });

  it('requires a farm before listing products', async () => {
    const f = await registerUser('farmer');
    const res = await http().post('/api/inventory').set(auth(f.token)).send({ product: await productId('tomato'), price: 40, unit: 'kg', quantityAvailable: 10, harvestDate: new Date().toISOString() });
    expect(res.status).toBe(400);
  });

  it('validates farm coordinates and PIN code', async () => {
    const f = await registerUser('farmer');
    const res = await http().post('/api/farms').set(auth(f.token)).send({
      name: 'Bad',
      city: 'Raipur',
      address: { line1: 'x road', state: 'CG', pincode: '12' },
      location: { lng: 500, lat: 21 },
    });
    expect(res.status).toBe(400);
    const fields = res.body.error.details.map((d: { field: string }) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['address.pincode', 'location.lng']));
  });
});

describe('inventory rules', () => {
  it('fresh produce needs a past harvest date; dry produce needs processed + future expiry + pack size', async () => {
    const { token } = await createFarm();
    const tomato = await productId('tomato');
    const future = new Date(Date.now() + 3 * 86400000).toISOString();
    const r1 = await http().post('/api/inventory').set(auth(token)).send({ product: tomato, price: 40, unit: 'kg', quantityAvailable: 10, harvestDate: future });
    expect(r1.status).toBe(400);
    expect(r1.body.error.details[0].field).toBe('harvestDate');

    const chilli = await productId('dried-red-chilli');
    const r2 = await http().post('/api/inventory').set(auth(token)).send({ product: chilli, price: 90, unit: 'packet', quantityAvailable: 10, processedDate: new Date().toISOString(), expiryDate: '2020-01-01' });
    expect(r2.status).toBe(400);
    expect(r2.body.error.details.map((d: { field: string }) => d.field)).toEqual(expect.arrayContaining(['expiryDate', 'packSizeGrams']));
  });

  it('one listing per product per farm', async () => {
    const { token } = await createFarm();
    await addListing(token, 'spinach');
    await expect(addListing(token, 'spinach')).rejects.toThrow(/409/);
  });

  it('stock changes are atomic and never go below zero', async () => {
    const { token } = await createFarm();
    const id = await addListing(token, 'potato', { quantityAvailable: 100 });
    const results = await Promise.all(
      Array.from({ length: 3 }, () => http().patch(`/api/inventory/${id}/stock`).set(auth(token)).send({ mode: 'add', quantity: -40 })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 409]);
    expect((await Inventory.findById(id))!.quantityAvailable).toBe(20);
  });

  it('other farmers cannot edit my listing', async () => {
    const a = await createFarm();
    const b = await createFarm();
    const id = await addListing(a.token, 'okra');
    expect((await http().put(`/api/inventory/${id}`).set(auth(b.token)).send({ price: 1 })).status).toBe(404);
  });

  it('moving a farm moves its listings for geo search', async () => {
    const { token, farmId } = await createFarm();
    const id = await addListing(token, 'carrot');
    await http().put(`/api/farms/${farmId}`).set(auth(token)).send({ location: { lng: eastKm(5), lat: 21.3 } }).expect(200);
    const l = await Inventory.findById(id);
    expect(l!.farmLocation.coordinates[0]).toBeCloseTo(eastKm(5), 5);
  });

  it('pausing a farm hides its listings and blocks re-publishing', async () => {
    const { token, farmId } = await createFarm();
    const id = await addListing(token, 'cabbage');
    await http().put(`/api/farms/${farmId}`).set(auth(token)).send({ isActive: false }).expect(200);
    expect((await Inventory.findById(id))!.isActive).toBe(false);
    expect((await http().put(`/api/inventory/${id}`).set(auth(token)).send({ isActive: true })).status).toBe(409);
  });
});

describe('public farmer profile', () => {
  it('shows in-stock listings and never exposes private fields', async () => {
    const { token, farmerId } = await createFarm();
    await addListing(token, 'garlic');
    const res = await http().get(`/api/farmers/${farmerId}?lng=81.63&lat=21.25`);
    expect(res.status).toBe(200);
    expect(res.body.data.listings).toHaveLength(1);
    expect(res.body.data.farms[0].distanceKm).toBeTypeOf('number');
    const raw = JSON.stringify(res.body);
    for (const secret of ['passwordHash', 'quantityReserved', 'line1', 'pincode', 'phone']) expect(raw).not.toContain(secret);
  });
});

describe('photo links', () => {
  it('only accepts photos from approved image hosts or self-hosted paths', async () => {
    const { token, farmId } = await createFarm();
    const put = (images: string[]) => http().put(`/api/farms/${farmId}`).set(auth(token)).send({ images });
    const bad = await put(['https://tracker.example.com/pixel.jpg']);
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body.error)).toContain('res.cloudinary.com');
    expect((await put(['http://res.cloudinary.com/demo/image/upload/a.jpg'])).status).toBe(400); // https only
    expect((await put(['https://res.cloudinary.com/demo/image/upload/a.jpg', '/images/site/farm-rows.jpg'])).status).toBe(200);
    // Listings are checked the same way.
    await expect(addListing(token, 'okra', { images: ['https://evil.example.org/x.png'] })).rejects.toThrow(/400/);
  });
});
