import { Types, type FilterQuery } from 'mongoose';
import { Product, type IProduct } from '../models/Product';
import { Inventory } from '../models/Inventory';
import { ApiError } from '../utils/ApiError';
import { invalidateCatalogue } from './catalogue.cache';
import { escapeRegex, pageMeta, skipFor } from '../utils/pagination';
import type { ListProductsQuery, ProductInput } from '../validators/product.validator';

export async function list(query: ListProductsQuery, { includeInactive = false } = {}) {
  const filter: FilterQuery<IProduct> = {};
  if (!includeInactive) filter.isActive = true;
  if (query.type) filter.type = query.type;
  if (query.category) filter.category = query.category;
  if (query.q) {
    // Prefix match on name / local name — friendlier than $text for short queries like "tom".
    const rx = new RegExp(escapeRegex(query.q), 'i');
    filter.$or = [{ name: rx }, { localName: rx }];
  }

  const [items, total] = await Promise.all([
    // type: -1 → "fresh" before "dry"
    Product.find(filter).sort({ type: -1, name: 1 }).skip(skipFor(query.page, query.limit)).limit(query.limit),
    Product.countDocuments(filter),
  ]);
  return { items, meta: pageMeta(query.page, query.limit, total) };
}

/** Accepts either a Mongo id or a slug. */
export async function getByIdOrSlug(idOrSlug: string) {
  const product = Types.ObjectId.isValid(idOrSlug)
    ? await Product.findById(idOrSlug)
    : await Product.findOne({ slug: idOrSlug.toLowerCase() });
  if (!product) throw ApiError.notFound('Product not found');
  return product;
}

export async function create(input: ProductInput) {
  if (await Product.exists({ slug: input.slug })) throw ApiError.conflict('A product with this slug already exists');
  const product = await Product.create(input);
  invalidateCatalogue();
  return product;
}

export async function update(idOrSlug: string, input: Partial<ProductInput>) {
  const product = await getByIdOrSlug(idOrSlug);
  if (input.type && input.type !== product.type && (await Inventory.exists({ product: product._id }))) {
    throw ApiError.conflict('Cannot change the type of a product that farmers have already listed');
  }
  product.set(input);
  await product.save();
  invalidateCatalogue();

  // Keep denormalised names on listings in sync.
  if (input.name || input.category) {
    await Inventory.updateMany(
      { product: product._id },
      { $set: { productName: product.name, category: product.category } },
    );
  }
  return product;
}

/**
 * Products that are already listed are deactivated rather than deleted,
 * so existing listings and order history stay intact.
 */
export async function remove(idOrSlug: string) {
  const product = await getByIdOrSlug(idOrSlug);
  if (await Inventory.exists({ product: product._id })) {
    product.isActive = false;
    await product.save();
    invalidateCatalogue();
    return { deleted: false, deactivated: true };
  }
  await product.deleteOne();
  invalidateCatalogue();
  return { deleted: true, deactivated: false };
}
