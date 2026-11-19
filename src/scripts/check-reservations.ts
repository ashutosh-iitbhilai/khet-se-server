/**
 * Checks that every listing's reserved stock matches its open orders.
 *
 *   npm run reservations:check            # report only
 *   npm run reservations:check -- --fix   # also correct drift (safe while the app is running)
 */
import { connectDatabase, disconnectDatabase } from '../config/db';
import { findReservationDrift, fixReservationDrift } from '../services/order/reservation-audit.service';

async function main() {
  await connectDatabase();
  try {
    const drift = await findReservationDrift();
    if (!drift.length) {
      console.log('✓ Reserved stock matches open orders for every listing.');
      return;
    }
    console.log(`Found ${drift.length} listing(s) whose reserved stock doesn't match open orders:`);
    for (const d of drift) console.log(`  ${d.productName.padEnd(28)} ${d.inventory}  recorded ${d.recorded}  expected ${d.expected}`);
    if (process.argv.includes('--fix')) {
      const r = await fixReservationDrift();
      console.log(`Fixed ${r.fixed}, skipped ${r.skipped} (changed during the check — run again).`);
    } else {
      console.log('Run again with --fix to correct them.');
      process.exitCode = 1;
    }
  } finally {
    await disconnectDatabase();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
