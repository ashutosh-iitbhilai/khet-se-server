import type { Types } from 'mongoose';
import { Farmer, type FarmerDocument } from '../models/Farmer';
import { Farm } from '../models/Farm';
import { Inventory } from '../models/Inventory';
import { ApiError } from '../utils/ApiError';
import { invalidateRecommendations } from '../config/cache';
import { Order } from '../models/Order';
import type { ProfileInput } from '../validators/farmer.validator';

/** Creates the farmer profile shell when a farmer account registers. Idempotent. */
export async function ensureFarmerForUser(userId: string | Types.ObjectId): Promise<FarmerDocument> {
  return Farmer.findOneAndUpdate(
    { user: userId },
    { $setOnInsert: { user: userId } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ) as Promise<FarmerDocument>;
}

/** Resolves the Farmer document for an authenticated farmer user. */
export async function requireFarmer(userId: string): Promise<FarmerDocument> {
  const farmer = await Farmer.findOne({ user: userId });
  if (!farmer) throw ApiError.notFound('Farmer profile not found. Please complete your profile.');
  return farmer;
}

export async function getMyProfile(userId: string) {
  const farmer = await ensureFarmerForUser(userId);
  const farms = await Farm.find({ farmer: farmer._id }).sort({ createdAt: 1 });
  return { farmer, farms };
}

export async function upsertProfile(userId: string, input: ProfileInput) {
  const farmer = await ensureFarmerForUser(userId);

  if (input.bio !== undefined) farmer.bio = input.bio;
  if (input.experienceYears !== undefined) farmer.experienceYears = input.experienceYears;
  if (input.languages) farmer.languages = input.languages;
  if (input.practices) farmer.practices = input.practices;

  if (input.organicCertification) {
    const current = farmer.organicCertification;
    const changed =
      current.certificateNumber !== input.organicCertification.certificateNumber ||
      current.issuer !== input.organicCertification.issuer ||
      current.documentUrl !== input.organicCertification.documentUrl;

    farmer.organicCertification = {
      ...input.organicCertification,
      // Any change to certificate details sends it back for admin review.
      status: changed || current.status === 'unsubmitted' ? 'pending' : current.status,
      reviewNote: changed ? undefined : current.reviewNote,
    };
  }

  await farmer.save();
  void invalidateRecommendations();
  return farmer;
}

/** Numbers for the farmer dashboard overview. */
export async function getOverview(userId: string) {
  const farmer = await ensureFarmerForUser(userId);
  const [farmCount, pendingOrders, activeOrders, stats] = await Promise.all([
    Farm.countDocuments({ farmer: farmer._id }),
    Order.countDocuments({
      groups: { $elemMatch: { farmer: farmer._id, status: 'pending' } },
      $or: [{ paymentMethod: 'cod' }, { paymentStatus: { $in: ['paid', 'refund_pending'] } }],
    }),
    Order.countDocuments({ groups: { $elemMatch: { farmer: farmer._id, status: { $in: ['accepted', 'packed', 'out_for_delivery'] } } } }),
    Inventory.aggregate<{ active: number; outOfStock: number; lowStock: number; inactive: number; total: number }>([
      { $match: { farmer: farmer._id } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          active: { $sum: { $cond: [{ $and: ['$isActive', { $gt: ['$quantityAvailable', 0] }] }, 1, 0] } },
          outOfStock: { $sum: { $cond: [{ $and: ['$isActive', { $lte: ['$quantityAvailable', 0] }] }, 1, 0] } },
          lowStock: {
            $sum: {
              $cond: [
                {
                  $and: [
                    '$isActive',
                    { $gt: ['$quantityAvailable', 0] },
                    { $lte: ['$quantityAvailable', { $multiply: ['$minOrderQty', LOW_STOCK_MULTIPLIER] }] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          inactive: { $sum: { $cond: ['$isActive', 0, 1] } },
        },
      },
    ]),
  ]);

  const s = stats[0] ?? { total: 0, active: 0, outOfStock: 0, lowStock: 0, inactive: 0 };
  return {
    profileComplete: Boolean(farmer.bio && farmer.bio.length >= 20),
    organicStatus: farmer.organicCertification.status,
    profileStatus: farmer.profileStatus,
    farmCount,
    orders: { pending: pendingOrders, active: activeOrders },
    listings: { total: s.total, active: s.active, outOfStock: s.outOfStock, lowStock: s.lowStock, inactive: s.inactive },
  };
}

/** A listing is "low" when it can serve this many minimum orders or fewer. */
export const LOW_STOCK_MULTIPLIER = 5;
