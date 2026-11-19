/**
 * Algorithm test bed for Durg–Bhilai: farms and customers at real places (OpenStreetMap, see
 * data/durg-bhilai.places.json) with attributes chosen to exercise every rule of discovery,
 * ranking and checkout. Run `npm run algo:check` afterwards to verify the API against an
 * independent calculation.
 *
 *   npm run seed:algo            # create / refresh the test bed
 *   npm run seed:algo -- --reset # remove it
 *
 * What each farm is for is written next to it. Accounts use @algo.khetse.test and
 * DEMO_PASSWORD; customers log in with their mobile numbers (93000000xx). Dev only.
 */
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { connectDatabase, disconnectDatabase } from '../config/db';
import { env } from '../config/env';
import { User } from '../models/User';
import { Farmer } from '../models/Farmer';
import { Farm } from '../models/Farm';
import { Product } from '../models/Product';
import { Inventory } from '../models/Inventory';
import { Address } from '../models/Address';
import { Order } from '../models/Order';
import { toPoint } from '../models/common';
import { invalidateRecommendations } from '../config/cache';
import { logger } from '../utils/logger';
import places from './data/durg-bhilai.places.json';

export const ALGO_DOMAIN = 'algo.khetse.test';
const DAY = 86_400_000;

type Place = { name: string; lat: number; lng: number; pincode: string | null };
const village = (name: string): Place => {
  const p = (places.villages as Place[]).find((v) => v.name === name) ?? (places.urban as Place[]).find((v) => v.name === name);
  if (!p) throw new Error(`No coordinates for ${name}`);
  return p;
};
/** Moves a point by km east / north (good to a few metres at this latitude). */
export const offset = (p: { lat: number; lng: number }, eastKm: number, northKm: number) => ({
  lat: +(p.lat + northKm / 110.574).toFixed(6),
  lng: +(p.lng + eastKm / (111.32 * Math.cos((p.lat * Math.PI) / 180))).toFixed(6),
});

/** [slug, price, quantity, age in days (harvest for fresh, processing for dry), extra] */
type Item = [slug: string, price: number, qty: number, ageDays: number, extra?: { inactive?: boolean; minOrderQty?: number; packSizeGrams?: number }];

interface AlgoFarm {
  key: string;
  farmer: string;
  at: Place | { name: string; lat: number; lng: number; pincode: string | null };
  radiusKm: number;
  rating: [avg: number, count: number];
  organic: 'verified' | 'claim' | 'none';
  /** Why this farm exists, i.e. which rule it tests. */
  purpose: string;
  items: Item[];
  farmInactive?: boolean;
  deliveryOff?: boolean;
  farmerSuspended?: boolean;
}

const utai = village('Utai');
const khapri = village('Khapri');

