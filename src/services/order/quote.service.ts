/**
 * Builds a priced, validated quote for a cart: current prices, stock, minimum order sizes,
 * and whether each farm delivers to the address. Used both to show the checkout summary
 * and (strictly) when placing the order — the client's prices are never trusted.
 */
import { Types } from 'mongoose';
import { notSellableReason } from '../recommendation/sellable';
import { Inventory } from '../../models/Inventory';
import { Farm } from '../../models/Farm';
import { Farmer } from '../../models/Farmer';
import { toPoint } from '../../models/common';
import { ORDERS, deliveryFee, money } from '../../config/orders';
import type { QuoteLine } from '../../validators/order.validator';

export type IssueCode = 'UNAVAILABLE' | 'OUT_OF_STOCK' | 'INSUFFICIENT_STOCK' | 'BELOW_MINIMUM' | 'INVALID_QUANTITY' | 'NOT_DELIVERABLE';

export interface QuoteIssue {
  listing: string;
  code: IssueCode;
  message: string;
  /** Largest quantity that can be ordered right now, when relevant. */
  maxQuantity?: number;
}

export interface QuoteItem {
  listing: string;
  inventory: Types.ObjectId;
  product: Types.ObjectId;
  productName: string;
  image: string;
  unit: string;
  packSizeGrams?: number;
  price: number;
  quantity: number;
  lineTotal: number;
  minOrderQty: number;
  available: number;
}

export interface QuoteGroup {
  farmer: Types.ObjectId;
  farm: Types.ObjectId;
  farmName: string;
  farmerName: string;
  farmerPhone?: string;
  distanceKm: number;
  items: QuoteItem[];
  subtotal: number;
  deliveryFee: number;
  total: number;
}

export interface Quote {
  groups: QuoteGroup[];
  issues: QuoteIssue[];
  itemsTotal: number;
  deliveryTotal: number;
  grandTotal: number;
}

const WEIGHT_UNITS = new Set(['kg', 'g']);

/** kg/g in steps of ORDERS.weightStep; countable units in whole numbers. */
function validStep(unit: string, qty: number) {
  if (WEIGHT_UNITS.has(unit)) return Math.abs(qty / ORDERS.weightStep - Math.round(qty / ORDERS.weightStep)) < 1e-9;
  return Number.isInteger(qty);
}

