/**
 * Delivery-partner settings. Partners are paid per job by Khet Se, independent of what the
 * customer was charged (orders above the free-delivery threshold still pay the partner).
 */
export const DELIVERY = {
  /** Payout = base + perKm × farm-to-customer distance, rounded to the rupee, at least min. */
  payout: { base: 20, perKm: 6, min: 30 },
  /** A partner sees requested jobs whose farm is within their service radius (km). */
  maxServiceRadiusKm: 30,
} as const;

export const partnerPayout = (distanceKm: number) =>
  Math.max(DELIVERY.payout.min, Math.round(DELIVERY.payout.base + DELIVERY.payout.perKm * distanceKm));
