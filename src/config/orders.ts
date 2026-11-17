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
  maxLinesPerOrder: 40,
  maxSavedAddresses: 10,
  /** kg / g quantities must be multiples of this (0.25 is exact in binary floating point). */
  weightStep: 0.25,
} as const;

export function deliveryFee(subtotal: number, distanceKm: number): number {
  const d = ORDERS.delivery;
  if (subtotal >= d.freeAboveSubtotal) return 0;
  return Math.min(d.maxFee, d.baseFee + d.perKm * Math.ceil(distanceKm));
}

/** Rounds money to paise precision. */
export const money = (n: number) => Math.round(n * 100) / 100;
