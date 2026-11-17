/**
 * Stock movements for orders. Every movement is a single conditional update, so stock can
 * never go negative even with concurrent checkouts:
 *
 *   reserve:  available -= q, reserved += q   (only if available >= q)
 *   release:  available += q, reserved -= q   (order rejected / cancelled / payment expired)
 *   consume:  reserved -= q                   (delivered — the sale is final)
 */
import type { ClientSession, Types } from 'mongoose';
import { Inventory } from '../../models/Inventory';
import { ApiError } from '../../utils/ApiError';

export interface StockLine {
  inventory: Types.ObjectId | string;
  quantity: number;
  productName: string;
}

export async function releaseStock(lines: StockLine[], session: ClientSession | undefined) {
  for (const l of lines) {
    await Inventory.updateOne({ _id: l.inventory }, { $inc: { quantityAvailable: l.quantity, quantityReserved: -l.quantity } }, { session });
  }
}

export async function consumeStock(lines: StockLine[], session: ClientSession | undefined) {
  for (const l of lines) {
    await Inventory.updateOne({ _id: l.inventory }, { $inc: { quantityReserved: -l.quantity } }, { session });
  }
}

/**
 * Reserves every line or none. Inside a transaction a failure aborts everything; on a
 * standalone server the lines already reserved are released again before rethrowing.
 */
export async function reserveStock(lines: StockLine[], session: ClientSession | undefined) {
  const done: StockLine[] = [];
  try {
    for (const l of lines) {
      const res = await Inventory.updateOne(
        { _id: l.inventory, isActive: true, quantityAvailable: { $gte: l.quantity } },
        { $inc: { quantityAvailable: -l.quantity, quantityReserved: l.quantity } },
        { session },
      );
      if (res.modifiedCount !== 1) {
        throw new ApiError(409, 'OUT_OF_STOCK', `${l.productName} sold out while you were checking out. Please review your cart.`, [
          { field: String(l.inventory), message: 'Not enough stock' },
        ]);
      }
      done.push(l);
    }
  } catch (err) {
    if (!session) await releaseStock(done, undefined);
    throw err;
  }
}
