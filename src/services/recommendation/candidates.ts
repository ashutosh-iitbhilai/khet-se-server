/**
 * Candidate fetching for the recommendation engine.
 *
 * One $geoNear query finds candidates (index-backed, distances computed by MongoDB); the
 * farms, farmers and products they refer to are then loaded in a single `$in` query each
 * (catalogue from memory) and joined in code. On a city-sized dataset this replaced ~3,000
 * per-document $lookups per request with three batched reads — see `npm run bench`.
 */
import { Types } from 'mongoose';
import { Farm } from '../../models/Farm';
import { Farmer } from '../../models/Farmer';
import { Inventory } from '../../models/Inventory';
import { toPoint } from '../../models/common';
import { RECOMMENDATION } from '../../config/recommendation';
import { escapeRegex } from '../../utils/pagination';
import { activeCatalogue } from '../catalogue.cache';
import { sellableFilter } from './sellable';
import type { NearbyFarmersQuery, NearbyListingsQuery } from '../../validators/recommendation.validator';

export interface FarmerDoc {
  _id: Types.ObjectId;
  userDoc: { name: string };
  ratingAvg: number;
  ratingCount: number;
  profileStatus: string;
  experienceYears?: number;
  organicCertification?: { status?: string };
}

export interface ListingRow {
  _id: Types.ObjectId;
  product: Types.ObjectId;
  farm: Types.ObjectId;
  farmer: Types.ObjectId;
  productName: string;
  productType: 'fresh' | 'dry';
  category: string;
  price: number;
  unit: string;
  packSizeGrams?: number;
  quantityAvailable: number;
  minOrderQty: number;
  harvestDate?: Date;
  processedDate?: Date;
  expiryDate?: Date;
  packaging?: string;
  images?: string[] | null;
  organicClaim: boolean;
}

export interface RawListing extends ListingRow {
  distance: number; // metres
  farmDoc: {
    _id: Types.ObjectId;
    name: string;
    images?: string[] | null;
    address?: { village?: string; district?: string };
    deliveryRadiusKm: number;
    pickupAvailable: boolean;
  };
  farmerDoc: FarmerDoc;
  productDoc: { _id: Types.ObjectId; name: string; localName?: string; slug: string; image: string; shelfLifeDays: number };
}

export interface RawFarm {
  _id: Types.ObjectId;
  farmer: Types.ObjectId;
  name: string;
  images?: string[] | null;
  address?: { village?: string; district?: string };
  city: string;
  location: { coordinates: [number, number] };
  deliveryRadiusKm: number;
  pickupAvailable: boolean;
  distance: number;
  farmerDoc: FarmerDoc;
  listings: (ListingRow & { productDoc: { image: string; shelfLifeDays: number }[] })[];
}

const LISTING_FIELDS = {
  product: 1, farm: 1, farmer: 1, productName: 1, productType: 1, category: 1, price: 1, unit: 1, packSizeGrams: 1,
  quantityAvailable: 1, minOrderQty: 1, harvestDate: 1, processedDate: 1, expiryDate: 1, packaging: 1,
  images: { $slice: ['$images', 1] }, organicClaim: 1,
} as const;

const unique = (ids: Types.ObjectId[]) => [...new Set(ids.map(String))].map((id) => new Types.ObjectId(id));

/** Active farmers (active user account, profile not rejected by an admin), optionally organic-verified only. */
async function activeFarmers(ids: Types.ObjectId[], organicOnly?: boolean): Promise<Map<string, FarmerDoc>> {
  if (!ids.length) return new Map();
  const rows = await Farmer.find(
    { _id: { $in: ids }, profileStatus: { $ne: 'rejected' }, ...(organicOnly ? { 'organicCertification.status': 'verified' } : {}) },
    'user ratingAvg ratingCount profileStatus experienceYears organicCertification.status',
  )
    .populate<{ user: { name: string; status: string } | null }>('user', 'name status')
    .lean();
  return new Map(
    rows
      .filter((f) => f.user?.status === 'active')
      .map((f) => [String(f._id), { ...f, userDoc: { name: f.user!.name } } as unknown as FarmerDoc]),
  );
}

