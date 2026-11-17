/**
 * Seeds the shared product catalogue. Safe to re-run: upserts by slug and
 * never touches farmer inventory.
 *
 *   npm run seed:catalogue
 */
import { connectDatabase, disconnectDatabase } from '../config/db';
import { Product } from '../models/Product';
import { Farm } from '../models/Farm';
import { Inventory } from '../models/Inventory';
import { CATALOGUE } from './catalogue.data';
import { logger } from '../utils/logger';

async function main() {
  await connectDatabase();
  // Make sure geo + unique indexes exist before the app relies on them.
  await Promise.all([Product.syncIndexes(), Farm.syncIndexes(), Inventory.syncIndexes()]);

  const ops = CATALOGUE.map((p) => ({
    updateOne: { filter: { slug: p.slug }, update: { $set: { ...p, isActive: true } }, upsert: true },
  }));
  const res = await Product.bulkWrite(ops);
  logger.info(`Catalogue: ${res.upsertedCount} added, ${res.modifiedCount} updated, ${CATALOGUE.length} total`);
}

main()
  .catch((err) => {
    logger.error('Seed failed', err);
    process.exitCode = 1;
  })
  .finally(disconnectDatabase);
