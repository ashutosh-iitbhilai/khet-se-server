import { Farm, type FarmDocument } from '../models/Farm';
import { Inventory } from '../models/Inventory';
import { toPoint } from '../models/common';
import { ApiError } from '../utils/ApiError';
import { invalidateRecommendations } from '../config/cache';
import { requireFarmer } from './farmer.service';
import type { FarmInput } from '../validators/farm.validator';

/** A farmer may run several farms; keep it bounded. */
const MAX_FARMS_PER_FARMER = 5;

export async function listMine(userId: string) {
  const farmer = await requireFarmer(userId);
  return Farm.find({ farmer: farmer._id }).sort({ createdAt: 1 });
}

export async function getOwned(userId: string, farmId: string): Promise<FarmDocument> {
  const farmer = await requireFarmer(userId);
  const farm = await Farm.findOne({ _id: farmId, farmer: farmer._id });
  if (!farm) throw ApiError.notFound('Farm not found');
  return farm;
}

export async function create(userId: string, input: FarmInput) {
  const farmer = await requireFarmer(userId);
  const count = await Farm.countDocuments({ farmer: farmer._id });
  if (count >= MAX_FARMS_PER_FARMER) {
    throw ApiError.conflict(`You can register up to ${MAX_FARMS_PER_FARMER} farms`);
  }

  const { location, ...rest } = input;
  const farm = await Farm.create({ ...rest, farmer: farmer._id, location: toPoint(location.lng, location.lat) });
  void invalidateRecommendations();
  return farm;
}

export async function update(userId: string, farmId: string, input: Partial<FarmInput>) {
  const farm = await getOwned(userId, farmId);
  const { location, address, ...rest } = input;

  farm.set(rest);
  if (address) farm.set('address', { ...farm.toObject().address, ...address });
  if (location) farm.location = toPoint(location.lng, location.lat);
  await farm.save();

  // Keep denormalised listing fields in sync so geo queries stay correct.
  if (location || input.city) {
    await Inventory.updateMany({ farm: farm._id }, { $set: { farmLocation: farm.location, city: farm.city } });
  }
  // Pausing a farm hides its listings; re-activating does not auto-publish them.
  if (input.isActive === false) {
    await Inventory.updateMany({ farm: farm._id }, { $set: { isActive: false } });
  }
  void invalidateRecommendations();
  return farm;
}
