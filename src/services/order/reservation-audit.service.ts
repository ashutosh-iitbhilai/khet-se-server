/**
 * Reserved-stock audit. `inventory.quantityReserved` must always equal the quantities held
 * by open order groups. On a replica set every change happens inside a transaction, so the
 * two can't diverge; on a standalone server a crash between an order's status change and
 * its stock update could leave them out of step. This finds (and optionally repairs) that.
 */
import { Types } from 'mongoose';
import { Order } from '../../models/Order';
import { Inventory } from '../../models/Inventory';
import { logger } from '../../utils/logger';

const OPEN = ['pending', 'accepted', 'packed', 'out_for_delivery'];
const EPS = 1e-9;

export interface ReservationDrift {
  inventory: string;
  productName: string;
  recorded: number; // quantityReserved on the listing
  expected: number; // sum held by open orders
}

/** Quantity each listing should have reserved, according to open orders. */
async function expectedReservations(): Promise<Map<string, number>> {
  const rows = await Order.aggregate<{ _id: Types.ObjectId; reserved: number }>([
    { $match: { 'groups.status': { $in: OPEN } } },
    { $unwind: '$groups' },
    { $match: { 'groups.status': { $in: OPEN } } },
    { $unwind: '$groups.items' },
    { $group: { _id: '$groups.items.inventory', reserved: { $sum: '$groups.items.quantity' } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.reserved]));
}

export async function findReservationDrift(): Promise<ReservationDrift[]> {
  const expected = await expectedReservations();
  const listings = await Inventory.find(
    { $or: [{ quantityReserved: { $gt: EPS } }, { quantityReserved: { $lt: -EPS } }, { _id: { $in: [...expected.keys()].map((id) => new Types.ObjectId(id)) } }] },
    { productName: 1, quantityReserved: 1 },
  ).lean();
  return listings
    .map((l) => ({ inventory: String(l._id), productName: l.productName, recorded: l.quantityReserved, expected: expected.get(String(l._id)) ?? 0 }))
    .filter((d) => Math.abs(d.recorded - d.expected) > EPS);
}

/**
 * Repairs drift without pausing checkout. A listing is only corrected when two order counts
 * taken around the listing read agree, and the listing still holds the value that was read
 * (conditional update) — so an order placed or released mid-audit makes us skip it, not
 * "correct" it wrongly. Over-reserved units go back to `quantityAvailable`.
 */
export async function fixReservationDrift() {
  const first = await findReservationDrift();
  if (!first.length) return { found: 0, fixed: 0, skipped: 0 };
  const recheck = await expectedReservations();

  let fixed = 0;
  let skipped = 0;
  for (const d of first) {
    const again = recheck.get(d.inventory) ?? 0;
    if (Math.abs(again - d.expected) > EPS) {
      skipped++; // orders changed while we were counting; next run will look again
      continue;
    }
    const delta = d.recorded - d.expected; // > 0: units stuck as reserved
    const res = await Inventory.updateOne(
      { _id: d.inventory, quantityReserved: d.recorded },
      { $set: { quantityReserved: d.expected }, $inc: { quantityAvailable: delta } },
    );
    if (res.modifiedCount === 1) {
      fixed++;
      logger.warn(`Reserved stock corrected for ${d.productName} (${d.inventory}): ${d.recorded} → ${d.expected}`);
    } else skipped++;
  }
  return { found: first.length, fixed, skipped };
}
