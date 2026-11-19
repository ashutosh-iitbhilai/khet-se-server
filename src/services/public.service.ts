/**
 * Public read models: a single listing page and a farmer's profile page.
 * Distances, when a customer location is given, come from MongoDB $geoNear.
 */
import { Types } from 'mongoose';
import { isSellable, sellableFilter } from './recommendation/sellable';
import { activeCatalogue } from './catalogue.cache';
import { Farm } from '../models/Farm';
import { Farmer } from '../models/Farmer';
import { Inventory } from '../models/Inventory';
import { toPoint } from '../models/common';
import { ApiError } from '../utils/ApiError';
import {
  publicFarm,
  publicFarmerSummary,
  publicListing,
  type FarmerSource,
  type FarmSource,
  type ListingSource,
} from './listing.mapper';

type At = { lng: number; lat: number } | undefined;

/** Active farms of one farmer, nearest first when a location is known. */
async function farmsOf(farmerId: Types.ObjectId, at: At): Promise<FarmSource[]> {
  if (!at) return Farm.find({ farmer: farmerId, isActive: true }).sort({ createdAt: 1 }).lean<FarmSource[]>();
  return Farm.aggregate<FarmSource>([
    {
      $geoNear: {
        near: toPoint(at.lng, at.lat),
        key: 'location',
        distanceField: 'distance',
        spherical: true,
        query: { farmer: farmerId, isActive: true },
      },
    },
  ]);
}

const FARMER_FIELDS = 'ratingAvg ratingCount profileStatus experienceYears organicCertification.status organicCertification.issuer user';

export async function listingDetail(id: string, at: At) {
  const item = await Inventory.findOne({ _id: id, isActive: true, quantityAvailable: { $gt: 0 } })
    .populate('product', 'name localName slug image type category description shelfLifeDays')
    .lean();
  const shelfLifeDays = (item?.product as unknown as { shelfLifeDays?: number } | undefined)?.shelfLifeDays ?? 0;
  if (!item || !isSellable(item, shelfLifeDays)) throw ApiError.notFound('This product is no longer available');

  const [farmer, farms] = await Promise.all([
    Farmer.findById(item.farmer, FARMER_FIELDS).populate<{ user: { name: string; status: string } }>('user', 'name status').lean(),
    farmsOf(item.farmer as Types.ObjectId, at),
  ]);
  const farm = farms.find((f) => String(f._id) === String(item.farm));
  if (!farm || !farmer || farmer.user?.status !== 'active' || farmer.profileStatus === 'rejected') throw ApiError.notFound('This product is no longer available');

  const pf = publicFarm(farm);
  const summary = publicFarmerSummary(farmer as unknown as FarmerSource);
  const product = item.product as unknown as ListingSource['product'];
  return {
    ...publicListing(
      item as unknown as ListingSource,
      { id: pf.id, name: pf.name, village: pf.village, district: pf.district, pickupAvailable: pf.pickupAvailable },
      summary,
      pf.distanceKm,
    ),
    productDescription: product.description,
    farmDetails: pf,
    /** Whether this farm delivers to the given location. null when no location was given. */
    deliversToYou: pf.distanceKm == null ? null : pf.distanceKm <= pf.deliveryRadiusKm,
  };
}

export async function farmerProfile(farmerId: string, at: At) {
  const farmer = await Farmer.findById(farmerId)
    .populate<{ user: { name: string; status: string } }>('user', 'name status')
    .lean();
  if (!farmer || farmer.user?.status !== 'active' || farmer.profileStatus === 'rejected') throw ApiError.notFound('Farmer not found');

  const farms = (await farmsOf(farmer._id, at)).map(publicFarm);
  const farmById = new Map(farms.map((f) => [f.id, f]));
  const summary = publicFarmerSummary(farmer as unknown as FarmerSource);

  const rows = await Inventory.find({
    farmer: farmer._id,
    farm: { $in: farms.map((f) => new Types.ObjectId(f.id)) },
    ...sellableFilter(await activeCatalogue()),
  })
    .populate({ path: 'product', select: 'name localName slug image type category', match: { isActive: true } })
    .sort({ productType: -1, productName: 1 })
    .limit(200)
    .lean();

  const listings = rows
    .filter((r) => r.product)
    .map((r) => {
      const f = farmById.get(String(r.farm))!;
      return publicListing(
        r as unknown as ListingSource,
        { id: f.id, name: f.name, village: f.village, district: f.district, pickupAvailable: f.pickupAvailable },
        summary,
        f.distanceKm,
      );
    });

  return {
    farmer: {
      ...summary,
      bio: farmer.bio,
      languages: farmer.languages,
      practices: farmer.practices,
      organicIssuer: summary.organicVerified ? farmer.organicCertification?.issuer : undefined,
      memberSince: farmer.createdAt,
    },
    farms: farms.map((f) => ({
      ...f,
      deliversToYou: f.distanceKm == null ? null : f.distanceKm <= f.deliveryRadiusKm,
    })),
    listings,
  };
}
