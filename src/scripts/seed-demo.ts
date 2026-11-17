/**
 * Demo marketplace around Raipur, Chhattisgarh — fictional farmers, real coordinates.
 * Lets you try discovery and recommendations before real farmers join.
 *
 *   npm run seed:demo            # create / refresh demo data
 *   npm run seed:demo -- --reset # remove all demo data
 *
 * Demo accounts use the @demo.khetse.test email domain. Their passwords are random and
 * unusable unless DEMO_PASSWORD is set in the environment when seeding.
 * Ratings on demo farmers are illustrative placeholders, not real customer reviews.
 */
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { connectDatabase, disconnectDatabase } from '../config/db';
import { User } from '../models/User';
import { Farmer } from '../models/Farmer';
import { Farm } from '../models/Farm';
import { Product } from '../models/Product';
import { Inventory } from '../models/Inventory';
import { toPoint } from '../models/common';
import { logger } from '../utils/logger';

const DOMAIN = 'demo.khetse.test';
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(Date.now() - d * DAY);
const daysAhead = (d: number) => new Date(Date.now() + d * DAY);

type Item = [slug: string, price: number, qty: number, ageDays: number, unit?: string, packSizeGrams?: number];

interface DemoFarm {
  key: string;
  farmer: string;
  phone: string;
  bio: string;
  years: number;
  practices: string[];
  organic: boolean;
  rating: [avg: number, count: number];
  farm: {
    name: string;
    village: string;
    district: string;
    pincode: string;
    lng: number;
    lat: number;
    radiusKm: number;
    pickup: boolean;
    images: string[];
    description: string;
    areaAcres: number;
  };
  items: Item[];
}

