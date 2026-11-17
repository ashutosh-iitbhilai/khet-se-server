/**
 * Query benchmark on a synthetic, city-sized dataset.
 *
 *   BENCH_MONGODB_URI=mongodb://127.0.0.1:27017/khet-se-bench npm run bench
 *   npm run bench -- --drop        # remove the benchmark database
 *
 * Seeds (once) ~2,000 farms with ~30,000 listings spread over 40 km around Raipur and
 * ~20,000 orders, then times the hot read paths and prints MongoDB explain() summaries.
 * Refuses to run against a database whose name doesn't contain "bench".
 */
import crypto from 'crypto';
import mongoose, { Types } from 'mongoose';
import { User } from '../models/User';
import { Farmer } from '../models/Farmer';
import { Farm } from '../models/Farm';
import { Product } from '../models/Product';
import { Inventory } from '../models/Inventory';
import { Order } from '../models/Order';
import { CATALOGUE } from './catalogue.data';

const URI = process.env.BENCH_MONGODB_URI ?? 'mongodb://127.0.0.1:27017/khet-se-bench';
const FARMS = Number(process.env.BENCH_FARMS ?? 2000);
const ORDERS = Number(process.env.BENCH_ORDERS ?? 20000);
const CENTER = { lng: 81.6296, lat: 21.2514 };

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
/** Random point within `km` of the centre (uniform over the disc). */
function pointNear(km: number) {
  const r = km * Math.sqrt(Math.random());
  const t = Math.random() * 2 * Math.PI;
  return { lng: CENTER.lng + (r * Math.cos(t)) / 103.9, lat: CENTER.lat + (r * Math.sin(t)) / 110.6 };
}

async function seed() {
  if ((await Farm.estimatedDocumentCount()) >= FARMS) return console.log('dataset present — skipping seed');
  console.log(`seeding ${FARMS} farms…`);
  for (const m of [Product, Farm, Inventory, Order, Farmer, User]) await m.syncIndexes();
  const products = await Product.insertMany(CATALOGUE.map((p) => ({ ...p, isActive: true })));
  const hash = crypto.randomBytes(30).toString('hex'); // unusable "password hash"

  const users = await User.insertMany(
    Array.from({ length: FARMS }, (_, i) => ({ name: `Bench Farmer ${i}`, email: `farmer${i}@bench.khetse.test`, passwordHash: hash, role: 'farmer' })),
  );
  const farmers = await Farmer.insertMany(
    users.map((u) => ({
      user: u._id,
      profileStatus: 'verified',
      organicCertification: { status: Math.random() < 0.3 ? 'verified' : 'unsubmitted' },
      ratingAvg: Math.round(rand(3, 5) * 10) / 10,
      ratingCount: Math.floor(rand(0, 200)),
    })),
  );
  const farms = await Farm.insertMany(
    farmers.map((f, i) => {
      const p = pointNear(40);
      return {
        farmer: f._id,
        name: `Bench Farm ${i}`,
        city: 'raipur',
        address: { line1: 'x', state: 'Chhattisgarh', pincode: '492001' },
        location: { type: 'Point', coordinates: [p.lng, p.lat] },
        deliveryRadiusKm: Math.round(rand(5, 20)),
        isActive: Math.random() > 0.05,
        deliveryAvailable: true,
      };
    }),
  );

  const listings = farms.flatMap((farm) => {
    const chosen = [...products].sort(() => Math.random() - 0.5).slice(0, Math.floor(rand(10, 20)));
    return chosen.map((p) => ({
      farmer: farm.farmer,
      farm: farm._id,
      product: p._id,
      productName: p.name,
      productType: p.type,
      category: p.category,
      city: 'raipur',
      farmLocation: farm.location,
      price: Math.round(rand(15, 150)),
      unit: p.defaultUnit,
      packSizeGrams: p.defaultUnit === 'packet' ? 200 : undefined,
      quantityAvailable: Math.random() < 0.1 ? 0 : Math.round(rand(1, 300)),
      minOrderQty: 1,
      ...(p.type === 'fresh'
        ? { harvestDate: new Date(Date.now() - rand(0, 6) * 86400000) }
        : { processedDate: new Date(Date.now() - 30 * 86400000), expiryDate: new Date(Date.now() + 200 * 86400000) }),
      isActive: Math.random() > 0.05,
    }));
  });
  for (let i = 0; i < listings.length; i += 5000) await Inventory.insertMany(listings.slice(i, i + 5000), { lean: true });

  const customer = new Types.ObjectId();
  const statuses = ['pending', 'accepted', 'packed', 'out_for_delivery', 'delivered', 'delivered', 'delivered', 'rejected', 'cancelled'] as const;
  for (let i = 0; i < ORDERS; i += 2000) {
    await Order.insertMany(
      Array.from({ length: Math.min(2000, ORDERS - i) }, (_, j) => {
        const fs = [pick(farms), pick(farms)];
        return {
          orderNumber: `BENCH-${i + j}`,
          customer: Math.random() < 0.01 ? customer : new Types.ObjectId(),
          idempotencyKey: `bench-${i + j}`,
          address: { name: 'x', phone: '9999999999', line1: 'x', city: 'Raipur', pincode: '492001', location: { type: 'Point', coordinates: [CENTER.lng, CENTER.lat] } },
          groups: fs.map((f) => ({
            farmer: f.farmer, farm: f._id, farmName: f.name, farmerName: 'x', items: [], subtotal: 100, deliveryFee: 20, total: 120,
            distanceKm: 5, status: pick([...statuses]), history: [], handoverCode: '1234', paymentCollected: false,
          })),
          itemsTotal: 200, deliveryTotal: 40, grandTotal: 240, paymentMethod: 'cod', paymentStatus: 'cod_pending', status: 'placed',
          createdAt: new Date(Date.now() - rand(0, 90) * 86400000),
        };
      }),
      { lean: true },
    );
  }
  console.log(`seeded: ${farms.length} farms, ${listings.length} listings, ${ORDERS} orders`);
}