export const ALGO_FARMS: AlgoFarm[] = [
  // ── Same product, three farms side by side: ranking must reflect price, freshness, rating, organic ──
  { key: 'utai-a', farmer: 'Savitri Sahu', at: utai, radiusKm: 15, rating: [4.8, 120], organic: 'verified',
    purpose: 'Ranking: cheapest, freshest, best-rated, organic tomato in the Utai cluster',
    items: [['tomato', 30, 200, 0], ['spinach', 28, 60, 0], ['okra', 44, 50, 1], ['coriander', 15, 80, 0]] },
  { key: 'utai-b', farmer: 'Bhola Ram Verma', at: { ...offset(utai, 1.2, 0), name: 'Utai', pincode: utai.pincode }, radiusKm: 15, rating: [3.2, 6], organic: 'none',
    purpose: 'Ranking: dearest tomato, poorly rated, not organic',
    items: [['tomato', 42, 150, 2], ['brinjal', 30, 90, 1], ['potato', 26, 300, 4]] },
  { key: 'utai-c', farmer: 'Kiran Dhruw', at: { ...offset(utai, -1, 0.5), name: 'Utai', pincode: utai.pincode }, radiusKm: 12, rating: [0, 0], organic: 'none',
    purpose: 'Ranking: unrated farmer (Bayesian prior), 5-day-old tomato',
    items: [['tomato', 36, 120, 5], ['cauliflower', 34, 40, 1]] },

  // ── Delivery-area edges ──
  { key: 'khapri-edge', farmer: 'Ramesh Yadav', at: khapri, radiusKm: 3, rating: [4.2, 25], organic: 'none',
    purpose: 'Boundary: delivers only 3 km. Test customers sit at 2.8, 2.95, 3.03, 3.05 and 3.2 km',
    items: [['spinach', 30, 50, 0], ['coriander', 16, 70, 0]] },
  { key: 'jamul-roof', farmer: 'Sushila Nishad', at: village('Jamul'), radiusKm: 8, rating: [4.4, 18], organic: 'claim',
    purpose: 'Organic claimed but not verified: must not count as organic',
    items: [['coriander', 18, 60, 0], ['spinach', 32, 40, 1], ['green-chilli', 70, 25, 1]] },
  { key: 'risali-organic', farmer: 'Geeta Sinha', at: village('Risali'), radiusKm: 7, rating: [4.6, 30], organic: 'verified',
    purpose: 'Organic filter: verified certificate',
    items: [['spinach', 34, 40, 0], ['tomato', 38, 100, 1]] },

  // ── Far away: appear only when the search widens ──
  { key: 'patan-far', farmer: 'Mahesh Chandrakar', at: village('Patan'), radiusKm: 30, rating: [4.9, 80], organic: 'verified',
    purpose: 'Radius expansion: ~25 km from Bhilai, large delivery area',
    items: [['tomato', 33, 400, 1], ['potato', 24, 600, 5], ['onion', 28, 500, 6]] },
  { key: 'kachandur-south', farmer: 'Phoolbai Sahu', at: village('Kachandur'), radiusKm: 25, rating: [3.8, 12], organic: 'none',
    purpose: 'Radius expansion from the south',
    items: [['potato', 23, 500, 6], ['onion', 26, 400, 8]] },
  { key: 'dhamdha-bulk', farmer: 'Rameshwar Patel', at: village('Dhamdha'), radiusKm: 25, rating: [4.1, 200], organic: 'none',
    purpose: 'Diversity: 10 listings from one farm must not fill the whole first page',
    items: [['tomato', 31, 500, 1], ['potato', 22, 900, 6], ['onion', 25, 900, 8], ['cabbage', 26, 200, 2], ['cauliflower', 30, 150, 1],
      ['brinjal', 28, 200, 1], ['carrot', 40, 200, 2], ['garlic', 150, 100, 20], ['green-peas', 60, 80, 0], ['green-beans', 50, 90, 1]] },

  // ── Rural spread ──
  { key: 'machandur', farmer: 'Lakhan Sahu', at: village('Machandur'), radiusKm: 20, rating: [3.9, 15], organic: 'none',
    purpose: 'Coverage south of Durg', items: [['green-peas', 62, 60, 0], ['green-beans', 52, 70, 1], ['carrot', 44, 100, 2]] },
  { key: 'somni', farmer: 'Dinesh Kurre', at: village('Somni'), radiusKm: 18, rating: [4.0, 22], organic: 'none',
    purpose: 'Coverage west of Durg', items: [['carrot', 42, 120, 2], ['garlic', 160, 40, 15], ['onion', 27, 300, 7]] },
  { key: 'kumhari-highway', farmer: 'Anil Sahu', at: village('Kumhari'), radiusKm: 15, rating: [3.6, 40], organic: 'none',
    purpose: 'Between Bhilai and Raipur: cheap tomato', items: [['tomato', 28, 300, 1], ['onion', 24, 400, 6]] },
  { key: 'khursipar-budget', farmer: 'Shankar Dewangan', at: village('Khursipar'), radiusKm: 10, rating: [3.0, 2], organic: 'none',
    purpose: 'Price sort: lowest prices, low rating', items: [['tomato', 26, 200, 2], ['potato', 21, 300, 5], ['onion', 23, 300, 6]] },
  { key: 'maroda-fresh', farmer: 'Usha Thakur', at: village('Maroda'), radiusKm: 9, rating: [4.3, 35], organic: 'none',
    purpose: 'Everyday vegetables near Risali', items: [['brinjal', 32, 80, 0], ['okra', 46, 60, 0], ['cauliflower', 33, 50, 1]] },

  // ── Things that must never be offered ──
  { key: 'murmunda-dry', farmer: 'Hemlata Verma', at: village('Murmunda'), radiusKm: 25, rating: [4.7, 50], organic: 'verified',
    purpose: 'Expiry: the sun-dried tomato expired 30 days ago and must not be offered',
    items: [['dried-red-chilli', 90, 120, 30, { packSizeGrams: 200 }], ['kasuri-methi', 60, 100, 40, { packSizeGrams: 100 }],
      ['sun-dried-tomato', 140, 50, 300, { packSizeGrams: 150 }]] },
  { key: 'ahiwara-stale', farmer: 'Kamal Nishad', at: village('Ahiwara'), radiusKm: 20, rating: [4.0, 10], organic: 'none',
    purpose: 'Shelf life: spinach harvested 6 days ago (3-day shelf life) must not be offered',
    items: [['cabbage', 27, 120, 2], ['cauliflower', 31, 80, 1], ['spinach', 25, 40, 6]] },
  { key: 'borsi-nodelivery', farmer: 'Prakash Banjare', at: village('Borsi'), radiusKm: 6, rating: [4.5, 20], organic: 'none', deliveryOff: true,
    purpose: 'Farm with delivery switched off: never shown', items: [['tomato', 30, 100, 0]] },
  { key: 'kurud-inactive', farmer: 'Sunil Tandon', at: { ...offset(village('Kurud'), 0.5, 0.5), name: 'Kurud', pincode: null }, radiusKm: 10, rating: [4.0, 10], organic: 'none', farmInactive: true,
    purpose: 'Inactive farm: never shown', items: [['tomato', 29, 100, 0]] },
  { key: 'supela-suspended', farmer: 'Vijay Markam', at: { ...offset(village('Supela'), 0.4, -0.3), name: 'Supela', pincode: null }, radiusKm: 10, rating: [4.9, 300], organic: 'verified', farmerSuspended: true,
    purpose: 'Suspended farmer: never shown even with the best rating', items: [['tomato', 25, 300, 0], ['spinach', 20, 100, 0]] },
  { key: 'nehru-soldout', farmer: 'Rekha Sahu', at: { ...offset(village('Nehru Nagar'), -0.3, 0.2), name: 'Nehru Nagar', pincode: null }, radiusKm: 8, rating: [4.2, 15], organic: 'none',
    purpose: 'Sold out: zero stock is never shown, and the farm is hidden from farm lists', items: [['tomato', 30, 0, 0], ['spinach', 26, 0, 0]] },
  { key: 'smriti-mixed', farmer: 'Arvind Sonkar', at: { ...offset(village('Smriti Nagar'), 0.3, 0.3), name: 'Smriti Nagar', pincode: null }, radiusKm: 8, rating: [4.0, 9], organic: 'none',
    purpose: 'Paused listing: the paused okra must not show; the active coriander must',
    items: [['okra', 40, 50, 0, { inactive: true }], ['coriander', 14, 60, 0]] },
];

