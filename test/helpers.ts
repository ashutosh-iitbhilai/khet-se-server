/**
 * Integration-test helpers. Everything goes through the real HTTP API except the catalogue
 * seed, so the tests exercise routing, validation, auth and services together.
 */
import request from 'supertest';
import mongoose from 'mongoose';
import { afterAll, beforeAll } from 'vitest';
import { createApp } from '../src/app';
import { connectDatabase } from '../src/config/db';
import { Product } from '../src/models/Product';
import { CATALOGUE } from '../src/scripts/catalogue.data';

export const app = createApp();
export const http = () => request(app);

/** Connects to this file's database, creates indexes (2dsphere!) and seeds the catalogue. */
export function useDatabase() {
  beforeAll(async () => {
    await connectDatabase();
    await Promise.all(Object.values(mongoose.models).map((m) => m.createCollection().then(() => m.syncIndexes())));
    await Product.insertMany(CATALOGUE.map((p) => ({ ...p, isActive: true })));
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.connection.close();
  });
}

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let phoneSeq = 0;
/** A unique, valid Indian mobile number for this test run. */
export const uniquePhone = () => `9${String(process.pid % 100_000).padStart(5, '0')}${String(phoneSeq++).padStart(4, '0')}`;

export async function registerUser(role: 'customer' | 'farmer' | 'delivery', overrides: Record<string, unknown> = {}) {
  const email = `${role}-${uniq()}@test.khetse`;
  const phone = (overrides.phone as string) || uniquePhone();
  const res = await http()
    .post('/api/auth/register')
    .send({ name: role === 'farmer' ? 'Test Farmer' : role === 'delivery' ? 'Test Rider' : 'Test Customer', email, password: 'pass1234', role, ...overrides, phone });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.data.token as string, user: res.body.data.user, email, phone };
}

export const RAIPUR = { lng: 81.6296, lat: 21.2514 };

/** Farmer + farm at a point. `km` is a rough offset east of central Raipur. */
export async function createFarm(opts: { name?: string; lng?: number; lat?: number; radiusKm?: number } = {}) {
  const farmer = await registerUser('farmer');
  const res = await http()
    .post('/api/farms')
    .set(auth(farmer.token))
    .send({
      name: opts.name ?? `Farm ${uniq()}`,
      city: 'Raipur',
      address: { line1: 'Near panchayat', village: 'Testgaon', state: 'Chhattisgarh', pincode: '492001' },
      location: { lng: opts.lng ?? RAIPUR.lng, lat: opts.lat ?? RAIPUR.lat },
      deliveryRadiusKm: opts.radiusKm ?? 10,
    });
  if (res.status !== 201) throw new Error(`farm failed: ${res.status} ${JSON.stringify(res.body)}`);
  const me = await http().get('/api/farmers/me').set(auth(farmer.token));
  return { token: farmer.token, farmId: res.body.data.farm.id as string, farmerId: me.body.data.farmer.id as string };
}

export async function productId(slug: string) {
  const p = await Product.findOne({ slug });
  if (!p) throw new Error(`no product ${slug}`);
  return String(p._id);
}

const today = () => new Date().toISOString().slice(0, 10);

/** Lists a catalogue product on the farmer's farm. Fresh by default. */
export async function addListing(token: string, slug: string, opts: Record<string, unknown> = {}) {
  const product = await productId(slug);
  const p = await Product.findById(product);
  const dates =
    p!.type === 'fresh'
      ? { harvestDate: today() }
      : { processedDate: today(), expiryDate: new Date(Date.now() + 200 * 86400000).toISOString().slice(0, 10), packSizeGrams: 200 };
  const res = await http()
    .post('/api/inventory')
    .set(auth(token))
    .send({ product, price: 40, unit: p!.defaultUnit, quantityAvailable: 50, ...dates, ...opts });
  if (res.status !== 201) throw new Error(`listing failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.item.id as string;
}

export async function createCustomer(at = RAIPUR) {
  const c = await registerUser('customer');
  const res = await http()
    .post('/api/addresses')
    .set(auth(c.token))
    .send({ name: 'Test Customer', phone: '9876543210', line1: 'House 1, Test Lane', city: 'Raipur', pincode: '492001', location: at });
  if (res.status !== 201) throw new Error(`address failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { token: c.token, userId: c.user.id as string, addressId: res.body.data.address.id as string };
}

export async function quote(items: { listing: string; quantity: number }[], location = RAIPUR) {
  const res = await http().post('/api/orders/quote').send({ items, location });
  return res.body.data;
}

export async function placeOrder(
  token: string,
  addressId: string,
  items: { listing: string; quantity: number }[],
  opts: { paymentMethod?: 'cod' | 'online'; key?: string; expectedTotal?: number; at?: { lng: number; lat: number } } = {},
) {
  const total = opts.expectedTotal ?? (await quote(items, opts.at)).grandTotal;
  return http()
    .post('/api/orders')
    .set({ ...auth(token), 'Idempotency-Key': opts.key ?? `key-${uniq()}-${Math.random().toString(36).slice(2)}` })
    .send({ items, addressId, paymentMethod: opts.paymentMethod ?? 'cod', expectedTotal: total });
}

/** km offset → degrees near 21°N (good enough for placing test farms). */
export const eastKm = (km: number) => RAIPUR.lng + km / 103.9;
export const northKm = (km: number) => RAIPUR.lat + km / 110.6;
