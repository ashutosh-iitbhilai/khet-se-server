/**
 * Geo-spatial recommendation engine.
 *
 *  1. $geoNear (2dsphere) finds candidates within the radius — distances come from MongoDB,
 *     never from manual lat/lng arithmetic (see candidates.ts for the batched joins).
 *  2. Candidates are filtered to farms that are open, deliver, and whose own delivery radius
 *     reaches the customer.
 *  3. Each candidate gets normalised component scores (see scoring.ts) and a weighted total.
 *  4. If too few results, the radius widens step by step up to the configured maximum.
 *
 * Kept independent of HTTP so it can be tuned or replaced (e.g. learning-to-rank) later.
 */
import { RECOMMENDATION, radiusSteps, type Weights } from '../../config/recommendation';
import { cache } from '../../config/cache';
import { pageMeta } from '../../utils/pagination';
import { fetchFarmCandidates, fetchListingCandidates, type FarmerDoc, type RawFarm, type RawListing } from './candidates';
import { roadDistancesKm } from '../routing.service';
import {
  diversify,
  freshnessScore,
  priceGroupKey,
  priceRanges,
  priceScore,
  proximityScore,
  ratingScore,
  round,
  stockScore,
  weightedScore,
  type ScoreParts,
} from './scoring';
import type { NearbyFarmersQuery, NearbyListingsQuery } from '../../validators/recommendation.validator';

const W: Weights = RECOMMENDATION.weights;

interface FarmerInfo {
  id: string;
  name: string;
  ratingAvg: number;
  ratingCount: number;
  organicVerified: boolean;
  profileVerified: boolean;
  experienceYears?: number;
}

function toFarmerInfo(doc: FarmerDoc): FarmerInfo {
  return {
    id: String(doc._id),
    name: doc.userDoc.name,
    ratingAvg: doc.ratingAvg,
    ratingCount: doc.ratingCount,
    organicVerified: doc.organicCertification?.status === 'verified',
    profileVerified: doc.profileStatus === 'verified',
    experienceYears: doc.experienceYears,
  };
}

const ratingPart = (f: FarmerInfo) =>
  ratingScore(f.ratingAvg, f.ratingCount, RECOMMENDATION.ratingPrior, RECOMMENDATION.ratingPriorWeight);

const roundParts = (p: ScoreParts): ScoreParts =>
  Object.fromEntries(Object.entries(p).map(([k, v]) => [k, round(v)])) as ScoreParts;