/** Customers: one per real locality, plus test points around the 3 km boundary farm. */
export function algoCustomers() {
  const urban = (places.urban as Place[]).map((p, i) => ({ key: `c${String(i + 1).padStart(2, '0')}`, name: `${p.name} Resident`, area: p.name, lat: p.lat, lng: p.lng, pincode: p.pincode ?? '490001' }));
  const edge = [2.8, 2.95, 3.03, 3.05, 3.2].map((km, i) => {
    const p = offset(khapri, 0, km);
    return { key: `edge${i + 1}`, name: `Edge ${km} km`, area: `${km} km north of Khapri`, lat: p.lat, lng: p.lng, pincode: '490020' };
  });
  return [...urban, ...edge];
}

const emailRe = new RegExp(`@${ALGO_DOMAIN.replace(/\./g, '\\.')}$`);

async function reset() {
  const users = await User.find({ email: emailRe }, '_id');
  const ids = users.map((u) => u._id);
  const farmers = await Farmer.find({ user: { $in: ids } }, '_id');
  const farmerIds = farmers.map((f) => f._id);
  const orders = await Order.countDocuments({ $or: [{ customer: { $in: ids } }, { 'groups.farmer': { $in: farmerIds } }] });
  if (orders) logger.warn(`${orders} orders reference test-bed accounts; they are kept (delete them first for a clean slate)`);
  await Promise.all([Inventory.deleteMany({ farmer: { $in: farmerIds } }), Farm.deleteMany({ farmer: { $in: farmerIds } }), Address.deleteMany({ user: { $in: ids } })]);
  await Farmer.deleteMany({ _id: { $in: farmerIds } });
  await User.deleteMany({ _id: { $in: ids } });
  logger.info(`Algorithm test bed removed: ${users.length} accounts`);
}

