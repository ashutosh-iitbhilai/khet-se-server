/**
 * Creates / updates MongoDB indexes to match the schemas (and drops indexes no schema
 * declares any more). Run once per deploy, before starting the new API version:
 *
 *   npm run db:indexes            # dev (tsx)
 *   npm run db:indexes:prod       # compiled (node dist/…)
 *
 * Models are synced one at a time so a collection never has two index operations at once.
 */
process.env.MONGO_AUTO_INDEX = 'false';

async function main() {
  const { connectDatabase, disconnectDatabase } = await import('../config/db');
  const { logger } = await import('../utils/logger');
  const mongoose = (await import('mongoose')).default;
  // Register every model.
  await Promise.all(
    ['User', 'Farmer', 'Farm', 'Product', 'Inventory', 'Address', 'Order', 'Payment', 'Delivery', 'Session', 'PasswordReset', 'DeliveryPartner', 'AdminAction'].map((m) => import(`../models/${m}`)),
  );
  await connectDatabase();
  try {
    for (const model of Object.values(mongoose.models)) {
      await model.createCollection().catch(() => undefined); // exists already
      const dropped = await model.syncIndexes();
      const indexes = await model.listIndexes();
      logger.info(`${model.modelName.padEnd(10)} ${indexes.length} indexes${dropped.length ? ` (dropped: ${dropped.join(', ')})` : ''}`);
    }
  } finally {
    await disconnectDatabase();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

export {}; // module scope (no top-level imports)