// Distances are from central Raipur (21.2514, 81.6296).
const FARMS: DemoFarm[] = [
  {
    key: 'tatibandh', farmer: 'Lakshmi Sahu', phone: '9000000101', years: 18, organic: true, rating: [4.8, 64],
    bio: 'We grow leafy greens and tomatoes on our family plot without chemical sprays. Picked every morning.',
    practices: ['certified-organic', 'vermicompost', 'drip-irrigation'],
    farm: { name: 'Tatibandh Green Plot', village: 'Tatibandh', district: 'Raipur', pincode: '492099', lng: 81.5855, lat: 21.2585, radiusKm: 10, pickup: true,
      images: ['/images/site/farm-nilgiris.jpg', '/images/catalogue/spinach.jpg'], description: 'Two acres of greens beside the canal.', areaAcres: 2 },
    items: [['spinach', 30, 60, 0], ['coriander', 15, 80, 0], ['tomato', 38, 150, 1], ['green-chilli', 70, 20, 1], ['okra', 45, 40, 1]],
  },
  {
    key: 'saddu', farmer: 'Rajesh Yadav', phone: '9000000102', years: 12, organic: false, rating: [4.4, 31],
    bio: 'Vegetable grower supplying north Raipur. Seasonal produce, fair prices.',
    practices: ['crop-rotation', 'drip-irrigation'],
    farm: { name: 'Saddu Kitchen Garden', village: 'Saddu', district: 'Raipur', pincode: '492014', lng: 81.6630, lat: 21.2990, radiusKm: 8, pickup: false,
      images: ['/images/site/farm-punjab-harvest.jpg'], description: 'Mixed vegetables on 5 acres.', areaAcres: 5 },
    items: [['tomato', 34, 300, 2], ['potato', 28, 500, 6], ['onion', 32, 400, 8], ['cauliflower', 35, 50, 2, 'piece'], ['cabbage', 30, 60, 3, 'piece'], ['brinjal', 36, 80, 2]],
  },
  {
    key: 'amleshwar', farmer: 'Sunita Verma', phone: '9000000103', years: 9, organic: true, rating: [4.9, 12],
    bio: 'Natural farming on the banks of the Kharun. Small batches, harvested to order.',
    practices: ['natural-farming', 'no-chemical-pesticides'],
    farm: { name: 'Kharun River Farm', village: 'Amleshwar', district: 'Durg', pincode: '491111', lng: 81.5960, lat: 21.1830, radiusKm: 12, pickup: true,
      images: ['/images/site/farm-rows.jpg', '/images/catalogue/carrot.jpg'], description: 'River-silt soil, ideal for roots.', areaAcres: 3 },
    items: [['carrot', 48, 90, 1], ['green-peas', 70, 40, 0], ['green-beans', 60, 35, 1], ['spinach', 35, 30, 0], ['garlic', 180, 25, 20]],
  },
  {
    key: 'mandir-hasaud', farmer: 'Mohan Patel', phone: '9000000104', years: 22, organic: false, rating: [4.2, 88],
    bio: 'Large family farm east of Raipur. Onions, potatoes and garlic all year.',
    practices: ['crop-rotation'],
    farm: { name: 'Hari Bhari Kheti', village: 'Mandir Hasaud', district: 'Raipur', pincode: '492101', lng: 81.7738, lat: 21.2260, radiusKm: 18, pickup: false,
      images: ['/images/site/farm-handshake.jpg'], description: 'Twenty acres of staples.', areaAcres: 20 },
    items: [['onion', 26, 2000, 10], ['potato', 24, 2500, 12], ['garlic', 150, 300, 30], ['tomato', 30, 600, 3]],
  },
  {
    key: 'gondwara', farmer: 'Kavita Dewangan', phone: '9000000105', years: 7, organic: true, rating: [4.7, 40],
    bio: 'We sun-dry our own chillies, tomatoes and methi in small batches. No preservatives.',
    practices: ['certified-organic', 'no-chemical-pesticides'],
    farm: { name: 'Gondwara Sun-Dried', village: 'Gondwara', district: 'Raipur', pincode: '492003', lng: 81.6105, lat: 21.2805, radiusKm: 15, pickup: true,
      images: ['/images/site/farm-guntur-chilli-drying.jpg', '/images/catalogue/dried-red-chilli.jpg'], description: 'Drying yards and a small packing room.', areaAcres: 1.5 },
    items: [['dried-red-chilli', 90, 120, 20, 'packet', 200], ['sun-dried-tomato', 140, 60, 15, 'packet', 150], ['kasuri-methi', 60, 150, 25, 'packet', 100],
      ['dried-onion', 110, 40, 30, 'packet', 250], ['dehydrated-vegetable-mix', 120, 50, 10, 'packet', 200], ['green-chilli', 60, 30, 0]],
  },
  {
    key: 'dharsiwa', farmer: 'Dinesh Chandrakar', phone: '9000000106', years: 15, organic: false, rating: [3.9, 22],
    bio: 'Cabbage, cauliflower and gourds from Dharsiwa.',
    practices: ['drip-irrigation'],
    farm: { name: 'Dharsiwa Greens', village: 'Dharsiwa', district: 'Raipur', pincode: '493221', lng: 81.6600, lat: 21.3740, radiusKm: 20, pickup: false,
      images: ['/images/site/farm-himachal-cabbage.jpg'], description: 'Brassicas through the winter.', areaAcres: 8 },
    items: [['cabbage', 25, 200, 2, 'piece'], ['cauliflower', 32, 150, 1, 'piece'], ['brinjal', 30, 120, 3], ['tomato', 32, 200, 4]],
  },
  {
    key: 'naya-raipur', farmer: 'Meena Nishad', phone: '9000000107', years: 5, organic: true, rating: [5.0, 3],
    bio: 'A young natural-farming plot near Nava Raipur.',
    practices: ['natural-farming', 'vermicompost'],
    farm: { name: 'Nava Raipur Natural Farm', village: 'Rakhi', district: 'Raipur', pincode: '492101', lng: 81.7900, lat: 21.1600, radiusKm: 25, pickup: true,
      images: ['/images/site/farm-nilgiris.jpg'], description: 'Started in 2022 on fallow land.', areaAcres: 2.5 },
    items: [['okra', 50, 30, 0], ['green-beans', 55, 25, 0], ['coriander', 18, 40, 0], ['spinach', 32, 25, 1]],
  },
  {
    // ~22 km out — only appears when the search widens beyond the default radius.
    key: 'abhanpur', farmer: 'Ramesh Sahu', phone: '9000000108', years: 30, organic: true, rating: [4.6, 120],
    bio: 'Three generations of organic farming in Abhanpur. Known for our desi tomatoes.',
    practices: ['certified-organic', 'vermicompost', 'crop-rotation'],
    farm: { name: 'Abhanpur Organic Fields', village: 'Abhanpur', district: 'Raipur', pincode: '493661', lng: 81.7440, lat: 21.0540, radiusKm: 30, pickup: false,
      images: ['/images/site/farm-punjab-harvest.jpg'], description: 'Twelve certified acres.', areaAcres: 12 },
    items: [['tomato', 36, 400, 1], ['potato', 30, 300, 5], ['carrot', 44, 120, 2], ['dried-red-chilli', 85, 60, 40, 'packet', 200]],
  },
];

