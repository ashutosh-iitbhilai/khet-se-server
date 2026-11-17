import { Address } from '../models/Address';
import { toPoint } from '../models/common';
import { ORDERS } from '../config/orders';
import { ApiError } from '../utils/ApiError';
import type { AddressInput } from '../validators/address.validator';

export function listMine(userId: string) {
  return Address.find({ user: userId }).sort({ isDefault: -1, updatedAt: -1 });
}

export async function getMine(userId: string, id: string) {
  const a = await Address.findOne({ _id: id, user: userId });
  if (!a) throw ApiError.notFound('Address not found');
  return a;
}

/** Only one default per user. */
async function clearDefault(userId: string, exceptId?: string) {
  await Address.updateMany({ user: userId, isDefault: true, ...(exceptId ? { _id: { $ne: exceptId } } : {}) }, { $set: { isDefault: false } });
}

export async function create(userId: string, input: AddressInput) {
  const count = await Address.countDocuments({ user: userId });
  if (count >= ORDERS.maxSavedAddresses) throw ApiError.conflict(`You can save up to ${ORDERS.maxSavedAddresses} addresses`);

  const isDefault = input.isDefault ?? count === 0;
  if (isDefault) await clearDefault(userId);
  const { location, ...rest } = input;
  return Address.create({ ...rest, user: userId, location: toPoint(location.lng, location.lat), isDefault });
}

export async function update(userId: string, id: string, input: Partial<AddressInput>) {
  const a = await getMine(userId, id);
  const { location, ...rest } = input;
  a.set(rest);
  if (location) a.location = toPoint(location.lng, location.lat);
  if (input.isDefault) await clearDefault(userId, id);
  await a.save();
  return a;
}

export async function remove(userId: string, id: string) {
  const a = await getMine(userId, id);
  await a.deleteOne();
  // Keep a default if any address is left.
  if (a.isDefault) {
    const next = await Address.findOne({ user: userId }).sort({ updatedAt: -1 });
    if (next) await Address.updateOne({ _id: next._id }, { $set: { isDefault: true } });
  }
}
