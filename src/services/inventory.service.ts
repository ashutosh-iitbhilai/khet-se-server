import type { FilterQuery } from 'mongoose';
import { Inventory, type IInventory, type InventoryDocument } from '../models/Inventory';
import { Farm } from '../models/Farm';
import { Product, type ProductDocument } from '../models/Product';
import { ApiError } from '../utils/ApiError';
import { invalidateRecommendations } from '../config/cache';
import { escapeRegex, pageMeta, skipFor } from '../utils/pagination';
import { requireFarmer, LOW_STOCK_MULTIPLIER } from './farmer.service';
import type {
  InventoryInput,
  InventoryUpdate,
  ListMyInventoryQuery,
} from '../validators/inventory.validator';

const DAY = 24 * 60 * 60 * 1000;
const MAX_HARVEST_AGE_DAYS = 60;

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

type DateFields = Pick<IInventory, 'harvestDate' | 'processedDate' | 'expiryDate' | 'unit' | 'packSizeGrams'>;

/** Business rules that differ between fresh and dry produce. */
function assertTypeRules(type: ProductDocument['type'], v: DateFields) {
  const endOfToday = new Date(startOfToday().getTime() + DAY - 1);
  const details: { field: string; message: string }[] = [];

  if (type === 'fresh') {
    if (!v.harvestDate) details.push({ field: 'harvestDate', message: 'Harvest date is required for fresh produce' });
    else if (v.harvestDate > endOfToday) details.push({ field: 'harvestDate', message: 'Harvest date cannot be in the future' });
    else if (v.harvestDate.getTime() < startOfToday().getTime() - MAX_HARVEST_AGE_DAYS * DAY)
      details.push({ field: 'harvestDate', message: `Harvest date must be within the last ${MAX_HARVEST_AGE_DAYS} days` });
  } else {
    if (!v.processedDate) details.push({ field: 'processedDate', message: 'Processing date is required for dry products' });
    else if (v.processedDate > endOfToday) details.push({ field: 'processedDate', message: 'Processing date cannot be in the future' });
    if (!v.expiryDate) details.push({ field: 'expiryDate', message: 'Expiry date is required for dry products' });
    else if (v.expiryDate <= startOfToday()) details.push({ field: 'expiryDate', message: 'Expiry date must be in the future' });
    else if (v.processedDate && v.expiryDate <= v.processedDate)
      details.push({ field: 'expiryDate', message: 'Expiry date must be after the processing date' });
  }
  if (v.unit === 'packet' && !v.packSizeGrams) {
    details.push({ field: 'packSizeGrams', message: 'Enter the packet weight in grams' });
  }

  if (details.length) throw ApiError.badRequest('Please check the highlighted fields', details);
}

export async function listMine(userId: string, q: ListMyInventoryQuery) {
  const farmer = await requireFarmer(userId);
  const filter: FilterQuery<IInventory> = { farmer: farmer._id };

  if (q.type) filter.productType = q.type;
  if (q.q) filter.productName = new RegExp(escapeRegex(q.q), 'i');
  switch (q.status) {
    case 'active':
      Object.assign(filter, { isActive: true, quantityAvailable: { $gt: 0 } });
      break;
    case 'out':
      Object.assign(filter, { isActive: true, quantityAvailable: { $lte: 0 } });
      break;
    case 'inactive':
      filter.isActive = false;
      break;
    case 'low':
      Object.assign(filter, {
        isActive: true,
        quantityAvailable: { $gt: 0 },
        $expr: { $lte: ['$quantityAvailable', { $multiply: ['$minOrderQty', LOW_STOCK_MULTIPLIER] }] },
      });
      break;
  }

  const [items, total] = await Promise.all([
    Inventory.find(filter)
      .populate('product', 'name localName slug image type category defaultUnit')
      .populate('farm', 'name')
      .sort({ isActive: -1, updatedAt: -1 })
      .skip(skipFor(q.page, q.limit))
      .limit(q.limit),
    Inventory.countDocuments(filter),
  ]);
  return { items, meta: pageMeta(q.page, q.limit, total) };
}

export async function getMine(userId: string, id: string): Promise<InventoryDocument> {
  const farmer = await requireFarmer(userId);
  const item = await Inventory.findOne({ _id: id, farmer: farmer._id })
    .populate('product', 'name localName slug image type category defaultUnit shelfLifeDays')
    .populate('farm', 'name');
  if (!item) throw ApiError.notFound('Listing not found');
  return item;
}

