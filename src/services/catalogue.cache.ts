import type { Types } from 'mongoose';
import { Product } from '../models/Product';

/**
 * The product catalogue is small (tens to a few hundred items) and read on every
 * recommendation request, so each API instance keeps it in memory for a minute instead of
 * joining it per listing. Admin edits call `invalidateCatalogue()`.
 */
export interface CatalogueEntry {
  _id: Types.ObjectId;
  name: string;
  localName?: string;
  slug: string;
  image: string;
  shelfLifeDays: number;
}

const TTL_MS = 60_000;
let cached: { at: number; map: Map<string, CatalogueEntry> } | null = null;
let inflight: Promise<Map<string, CatalogueEntry>> | null = null;

/** Active catalogue products by id. */
export async function activeCatalogue(): Promise<Map<string, CatalogueEntry>> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.map;
  inflight ??= Product.find({ isActive: true }, 'name localName slug image shelfLifeDays')
    .lean<CatalogueEntry[]>()
    .then((rows) => {
      const map = new Map(rows.map((p) => [String(p._id), p]));
      cached = { at: Date.now(), map };
      return map;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function invalidateCatalogue() {
  cached = null;
}