/** Cache key with coordinates rounded to ~110 m so nearby customers share entries. */
const cacheKey = (kind: string, q: Record<string, unknown>) =>
  `rec:${kind}:` +
  Object.entries(q)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${k === 'lng' || k === 'lat' ? Number(v).toFixed(3) : v}`)
    .sort()
    .join('&');

// ─── Listings (products near me) ─────────────────────────────────────────────

function scoreListings(rows: RawListing[], radiusKm: number, now = new Date()) {
  const ranges = priceRanges(rows);
  return rows.map((l) => {
    const farmer = toFarmerInfo(l.farmerDoc);
    const range = ranges.get(priceGroupKey(l))!;
    const parts: ScoreParts = {
      proximity: proximityScore(l.distance / 1000, radiusKm),
      freshness: freshnessScore(l, l.productDoc.shelfLifeDays, now),
      stock: stockScore(l.quantityAvailable, l.minOrderQty, RECOMMENDATION.stockTargetOrders),
      rating: ratingPart(farmer),
      price: priceScore(l.price, range.min, range.max),
      organic: farmer.organicVerified ? 1 : 0,
    };
    return {
      id: String(l._id),
      product: {
        id: String(l.productDoc._id),
        name: l.productDoc.name,
        localName: l.productDoc.localName,
        slug: l.productDoc.slug,
        image: l.productDoc.image,
        type: l.productType,
        category: l.category,
      },
      price: l.price,
      unit: l.unit,
      packSizeGrams: l.packSizeGrams,
      quantityAvailable: l.quantityAvailable,
      minOrderQty: l.minOrderQty,
      harvestDate: l.harvestDate,
      processedDate: l.processedDate,
      expiryDate: l.expiryDate,
      packaging: l.packaging,
      images: l.images ?? [],
      organicClaim: l.organicClaim,
      farm: {
        id: String(l.farmDoc._id),
        name: l.farmDoc.name,
        village: l.farmDoc.address?.village,
        district: l.farmDoc.address?.district,
        pickupAvailable: l.farmDoc.pickupAvailable,
      },
      farmer,
      distanceKm: round(l.distance / 1000, 1),
      score: round(weightedScore(parts, W)),
      scoreBreakdown: roundParts(parts),
      freshness: round(parts.freshness, 2),
    };
  });
}

export type ScoredListing = ReturnType<typeof scoreListings>[number];

const listingSorters: Record<NearbyListingsQuery['sort'], (a: ScoredListing, b: ScoredListing) => number> = {
  recommended: (a, b) => b.score - a.score || a.distanceKm - b.distanceKm,
  distance: (a, b) => a.distanceKm - b.distanceKm || b.score - a.score,
  price_asc: (a, b) => a.price - b.price || b.score - a.score,
  price_desc: (a, b) => b.price - a.price || b.score - a.score,
  freshness: (a, b) => b.freshness - a.freshness || b.score - a.score,
};

export async function nearbyListings(q: NearbyListingsQuery) {
  const key = cacheKey('listings', q);
  const cached = await cache.get<ReturnType<typeof buildListingResult>>(key);
  if (cached) return cached;

  const steps = radiusSteps(q.radiusKm);
  let radiusKm = steps[0];
  let rows: RawListing[] = [];
  for (const r of steps) {
    radiusKm = r;
    rows = await fetchListingCandidates(q.lng, q.lat, r, q);
    if (rows.length >= RECOMMENDATION.minProductResults) break;
  }

  const result = buildListingResult(scoreListings(rows, radiusKm), q, radiusKm, steps[0]);
  await cache.set(key, result, RECOMMENDATION.cacheTtlSeconds);
  return result;
}

function buildListingResult(sc: ScoredListing[], q: NearbyListingsQuery, radiusKm: number, initialRadiusKm: number) {
  sc.sort(listingSorters[q.sort]);
  // "Recommended" also spreads results across farms; explicit sorts keep their exact order.
  const scored =
    q.sort === 'recommended' && !q.farm
      ? diversify(sc, (l) => l.score, (l) => l.farm.id, RECOMMENDATION.sameFarmDecay, q.page * q.limit)
      : sc;
  const start = (q.page - 1) * q.limit;
  return {
    items: scored.slice(start, start + q.limit),
    meta: {
      ...pageMeta(q.page, q.limit, scored.length),
      radiusKm,
      expanded: radiusKm > initialRadiusKm,
      sort: q.sort,
    },
  };
}

// ─── Farms (farmers near me) ─────────────────────────────────────────────────

function scoreFarms(rows: RawFarm[], radiusKm: number, now = new Date()) {
  // Price competitiveness compares each farm's offers with every other nearby offer of the same item.
  const ranges = priceRanges(rows.flatMap((f) => f.listings));
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  return rows.map((f) => {
    const farmer = toFarmerInfo(f.farmerDoc);
    const listingParts = f.listings.map((l) => {
      const shelf = l.productDoc[0]?.shelfLifeDays ?? 7;
      const r = ranges.get(priceGroupKey(l))!;
      return {
        l,
        freshness: freshnessScore(l, shelf, now),
        stock: stockScore(l.quantityAvailable, l.minOrderQty, RECOMMENDATION.stockTargetOrders),
        price: priceScore(l.price, r.min, r.max),
      };
    });

    // Variety matters for "inventory availability": a farm with 1 item is less useful than one with 6.
    const variety = Math.min(1, f.listings.length / 6);
    const parts: ScoreParts = {
      proximity: proximityScore(f.distance / 1000, radiusKm),
      freshness: mean(listingParts.map((p) => p.freshness)),
      stock: mean(listingParts.map((p) => p.stock)) * 0.5 + variety * 0.5,
      rating: ratingPart(farmer),
      price: mean(listingParts.map((p) => p.price)),
      organic: farmer.organicVerified ? 1 : 0,
    };

    // Show the freshest items first on the farm card.
    const top = [...listingParts].sort((a, b) => b.freshness - a.freshness).slice(0, 4);

    return {
      farm: {
        id: String(f._id),
        name: f.name,
        image: f.images?.[0] ?? null,
        village: f.address?.village,
        district: f.address?.district,
        city: f.city,
        location: { lng: f.location.coordinates[0], lat: f.location.coordinates[1] },
        deliveryRadiusKm: f.deliveryRadiusKm,
        pickupAvailable: f.pickupAvailable,
      },
      farmer,
      distanceKm: round(f.distance / 1000, 1),
      roadDistanceKm: null as number | null,
      listingCount: f.listings.length,
      types: [...new Set(f.listings.map((l) => l.productType))],
      categories: [...new Set(f.listings.map((l) => l.category))],
      priceFrom: Math.min(...f.listings.map((l) => l.price)),
      topListings: top.map(({ l, freshness }) => ({
        id: String(l._id),
        productName: l.productName,
        price: l.price,
        unit: l.unit,
        packSizeGrams: l.packSizeGrams,
        image: l.images?.[0] ?? l.productDoc[0]?.image,
        freshness: round(freshness, 2),
      })),
      score: round(weightedScore(parts, W)),
      scoreBreakdown: roundParts(parts),
    };
  });
}

export type ScoredFarm = ReturnType<typeof scoreFarms>[number];

const farmSorters: Record<NearbyFarmersQuery['sort'], (a: ScoredFarm, b: ScoredFarm) => number> = {
  recommended: (a, b) => b.score - a.score || a.distanceKm - b.distanceKm,
  distance: (a, b) => a.distanceKm - b.distanceKm,
  rating: (a, b) => b.scoreBreakdown.rating - a.scoreBreakdown.rating || a.distanceKm - b.distanceKm,
};

export async function nearbyFarms(q: NearbyFarmersQuery) {
  const key = cacheKey('farms', q);
  const cached = await cache.get<Awaited<ReturnType<typeof computeNearbyFarms>>>(key);
  if (cached) return cached;
  const result = await computeNearbyFarms(q);
  await cache.set(key, result, RECOMMENDATION.cacheTtlSeconds);
  return result;
}

async function computeNearbyFarms(q: NearbyFarmersQuery) {
  const steps = radiusSteps(q.radiusKm);
  let radiusKm = steps[0];
  let rows: RawFarm[] = [];
  for (const r of steps) {
    radiusKm = r;
    rows = await fetchFarmCandidates(q.lng, q.lat, r, q);
    if (rows.length >= RECOMMENDATION.minFarmResults) break;
  }

  const scored = scoreFarms(rows, radiusKm).sort(farmSorters[q.sort]);
  const start = (q.page - 1) * q.limit;
  const items = scored.slice(start, start + q.limit);

  // Road distance only for what we are about to show — OSRM is comparatively expensive.
  const roadTargets = items.slice(0, RECOMMENDATION.roadDistanceTopK);
  const road = await roadDistancesKm({ lng: q.lng, lat: q.lat }, roadTargets.map((i) => i.farm.location));
  road.forEach((km, i) => (roadTargets[i].roadDistanceKm = km));

  return {
    items,
    meta: { ...pageMeta(q.page, q.limit, scored.length), radiusKm, expanded: radiusKm > steps[0], sort: q.sort },
  };
}