export async function create(userId: string, input: InventoryInput) {
  const farmer = await requireFarmer(userId);

  // Resolve the farm: explicit id, or the farmer's only farm.
  let farm;
  if (input.farm) {
    farm = await Farm.findOne({ _id: input.farm, farmer: farmer._id });
    if (!farm) throw ApiError.notFound('Farm not found');
  } else {
    const farms = await Farm.find({ farmer: farmer._id }).limit(2);
    if (farms.length === 0) throw ApiError.badRequest('Register your farm location before adding products');
    if (farms.length > 1) throw ApiError.badRequest('Choose which farm this product comes from', [{ field: 'farm', message: 'Select a farm' }]);
    farm = farms[0];
  }

  const product = await Product.findOne({ _id: input.product, isActive: true });
  if (!product) throw ApiError.notFound('Product not found in catalogue');

  assertTypeRules(product.type, input);

  if (await Inventory.exists({ farm: farm._id, product: product._id })) {
    throw ApiError.conflict(`You already list ${product.name} from ${farm.name}. Update that listing instead.`);
  }

  const { farm: _f, product: _p, ...rest } = input;
  const doc = await Inventory.create({
    ...rest,
    // Clear fields that do not apply to this product type.
    ...(product.type === 'fresh'
      ? { processedDate: undefined, expiryDate: undefined }
      : { harvestDate: undefined }),
    farmer: farmer._id,
    farm: farm._id,
    product: product._id,
    productName: product.name,
    productType: product.type,
    category: product.category,
    city: farm.city,
    farmLocation: farm.location,
    // A listing on a paused farm starts paused.
    isActive: farm.isActive ? (input.isActive ?? true) : false,
  });
  void invalidateRecommendations();
  return getMine(userId, doc.id);
}

export async function update(userId: string, id: string, input: InventoryUpdate) {
  const item = await getMine(userId, id);
  const productType = item.productType;

  const merged: DateFields = {
    harvestDate: input.harvestDate ?? item.harvestDate,
    processedDate: input.processedDate ?? item.processedDate,
    expiryDate: input.expiryDate ?? item.expiryDate,
    unit: input.unit ?? item.unit,
    packSizeGrams: input.packSizeGrams ?? item.packSizeGrams,
  };
  // Only re-check date rules when something relevant changed (old harvest dates stay valid).
  if (input.harvestDate || input.processedDate || input.expiryDate || input.unit || input.packSizeGrams) {
    assertTypeRules(productType, merged);
  }

  if (input.isActive === true) {
    const farm = await Farm.findById(item.farm);
    if (farm && !farm.isActive) throw ApiError.conflict('This farm is paused. Re-open the farm before publishing listings.');
  }

  item.set(input);
  await item.save();
  void invalidateRecommendations();
  return getMine(userId, id);
}

/**
 * Atomic stock change. `add` may be negative (e.g. -5 after selling offline);
 * the conditional filter guarantees stock never drops below zero even under concurrency.
 */
export async function adjustStock(userId: string, id: string, mode: 'set' | 'add', quantity: number) {
  const farmer = await requireFarmer(userId);

  if (mode === 'set') {
    if (quantity < 0) throw ApiError.badRequest('Quantity cannot be negative');
    const res = await Inventory.findOneAndUpdate(
      { _id: id, farmer: farmer._id },
      { $set: { quantityAvailable: quantity } },
      { new: true },
    );
    if (!res) throw ApiError.notFound('Listing not found');
  } else {
    const res = await Inventory.findOneAndUpdate(
      { _id: id, farmer: farmer._id, ...(quantity < 0 ? { quantityAvailable: { $gte: -quantity } } : {}) },
      { $inc: { quantityAvailable: quantity } },
      { new: true },
    );
    if (!res) {
      const exists = await Inventory.exists({ _id: id, farmer: farmer._id });
      throw exists ? ApiError.conflict('Not enough stock to remove that quantity') : ApiError.notFound('Listing not found');
    }
  }
  void invalidateRecommendations();
  return getMine(userId, id);
}

export async function remove(userId: string, id: string) {
  const item = await getMine(userId, id);
  if (item.quantityReserved > 0) {
    throw ApiError.conflict('This listing has items reserved in open orders. Pause it instead of deleting.');
  }
  await item.deleteOne();
  void invalidateRecommendations();
}