/** Listings near a point, joined to farm / farmer / product and filtered to what can be delivered. */
export async function fetchListingCandidates(lng: number, lat: number, radiusKm: number, q: NearbyListingsQuery): Promise<RawListing[]> {
  // Only what can actually be ordered: in stock for a minimum order, not expired, not past shelf life.
  const query: Record<string, unknown> = sellableFilter(await activeCatalogue());
  if (q.type) query.productType = q.type;
  if (q.category) query.category = q.category;
  if (q.maxPrice) query.price = { $lte: q.maxPrice };
  if (q.product) query.product = new Types.ObjectId(q.product);
  if (q.farm) query.farm = new Types.ObjectId(q.farm);
  if (q.q) query.productName = new RegExp(escapeRegex(q.q), 'i');

  const rows = await Inventory.aggregate<ListingRow & { distance: number }>([
    { $geoNear: { near: toPoint(lng, lat), key: 'farmLocation', distanceField: 'distance', maxDistance: radiusKm * 1000, spherical: true, query } },
    { $limit: RECOMMENDATION.candidateLimit },
    { $project: { ...LISTING_FIELDS, distance: 1 } },
  ]);
  if (!rows.length) return [];

  const [farms, farmers, catalogue] = await Promise.all([
    Farm.find(
      { _id: { $in: unique(rows.map((r) => r.farm)) }, isActive: true, deliveryAvailable: true },
      { name: 1, images: { $slice: 1 }, 'address.village': 1, 'address.district': 1, deliveryRadiusKm: 1, pickupAvailable: 1 },
    ).lean<RawListing['farmDoc'][]>(),
    activeFarmers(unique(rows.map((r) => r.farmer)), q.organic),
    activeCatalogue(),
  ]);
  const farmById = new Map(farms.map((f) => [String(f._id), f]));

  const out: RawListing[] = [];
  for (const r of rows) {
    const farmDoc = farmById.get(String(r.farm));
    const farmerDoc = farmers.get(String(r.farmer));
    const productDoc = catalogue.get(String(r.product));
    // The customer must be inside this farm's own delivery radius.
    if (!farmDoc || !farmerDoc || !productDoc || r.distance > farmDoc.deliveryRadiusKm * 1000) continue;
    out.push({ ...r, farmDoc, farmerDoc, productDoc });
  }
  return out;
}

/** Farms near a point that deliver here and currently have matching listings. */
export async function fetchFarmCandidates(lng: number, lat: number, radiusKm: number, q: NearbyFarmersQuery): Promise<RawFarm[]> {
  const farms = await Farm.aggregate<Omit<RawFarm, 'farmerDoc' | 'listings'>>([
    {
      $geoNear: {
        near: toPoint(lng, lat),
        key: 'location',
        distanceField: 'distance',
        maxDistance: radiusKm * 1000,
        spherical: true,
        query: { isActive: true, deliveryAvailable: true },
      },
    },
    { $match: { $expr: { $lte: ['$distance', { $multiply: ['$deliveryRadiusKm', 1000] }] } } },
    { $project: { farmer: 1, name: 1, images: 1, 'address.village': 1, 'address.district': 1, city: 1, location: 1, deliveryRadiusKm: 1, pickupAvailable: 1, distance: 1 } },
  ]);
  if (!farms.length) return [];

  const listingQuery: Record<string, unknown> = { farm: { $in: farms.map((f) => f._id) }, ...sellableFilter(await activeCatalogue()) };
  if (q.type) listingQuery.productType = q.type;
  if (q.category) listingQuery.category = q.category;
  if (q.maxPrice) listingQuery.price = { $lte: q.maxPrice };

  const [farmers, listings, catalogue] = await Promise.all([
    activeFarmers(unique(farms.map((f) => f.farmer)), q.organic),
    Inventory.find(listingQuery, { ...LISTING_FIELDS, images: { $slice: 1 } }).lean<ListingRow[]>(),
    activeCatalogue(),
  ]);

  const byFarm = new Map<string, RawFarm['listings']>();
  for (const l of listings) {
    const p = catalogue.get(String(l.product));
    if (!p) continue;
    const key = String(l.farm);
    const list = byFarm.get(key) ?? [];
    list.push({ ...l, productDoc: [{ image: p.image, shelfLifeDays: p.shelfLifeDays }] });
    byFarm.set(key, list);
  }

  const out: RawFarm[] = [];
  for (const f of farms) {
    const farmerDoc = farmers.get(String(f.farmer));
    const ls = byFarm.get(String(f._id));
    if (farmerDoc && ls?.length) out.push({ ...f, farmerDoc, listings: ls });
  }
  return out;
}