export async function buildQuote(lines: QuoteLine[], at: { lng: number; lat: number }): Promise<Quote> {
  const issues: QuoteIssue[] = [];
  const ids = lines.map((l) => new Types.ObjectId(l.listing));

  const listings = await Inventory.find({ _id: { $in: ids } })
    .populate<{ product: { _id: Types.ObjectId; name: string; image: string; isActive: boolean; shelfLifeDays: number } }>('product', 'name image isActive shelfLifeDays')
    .lean();
  const byId = new Map(listings.map((l) => [String(l._id), l]));

  // Distances from the address to every farm involved, computed by MongoDB.
  const farmIds = [...new Set(listings.map((l) => String(l.farm)))].map((id) => new Types.ObjectId(id));
  const farms = farmIds.length
    ? await Farm.aggregate<{ _id: Types.ObjectId; name: string; farmer: Types.ObjectId; isActive: boolean; deliveryAvailable: boolean; deliveryRadiusKm: number; distance: number }>([
        { $geoNear: { near: toPoint(at.lng, at.lat), key: 'location', distanceField: 'distance', spherical: true, query: { _id: { $in: farmIds } } } },
        { $project: { name: 1, farmer: 1, isActive: 1, deliveryAvailable: 1, deliveryRadiusKm: 1, distance: 1 } },
      ])
    : [];
  const farmById = new Map(farms.map((f) => [String(f._id), f]));

  const farmers = await Farmer.find({ _id: { $in: [...new Set(farms.map((f) => String(f.farmer)))] } })
    .populate<{ user: { name: string; phone?: string; status: string } }>('user', 'name phone status')
    .lean();
  const farmerById = new Map(farmers.map((f) => [String(f._id), f]));

  const groups = new Map<string, QuoteGroup>();

  for (const line of lines) {
    const l = byId.get(line.listing);
    const farm = l ? farmById.get(String(l.farm)) : undefined;
    const farmer = l ? farmerById.get(String(l.farmer)) : undefined;
    const name = l?.productName ?? 'This product';

    if (!l || !l.isActive || !l.product?.isActive || !farm?.isActive || farmer?.user?.status !== 'active' || farmer.profileStatus === 'rejected') {
      issues.push({ listing: line.listing, code: 'UNAVAILABLE', message: `${name} is no longer available` });
      continue;
    }
    const stale = notSellableReason({ ...l, quantityAvailable: Math.max(l.quantityAvailable, l.minOrderQty) }, l.product.shelfLifeDays);
    if (stale) {
      // Expired / past shelf life (stock problems are reported below with the quantity left).
      issues.push({ listing: line.listing, code: 'UNAVAILABLE', message: `${name} ${stale}` });
      continue;
    }
    const distanceKm = Math.round(farm.distance / 100) / 10;
    // Compare the exact distance, like search does; the rounded figure is only for display and fees.
    if (!farm.deliveryAvailable || farm.distance > farm.deliveryRadiusKm * 1000) {
      issues.push({
        listing: line.listing,
        code: 'NOT_DELIVERABLE',
        message: `${farm.name} delivers within ${farm.deliveryRadiusKm} km; this address is ${distanceKm} km away`,
      });
      continue;
    }
    if (l.quantityAvailable <= 0) {
      issues.push({ listing: line.listing, code: 'OUT_OF_STOCK', message: `${name} just sold out`, maxQuantity: 0 });
      continue;
    }
    if (!validStep(l.unit, line.quantity)) {
      issues.push({
        listing: line.listing,
        code: 'INVALID_QUANTITY',
        message: WEIGHT_UNITS.has(l.unit) ? `${name} is sold in steps of ${ORDERS.weightStep} ${l.unit}` : `${name} is sold in whole ${l.unit}s`,
      });
      continue;
    }
    if (line.quantity < l.minOrderQty) {
      issues.push({ listing: line.listing, code: 'BELOW_MINIMUM', message: `Minimum order for ${name} is ${l.minOrderQty} ${l.unit}` });
      continue;
    }
    if (line.quantity > l.quantityAvailable) {
      issues.push({
        listing: line.listing,
        code: 'INSUFFICIENT_STOCK',
        message: `Only ${l.quantityAvailable} ${l.unit} of ${name} left`,
        maxQuantity: l.quantityAvailable,
      });
      continue;
    }

    const key = String(farm._id);
    let g = groups.get(key);
    if (!g) {
      g = {
        farmer: l.farmer as Types.ObjectId,
        farm: farm._id,
        farmName: farm.name,
        farmerName: farmer.user.name,
        farmerPhone: farmer.user.phone,
        distanceKm,
        items: [],
        subtotal: 0,
        deliveryFee: 0,
        total: 0,
      };
      groups.set(key, g);
    }
    const lineTotal = money(l.price * line.quantity);
    g.items.push({
      listing: line.listing,
      inventory: l._id as Types.ObjectId,
      product: l.product._id,
      productName: l.productName,
      image: l.images?.[0] ?? l.product.image,
      unit: l.unit,
      packSizeGrams: l.packSizeGrams,
      price: l.price,
      quantity: line.quantity,
      lineTotal,
      minOrderQty: l.minOrderQty,
      available: l.quantityAvailable,
    });
    g.subtotal = money(g.subtotal + lineTotal);
  }

  const out = [...groups.values()];
  for (const g of out) {
    g.deliveryFee = deliveryFee(g.subtotal, g.distanceKm);
    g.total = money(g.subtotal + g.deliveryFee);
  }
  const itemsTotal = money(out.reduce((s, g) => s + g.subtotal, 0));
  const deliveryTotal = money(out.reduce((s, g) => s + g.deliveryFee, 0));
  return { groups: out, issues, itemsTotal, deliveryTotal, grandTotal: money(itemsTotal + deliveryTotal) };
}

/** Public shape of a quote — internal ObjectIds as strings, no stock numbers beyond what's needed. */
export function publicQuote(q: Quote) {
  return {
    groups: q.groups.map((g) => ({
      farm: String(g.farm),
      farmer: String(g.farmer),
      farmName: g.farmName,
      farmerName: g.farmerName,
      distanceKm: g.distanceKm,
      subtotal: g.subtotal,
      deliveryFee: g.deliveryFee,
      total: g.total,
      items: g.items.map((i) => ({
        listing: i.listing,
        productName: i.productName,
        image: i.image,
        unit: i.unit,
        packSizeGrams: i.packSizeGrams,
        price: i.price,
        quantity: i.quantity,
        lineTotal: i.lineTotal,
      })),
    })),
    issues: q.issues,
    itemsTotal: q.itemsTotal,
    deliveryTotal: q.deliveryTotal,
    grandTotal: q.grandTotal,
    freeDeliveryAbove: ORDERS.delivery.freeAboveSubtotal,
  };
}