async function reset() {
  const users = await User.find({ email: new RegExp(`@${DOMAIN.replace(/\./g, '\\.')}$`) }, '_id');
  const farmers = await Farmer.find({ user: { $in: users.map((u) => u._id) } }, '_id');
  const ids = farmers.map((f) => f._id);
  const [inv, farms] = await Promise.all([Inventory.deleteMany({ farmer: { $in: ids } }), Farm.deleteMany({ farmer: { $in: ids } })]);
  await Farmer.deleteMany({ _id: { $in: ids } });
  await User.deleteMany({ _id: { $in: users.map((u) => u._id) } });
  logger.info(`Demo data removed: ${users.length} users, ${farms.deletedCount} farms, ${inv.deletedCount} listings`);
}

async function seed() {
  const products = new Map((await Product.find({ isActive: true })).map((p) => [p.slug, p]));
  if (products.size === 0) throw new Error('Catalogue is empty — run `npm run seed:catalogue` first');

  const password = process.env.DEMO_PASSWORD || crypto.randomBytes(24).toString('hex');
  const passwordHash = await bcrypt.hash(password, 10);
  let listings = 0;

  for (const d of FARMS) {
    const user = await User.findOneAndUpdate(
      { email: `${d.key}@${DOMAIN}` },
      { $set: { name: d.farmer, phone: d.phone, role: 'farmer', status: 'active', passwordHash } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    const farmer = await Farmer.findOneAndUpdate(
      { user: user._id },
      {
        $set: {
          bio: d.bio,
          experienceYears: d.years,
          languages: ['Hindi', 'Chhattisgarhi'],
          practices: d.practices,
          profileStatus: 'verified',
          organicCertification: d.organic
            ? { status: 'verified', certificateNumber: `PGS-CG-DEMO-${d.key.toUpperCase()}`, issuer: 'PGS-India (demo)' }
            : { status: 'unsubmitted' },
          ratingAvg: d.rating[0],
          ratingCount: d.rating[1],
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    const f = d.farm;
    const farm = await Farm.findOneAndUpdate(
      { farmer: farmer._id, name: f.name },
      {
        $set: {
          description: f.description,
          city: 'raipur',
          address: { line1: `Near ${f.village} panchayat`, village: f.village, district: f.district, state: 'Chhattisgarh', pincode: f.pincode },
          location: toPoint(f.lng, f.lat),
          areaAcres: f.areaAcres,
          images: f.images,
          deliveryRadiusKm: f.radiusKm,
          deliveryAvailable: true,
          pickupAvailable: f.pickup,
          isActive: true,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    for (const [slug, price, qty, age, unit, pack] of d.items) {
      const p = products.get(slug);
      if (!p) {
        logger.warn(`Skipping unknown product ${slug}`);
        continue;
      }
      const dates =
        p.type === 'fresh'
          ? { harvestDate: daysAgo(age), processedDate: undefined, expiryDate: undefined }
          : { harvestDate: undefined, processedDate: daysAgo(age), expiryDate: daysAhead(p.shelfLifeDays - age) };
      await Inventory.findOneAndUpdate(
        { farm: farm._id, product: p._id },
        {
          $set: {
            farmer: farmer._id,
            productName: p.name,
            productType: p.type,
            category: p.category,
            city: farm.city,
            farmLocation: farm.location,
            price,
            unit: unit ?? p.defaultUnit,
            packSizeGrams: pack,
            quantityAvailable: qty,
            quantityReserved: 0,
            minOrderQty: 1,
            ...dates,
            packaging: p.type === 'dry' ? 'Kraft paper pouch' : undefined,
            organicClaim: d.organic,
            isActive: true,
          },
        },
        { upsert: true, setDefaultsOnInsert: true },
      );
      listings++;
    }
  }
  logger.info(`Demo data ready: ${FARMS.length} farms, ${listings} listings around Raipur`);
  if (process.env.DEMO_PASSWORD) logger.info(`Demo farmers can log in as <key>@${DOMAIN} with DEMO_PASSWORD`);
}

async function main() {
  await connectDatabase();
  await Promise.all([Farm.syncIndexes(), Inventory.syncIndexes()]);
  if (process.argv.includes('--reset')) await reset();
  else await seed();
}

main()
  .catch((err) => {
    logger.error('Demo seed failed', err);
    process.exitCode = 1;
  })
  .finally(disconnectDatabase);