async function seed() {
  const products = new Map((await Product.find({ isActive: true })).map((p) => [p.slug, p]));
  if (!products.size) throw new Error('Catalogue is empty — run `npm run seed:catalogue` first');
  const passwordHash = await bcrypt.hash(process.env.DEMO_PASSWORD || crypto.randomBytes(24).toString('hex'), 10);
  const now = Date.now();
  let listings = 0;

  for (const [i, f] of ALGO_FARMS.entries()) {
    const user = await User.findOneAndUpdate(
      { email: `${f.key}@${ALGO_DOMAIN}` },
      { $set: { name: f.farmer, phone: `92000000${String(i + 1).padStart(2, '0')}`, role: 'farmer', status: f.farmerSuspended ? 'suspended' : 'active', passwordHash } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    const farmer = await Farmer.findOneAndUpdate(
      { user: user._id },
      {
        $set: {
          bio: f.purpose,
          experienceYears: 5 + (i % 20),
          languages: ['Hindi', 'Chhattisgarhi'],
          practices: f.organic === 'verified' ? ['certified-organic'] : ['crop-rotation'],
          profileStatus: 'verified',
          organicCertification:
            f.organic === 'verified'
              ? { status: 'verified', certificateNumber: `PGS-CG-ALGO-${i + 1}`, issuer: 'PGS-India (test)' }
              : { status: 'unsubmitted' },
          ratingAvg: f.rating[0],
          ratingCount: f.rating[1],
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    const location = toPoint(f.at.lng, f.at.lat);
    const farm = await Farm.findOneAndUpdate(
      { farmer: farmer._id },
      {
        $set: {
          name: f.farmer.split(' ')[0] + "'s " + (f.key.split('-')[0]![0]!.toUpperCase() + f.key.split('-')[0]!.slice(1)) + ' Farm',
          description: f.purpose,
          city: 'durg-bhilai',
          address: { line1: `Near ${f.at.name} panchayat`, village: f.at.name, district: 'Durg', state: 'Chhattisgarh', pincode: f.at.pincode ?? '491001' },
          location,
          images: [],
          deliveryRadiusKm: f.radiusKm,
          deliveryAvailable: !f.deliveryOff,
          pickupAvailable: false,
          isActive: !f.farmInactive,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    await Inventory.deleteMany({ farm: farm._id });
    for (const [slug, price, qty, age, extra] of f.items) {
      const p = products.get(slug);
      if (!p) throw new Error(`Unknown product ${slug}`);
      const dates =
        p.type === 'fresh'
          ? { harvestDate: new Date(now - age * DAY) }
          : { processedDate: new Date(now - age * DAY), expiryDate: new Date(now - age * DAY + p.shelfLifeDays * DAY) };
      await Inventory.create({
        farmer: farmer._id,
        farm: farm._id,
        product: p._id,
        productName: p.name,
        productType: p.type,
        category: p.category,
        city: farm.city,
        farmLocation: location,
        price,
        unit: p.type === 'dry' ? 'packet' : p.defaultUnit,
        packSizeGrams: extra?.packSizeGrams,
        quantityAvailable: qty,
        quantityReserved: 0,
        minOrderQty: extra?.minOrderQty ?? 1,
        ...dates,
        packaging: p.type === 'dry' ? 'Kraft paper pouch' : undefined,
        organicClaim: f.organic !== 'none',
        isActive: !extra?.inactive,
        images: [],
      });
      listings++;
    }
  }

  const customers = algoCustomers();
  for (const [i, c] of customers.entries()) {
    const phone = `93000000${String(i + 1).padStart(2, '0')}`;
    const user = await User.findOneAndUpdate(
      { email: `${c.key}@${ALGO_DOMAIN}` },
      { $set: { name: c.name, phone, role: 'customer', status: 'active', passwordHash } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    await Address.deleteMany({ user: user._id });
    await Address.create({
      user: user._id, label: 'home', name: c.name, phone, line1: `House ${i + 1}, ${c.area}`, landmark: c.area,
      city: 'Durg', pincode: c.pincode, location: toPoint(c.lng, c.lat), isDefault: true,
    });
  }
  await invalidateRecommendations();
  logger.info(`Algorithm test bed ready: ${ALGO_FARMS.length} farms (${listings} listings), ${customers.length} customers in Durg–Bhilai`);
  logger.info('Customers log in with mobile 9300000001… and DEMO_PASSWORD. Next: npm run algo:check');
}

async function main() {
  if (env.NODE_ENV === 'production') throw new Error('seed:algo is for development only');
  await connectDatabase();
  if (process.argv.includes('--reset')) await reset();
  else await seed();
}

if (require.main === module) {
  main()
    .catch((err) => {
      logger.error('Algorithm seed failed', err);
      process.exitCode = 1;
    })
    .finally(disconnectDatabase);
}