async function time(label: string, runs: number, fn: (i: number) => Promise<unknown>) {
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = process.hrtime.bigint();
    await fn(i);
    ms.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  ms.sort((a, b) => a - b);
  const p = (q: number) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))].toFixed(1);
  console.log(`${label.padEnd(44)} p50 ${p(0.5).padStart(7)} ms   p95 ${p(0.95).padStart(7)} ms   max ${p(1).padStart(7)} ms`);
}

/** Summarises an explain() plan: stages, index used, keys/docs examined. */
function summarise(label: string, exp: Record<string, unknown>) {
  const json = JSON.stringify(exp);
  const stages = [...new Set([...json.matchAll(/"stage":"([A-Z_]+)"/g)].map((m) => m[1]))];
  const indexes = [...new Set([...json.matchAll(/"indexName":"([^"]+)"/g)].map((m) => m[1]))];
  const keys = [...json.matchAll(/"totalKeysExamined":(\d+)/g)].reduce((s, m) => s + Number(m[1]), 0);
  const docs = [...json.matchAll(/"totalDocsExamined":(\d+)/g)].reduce((s, m) => s + Number(m[1]), 0);
  const nRet = [...json.matchAll(/"nReturned":(\d+)/g)].map((m) => Number(m[1]))[0];
  console.log(`  ${label}\n    stages: ${stages.join(' > ')}\n    indexes: ${indexes.join(', ') || '— none —'}   keys: ${keys}  docs: ${docs}  returned: ${nRet}`);
}

async function main() {
  if (!/bench/i.test(new URL(URI).pathname)) throw new Error(`Refusing to run: database in ${URI} must contain "bench"`);
  process.env.MONGODB_URI = URI;
  process.env.MONGO_AUTO_INDEX = 'false'; // indexes are synced explicitly below
  // When dropping, don't let model initialisation recreate empty collections afterwards.
  if (process.argv.includes('--drop')) mongoose.set('autoCreate', false);
  const { connectDatabase, disconnectDatabase } = await import('../config/db');
  await connectDatabase();
  try {
    if (process.argv.includes('--drop')) {
      await mongoose.connection.dropDatabase();
      return console.log('benchmark database dropped');
    }
    await seed();
    for (const m of [Farm, Inventory, Order]) await m.syncIndexes();

    const rec = await import('../services/recommendation/recommendation.service');
    const orders = await import('../services/order/order.service');
    const points = Array.from({ length: 30 }, () => pointNear(15)); // distinct points → no cache hits
    const base = { page: 1, limit: 12, sort: 'recommended' as const };

    console.log(`\n── timings (${(await Inventory.estimatedDocumentCount()).toLocaleString()} listings, ${(await Farm.estimatedDocumentCount()).toLocaleString()} farms) ──`);
    await time('recommended farms (default radius)', 30, (i) => rec.nearbyFarms({ ...points[i], ...base }));
    await time('recommended farms, 25 km radius', 15, (i) => rec.nearbyFarms({ ...points[i], ...base, radiusKm: 25, lng: points[i].lng + 1e-4 }));
    await time('recommended products (default radius)', 30, (i) =>
      rec.nearbyListings({ ...points[i], lng: points[i].lng + 2e-4, ...base, limit: 24 }),
    );
    await time('product search "tom", price sort', 30, (i) =>
      rec.nearbyListings({ ...points[i], lng: points[i].lng + 3e-4, ...base, q: 'tom', sort: 'price_asc', limit: 24 }),
    );
    await time('category filter (leafy greens)', 30, (i) =>
      rec.nearbyListings({ ...points[i], lng: points[i].lng + 4e-4, ...base, category: 'leafy-greens', limit: 24 }),
    );

    const someFarmer = (await Farmer.findOne())!;
    const someUser = await User.findById(someFarmer.user);
    await time('farmer order queue (incoming)', 30, () => orders.listForFarmer(String(someUser!._id), 'incoming', 1, 20));
    await time('farmer order queue (completed)', 30, () => orders.listForFarmer(String(someUser!._id), 'completed', 1, 20));
    const cust = await Order.findOne({ orderNumber: /^BENCH/ }).sort({ customer: 1 });
    await time('customer order history', 30, () => orders.listForCustomer(String(cust!.customer), 1, 10));
    await time('expiry sweep (no expired orders)', 30, () => orders.expireUnpaidOrders());

    console.log('\n── query plans ──');
    const p = points[0];
    summarise(
      'listings $geoNear (8 km, active, in stock)',
      (await Inventory.aggregate([
        { $geoNear: { near: { type: 'Point', coordinates: [p.lng, p.lat] }, key: 'farmLocation', distanceField: 'd', maxDistance: 8000, spherical: true, query: { isActive: true, quantityAvailable: { $gt: 0 } } } },
        { $limit: 1000 },
      ]).explain('executionStats')) as Record<string, unknown>,
    );
    summarise(
      'farms $geoNear (8 km, open, delivering)',
      (await Farm.aggregate([
        { $geoNear: { near: { type: 'Point', coordinates: [p.lng, p.lat] }, key: 'location', distanceField: 'd', maxDistance: 8000, spherical: true, query: { isActive: true, deliveryAvailable: true } } },
      ]).explain('executionStats')) as Record<string, unknown>,
    );
    summarise('inventory of one farm (lookup side)', (await Inventory.find({ farm: (await Farm.findOne())!._id, isActive: true }).explain('executionStats')) as unknown as Record<string, unknown>);
    summarise(
      'farmer queue: groups.$elemMatch farmer+status',
      (await Order.find({ groups: { $elemMatch: { farmer: someFarmer._id, status: { $in: ['pending'] } } } }).sort({ createdAt: 1 }).limit(20).explain('executionStats')) as unknown as Record<string, unknown>,
    );
    summarise('customer history', (await Order.find({ customer: cust!.customer }).sort({ createdAt: -1 }).limit(10).explain('executionStats')) as unknown as Record<string, unknown>);
    summarise('expiry sweep', (await Order.find({ paymentStatus: 'pending', reservationExpiresAt: { $lte: new Date() } }).limit(100).explain('executionStats')) as unknown as Record<string, unknown>);
  } finally {
    await disconnectDatabase();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
