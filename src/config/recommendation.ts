import { env } from './env';

/**
 * Tunable knobs for the recommendation engine.
 * Weights are relative — they are normalised by their sum, so they need not add up to 1.
 */
export const RECOMMENDATION = {
  weights: {
    proximity: 0.3,
    freshness: 0.2,
    stock: 0.1,
    rating: 0.15,
    price: 0.15,
    organic: 0.1,
  },

  /** Search starts here and widens through these radii until enough results are found. */
  defaultRadiusKm: env.REC_DEFAULT_RADIUS_KM,
  maxRadiusKm: env.REC_MAX_RADIUS_KM,
  expansionStepsKm: [15, 25, 40, 60, 100],
  minFarmResults: 4,
  minProductResults: 8,

  /** Upper bound on listings pulled from $geoNear before scoring (one city ≈ a few hundred). */
  candidateLimit: 1000,

  /** Bayesian rating prior: an unrated farmer is treated as `prior` stars backed by `priorWeight` reviews. */
  ratingPrior: 3.5,
  ratingPriorWeight: 5,

  /** Stock is "fully available" when it covers this many minimum-size orders. */
  stockTargetOrders: 10,

  /** How many top farms get OSRM road distances (when enabled). */
  roadDistanceTopK: 10,

  /**
   * Diversity for "recommended" product lists: each further item from the same farm has its
   * score multiplied by this factor, so one large farm cannot fill the whole first page.
   */
  sameFarmDecay: 0.85,

  cacheTtlSeconds: 60,
} as const;

export type Weights = Record<keyof typeof RECOMMENDATION.weights, number>;

/** Radii to try, in order, never beyond the configured maximum. */
export function radiusSteps(requestedKm?: number): number[] {
  const start = Math.min(requestedKm ?? RECOMMENDATION.defaultRadiusKm, RECOMMENDATION.maxRadiusKm);
  // An explicit radius from the user is respected exactly — no auto-expansion.
  if (requestedKm) return [start];
  return [start, ...RECOMMENDATION.expansionStepsKm.filter((r) => r > start && r <= RECOMMENDATION.maxRadiusKm)];
}
