/**
 * One definition of "can be sold right now", shared by search, farm lists, product pages,
 * farmer profiles and checkout so they can never disagree:
 *
 *   - active and in stock for at least one minimum-size order
 *   - fresh produce: harvested no longer ago than the product's shelf life
 *   - dry produce: before its expiry date
 */
import type { Types } from 'mongoose';

const DAY_MS = 86_400_000;

type Catalogue = Map<string, { _id: Types.ObjectId | string; shelfLifeDays: number }>;

/** MongoDB filter for sellable listings (usable inside $geoNear's `query`). */
export function sellableFilter(catalogue: Catalogue, now = new Date()): Record<string, unknown> {
  const fresh = [...catalogue.values()].map((p) => ({
    productType: 'fresh',
    product: p._id,
    harvestDate: { $gte: new Date(now.getTime() - p.shelfLifeDays * DAY_MS) },
  }));
  return {
    isActive: true,
    quantityAvailable: { $gt: 0 },
    $expr: { $gte: ['$quantityAvailable', '$minOrderQty'] },
    $or: [{ productType: 'dry', expiryDate: { $gt: now } }, ...fresh],
  };
}

/** The same rule for one listing already in memory. */
export function isSellable(
  l: { isActive: boolean; quantityAvailable: number; minOrderQty: number; productType: 'fresh' | 'dry'; harvestDate?: Date | null; expiryDate?: Date | null },
  shelfLifeDays: number,
  now = new Date(),
): boolean {
  if (!l.isActive || l.quantityAvailable <= 0 || l.quantityAvailable < l.minOrderQty) return false;
  if (l.productType === 'dry') return !!l.expiryDate && new Date(l.expiryDate).getTime() > now.getTime();
  return !!l.harvestDate && now.getTime() - new Date(l.harvestDate).getTime() <= shelfLifeDays * DAY_MS;
}

/** Why a listing is not sellable, for checkout messages. */
export function notSellableReason(l: Parameters<typeof isSellable>[0], shelfLifeDays: number, now = new Date()): string | null {
  if (isSellable(l, shelfLifeDays, now)) return null;
  if (!l.isActive) return 'is no longer available';
  if (l.quantityAvailable <= 0 || l.quantityAvailable < l.minOrderQty) return 'just sold out';
  return l.productType === 'dry' ? 'is past its expiry date and no longer sold' : 'is past its shelf life and no longer sold';
}
