import { env } from './env';

/** Checkout and fulfilment rules. Amounts in INR. */
export const ORDERS = {
  /** Per-farm delivery fee: base + per km, capped; free above a farm subtotal. */
  delivery: {
    baseFee: 20,
    perKm: 3,
    maxFee: 60,
    freeAboveSubtotal: 300,
  },
  /** How long stock stays reserved for an unpaid online order. */
  onlinePaymentWindowMinutes: 15,
  /**
   * If Razorpay can't be reached when an unpaid order expires, keep waiting this long before
   * cancelling anyway (the reconciliation sweep still catches a late payment as a refund due).
   */
  expiryGraceMinutes: 30,
  /** A farmer must accept (or decline) a new order within this many hours, or it is cancelled. */
  farmerAcceptHours: env.FARMER_ACCEPT_HOURS,
  /** Wrong delivery codes allowed before the code locks and the customer must issue a new one. */
  maxCodeAttempts: 5,
  maxLinesPerOrder: 40,
  maxSavedAddresses: 10,
  /** kg / g quantities must be multiples of this (0.25 is exact in binary floating point). */
  weightStep: 0.25,
} as const;

/** Deadline for a farmer to accept a group that becomes visible to them now. */
export const acceptDeadline = (from = new Date()) => new Date(from.getTime() + ORDERS.farmerAcceptHours * 3600_000);

export function deliveryFee(subtotal: number, distanceKm: number): number {
  const d = ORDERS.delivery;
  if (subtotal >= d.freeAboveSubtotal) return 0;
  return Math.min(d.maxFee, d.baseFee + d.perKm * Math.ceil(distanceKm));
}

/** Rounds money to paise precision. */
export const money = (n: number) => Math.round(n * 100) / 100;
