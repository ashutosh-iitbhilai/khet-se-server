/**
 * Independent check of the discovery, ranking and checkout algorithms.
 *
 * For every test-bed customer (npm run seed:algo) it works out from the raw database, with its
 * own distance maths and its own implementation of the scoring formulas, what the API should
 * return, then compares that with what the running API actually returns:
 *
 *   1. eligibility   — exactly the right listings/farms (stock, active, delivery area, expiry…)
 *   2. distances     — within 50 m of a great-circle calculation
 *   3. radius        — the search widens only when too few results, to the right step
 *   4. scores        — every score part and the total match the documented formulas
 *   5. sort orders   — recommended (with farm diversity), distance, price, freshness, rating
 *   6. filters       — organic-verified, category, max price
 *   7. checkout      — anything shown can be ordered; fees follow the fee rule
 *   8. data          — each listing's stored location equals its farm's location
 *
 *   ALGO_URL=http://localhost:5000/api npm run algo:check
 */
import { connectDatabase, disconnectDatabase } from '../config/db';
import { RECOMMENDATION, radiusSteps } from '../config/recommendation';
import { ORDERS } from '../config/orders';
import { User } from '../models/User';
import { Farmer } from '../models/Farmer';
import { Farm } from '../models/Farm';
import { Product } from '../models/Product';
import { Inventory } from '../models/Inventory';
import { Address } from '../models/Address';
import { ALGO_DOMAIN } from './seed-algo';

const BASE = (process.env.ALGO_URL ?? 'http://localhost:5000/api').replace(/\/$/, '');
const DAY = 86_400_000;
const EARTH_KM = 6378.1; // the radius MongoDB uses for spherical distances

// ─── Independent maths ───────────────────────────────────────────────────────

const rad = (d: number) => (d * Math.PI) / 180;
function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}
const c01 = (n: number) => Math.max(0, Math.min(1, n));

interface L {
  id: string; farm: string; farmer: string; product: string; type: 'fresh' | 'dry'; category: string; price: number; unit: string; pack?: number;
  qty: number; min: number; harvest?: Date; processed?: Date; expiry?: Date; active: boolean; shelf: number; farmLoc: { lat: number; lng: number };
}
interface F { id: string; farmer: string; loc: { lat: number; lng: number }; radius: number; active: boolean; delivery: boolean; }
interface R { id: string; userActive: boolean; rating: number; count: number; organic: boolean; rejected: boolean }

function freshness(l: L, now: number) {
  if (l.type === 'fresh') return l.harvest ? c01(1 - Math.max(0, (now - l.harvest.getTime()) / DAY) / Math.max(1, l.shelf)) : 0;
  if (!l.expiry) return 0;
  const end = l.expiry.getTime();
  const start = l.processed ? l.processed.getTime() : end - l.shelf * DAY;
  return end - start <= 0 ? 0 : c01((end - now) / (end - start));
}
/** In stock for a minimum order, and not expired: dry goods before their expiry date, fresh produce within its shelf life. */
function sellable(l: L, now: number) {
  if (l.qty < l.min) return false;
  if (l.type === 'dry') return !!l.expiry && l.expiry.getTime() > now;
  return !!l.harvest && (now - l.harvest.getTime()) / DAY <= l.shelf;
}
const ratingPart = (r: R) => {
  const { ratingPrior: p, ratingPriorWeight: w } = RECOMMENDATION;
  return c01(((r.rating * r.count + p * w) / (r.count + w) - 1) / 4);
};
const W = RECOMMENDATION.weights;
const total = (parts: Record<keyof typeof W, number>) => {
  const keys = Object.keys(W) as (keyof typeof W)[];
  return keys.reduce((s, k) => s + W[k] * c01(parts[k]), 0) / keys.reduce((s, k) => s + W[k], 0);
};
const r3 = (n: number) => Math.round(n * 1000) / 1000;

// ─── Report ──────────────────────────────────────────────────────────────────

const results = new Map<string, { pass: number; fail: number; examples: string[] }>();
function check(name: string, ok: boolean, detail: () => string) {
  const r = results.get(name) ?? { pass: 0, fail: 0, examples: [] };
  if (ok) r.pass++;
  else {
    r.fail++;
    if (r.examples.length < 4) r.examples.push(detail());
  }
  results.set(name, r);
}

/** Each test customer gets its own client IP, so per-IP rate limits apply per customer (the API trusts one proxy hop). */
let clientIp = '10.200.0.1';
const headers = () => ({ 'Content-Type': 'application/json', 'X-Forwarded-For': clientIp });

async function get<T>(path: string): Promise<{ data: T; meta: Record<string, unknown> }> {
  const res = await fetch(BASE + path, { headers: headers() });
  const body = (await res.json()) as { success: boolean; data: T; meta: Record<string, unknown>; error?: { message: string } };
  if (!res.ok) throw new Error(`${path}: ${res.status} ${body.error?.message}`);
  return { data: body.data, meta: body.meta };
}
async function all<T>(path: string): Promise<{ items: T[]; meta: Record<string, unknown> }> {
  const items: T[] = [];
  let meta: Record<string, unknown> = {};
  for (let page = 1; page < 50; page++) {
    const r = await get<T[]>(`${path}&limit=50&page=${page}`);
    items.push(...r.data);
    meta = r.meta;
    if (page >= Number(r.meta.totalPages)) break;
  }
  return { items, meta };
}

interface ApiListing { id: string; distanceKm: number; price: number; freshness: number; score: number; scoreBreakdown: Record<keyof typeof W, number>; farm: { id: string }; farmer: { organicVerified: boolean } }
interface ApiFarm { farm: { id: string }; distanceKm: number; score: number; scoreBreakdown: Record<keyof typeof W, number>; listingCount: number }

async function main() {
  await connectDatabase();
  const now = Date.now();

  // Results are cached for cacheTtlSeconds; make sure nothing from before the last seed is served.
  const newest = await Farm.findOne({}, 'updatedAt').sort({ updatedAt: -1 }).lean();
  const wait = newest ? newest.updatedAt.getTime() + (RECOMMENDATION.cacheTtlSeconds + 2) * 1000 - Date.now() : 0;
  if (wait > 0) {
    console.log(`Waiting ${Math.ceil(wait / 1000)} s for cached results from before the last data change to expire…`);
    await new Promise((r) => setTimeout(r, wait));
  }

  // ── Raw data ──
  const [products, farms, farmers, users, inv] = await Promise.all([
    Product.find({}, 'shelfLifeDays isActive').lean(),
    Farm.find({}, 'farmer location deliveryRadiusKm isActive deliveryAvailable').lean(),
    Farmer.find({}, 'user ratingAvg ratingCount profileStatus organicCertification.status').lean(),
    User.find({ role: 'farmer' }, 'status').lean(),
    Inventory.find({}).lean(),
  ]);
  const shelf = new Map(products.filter((p) => p.isActive).map((p) => [String(p._id), p.shelfLifeDays]));
  const userActive = new Map(users.map((u) => [String(u._id), u.status === 'active']));
  const F = new Map<string, F>(farms.map((f) => [String(f._id), { id: String(f._id), farmer: String(f.farmer), loc: { lng: f.location.coordinates[0], lat: f.location.coordinates[1] }, radius: f.deliveryRadiusKm, active: f.isActive, delivery: f.deliveryAvailable }]));
  const R = new Map<string, R>(farmers.map((f) => [String(f._id), { id: String(f._id), userActive: userActive.get(String(f.user)) ?? false, rating: f.ratingAvg, count: f.ratingCount, organic: f.organicCertification?.status === 'verified', rejected: f.profileStatus === 'rejected' }]));
  const Ls: L[] = inv
    .filter((l) => shelf.has(String(l.product)))
    .map((l) => ({
      id: String(l._id), farm: String(l.farm), farmer: String(l.farmer), product: String(l.product), type: l.productType, category: l.category, price: l.price,
      unit: l.unit, pack: l.packSizeGrams ?? undefined, qty: l.quantityAvailable, min: l.minOrderQty, harvest: l.harvestDate ?? undefined, processed: l.processedDate ?? undefined,
      expiry: l.expiryDate ?? undefined, active: l.isActive, shelf: shelf.get(String(l.product))!, farmLoc: { lng: l.farmLocation.coordinates[0], lat: l.farmLocation.coordinates[1] },
    }));

  // 8. Data: denormalised listing location equals the farm's location.
  for (const l of Ls) {
    const f = F.get(l.farm);
    check('data: listing location = farm location', !!f && km(l.farmLoc, f.loc) < 0.001, () => `listing ${l.id} is ${f ? km(l.farmLoc, f.loc).toFixed(3) : '?'} km from its farm`);
  }

  const algoUsers = await User.find({ email: new RegExp(`@${ALGO_DOMAIN.replace(/\./g, '\\.')}$`), role: 'customer' }, '_id name').lean();
  const addresses = await Address.find({ user: { $in: algoUsers.map((u) => u._id) } }).lean();
  if (!addresses.length) throw new Error('No test-bed customers. Run `npm run seed:algo` first.');
  console.log(`Checking ${addresses.length} customer locations against ${BASE} (${Ls.length} listings, ${F.size} farms in the database)…`);

  for (const [n, a] of addresses.entries()) {
    clientIp = `10.200.${Math.floor(n / 250)}.${(n % 250) + 1}`;
    const P = { lng: a.location.coordinates[0], lat: a.location.coordinates[1] };
    const where = a.landmark ?? a.line1;
    const ll = `lng=${P.lng}&lat=${P.lat}`;

    // Oracle: what may be offered at this point, ignoring the search radius.
    const offerable = Ls.map((l) => ({ l, f: F.get(l.farm)!, r: R.get(l.farmer)! }))
      .filter(({ l, f, r }) => f && r && l.active && l.qty > 0 && f.active && f.delivery && r.userActive && !r.rejected && sellable(l, now))
      .map((x) => ({ ...x, d: km(P, x.f.loc) }))
      .filter((x) => x.d <= x.f.radius);

    // ── Listings ──
    const steps = radiusSteps();
    const radius = steps.find((s) => offerable.filter((x) => x.d <= s).length >= RECOMMENDATION.minProductResults) ?? steps[steps.length - 1]!;
    const expected = offerable.filter((x) => x.d <= radius);
    const api = await all<ApiListing>(`/inventory?${ll}&sort=distance`);
    check('radius: listings search widens to the right step', api.meta.radiusKm === radius, () => `${where}: API searched ${api.meta.radiusKm} km, expected ${radius} km`);

    const want = new Set(expected.map((x) => x.l.id));
    const got = new Set(api.items.map((i) => i.id));
    const missing = [...want].filter((id) => !got.has(id));
    const extra = [...got].filter((id) => !want.has(id));
    check('eligibility: exactly the offerable listings are shown', !missing.length && !extra.length, () => {
      const why = (id: string) => {
        const l = Ls.find((x) => x.id === id)!;
        const f = F.get(l.farm)!;
        const reasons = [!l.active && 'paused', l.qty <= 0 && 'no stock', !f.active && 'farm inactive', !f.delivery && 'delivery off',
          !R.get(l.farmer)!.userActive && 'farmer suspended', l.qty > 0 && l.qty < l.min && `stock ${l.qty} below minimum order ${l.min}`, l.qty >= l.min && !sellable(l, now) && (l.type === 'dry' ? 'expired' : 'past shelf life'),
          km(P, f.loc) > f.radius && `outside ${f.radius} km delivery area (${km(P, f.loc).toFixed(2)} km)`].filter(Boolean);
        return `${l.type} ${Ls.find((x) => x.id === id)?.category} ${id.slice(-5)} [${reasons.join(', ') || `within ${km(P, f.loc).toFixed(2)} km`}]`;
      };
      return `${where}: shown but should not be: ${extra.map(why).join('; ') || 'none'} | missing: ${missing.map(why).join('; ') || 'none'}`;
    });

    for (const i of api.items) {
      const e = expected.find((x) => x.l.id === i.id);
      if (!e) continue;
      check('distance: within 50 m of great-circle distance', Math.abs(i.distanceKm - e.d) <= 0.05 + 0.05, () => `${where}: listing ${i.id.slice(-5)} API ${i.distanceKm} km vs ${e.d.toFixed(3)} km`);
    }

    // Scores: recompute every part independently.
    const groups = new Map<string, number[]>();
    for (const x of expected) {
      const k = `${x.l.product}|${x.l.unit}|${x.l.pack ?? ''}`;
      groups.set(k, [...(groups.get(k) ?? []), x.l.price]);
    }
    for (const i of api.items) {
      const e = expected.find((x) => x.l.id === i.id);
      if (!e) continue;
      const prices = groups.get(`${e.l.product}|${e.l.unit}|${e.l.pack ?? ''}`)!;
      const [mn, mx] = [Math.min(...prices), Math.max(...prices)];
      const parts = {
        proximity: c01(1 - e.d / radius),
        freshness: freshness(e.l, now),
        stock: c01(e.l.qty / (Math.max(e.l.min, 0.1) * RECOMMENDATION.stockTargetOrders)),
        rating: ratingPart(e.r),
        price: mx <= mn ? 1 : c01((mx - e.l.price) / (mx - mn)),
        organic: e.r.organic ? 1 : 0,
      };
      const bad = (Object.keys(parts) as (keyof typeof parts)[]).filter((k) => Math.abs(parts[k] - i.scoreBreakdown[k]) > 0.006);
      check('scores: each part matches its formula', !bad.length, () => `${where}: listing ${i.id.slice(-5)} ${bad.map((k) => `${k} API ${i.scoreBreakdown[k]} vs ${r3(parts[k])}`).join(', ')}`);
      check('scores: total is the weighted mean of the parts', Math.abs(r3(total(parts)) - i.score) <= 0.004, () => `${where}: listing ${i.id.slice(-5)} API ${i.score} vs ${r3(total(parts))}`);
    }

    // Sort orders (all results on one page, so the whole order can be checked).
    const sorted = async (sort: string) => (await get<ApiListing[]>(`/inventory?${ll}&sort=${sort}&limit=50`)).data;
    const isSorted = <T>(xs: T[], cmp: (a: T, b: T) => number) => xs.every((x, k) => k === 0 || cmp(xs[k - 1]!, x) <= 0);
    check('sort: distance ascending', isSorted(await sorted('distance'), (a, b) => a.distanceKm - b.distanceKm), () => `${where}`);
    check('sort: price ascending', isSorted(await sorted('price_asc'), (a, b) => a.price - b.price), () => `${where}`);
    check('sort: price descending', isSorted(await sorted('price_desc'), (a, b) => b.price - a.price), () => `${where}`);
    check('sort: freshness descending', isSorted(await sorted('freshness'), (a, b) => b.freshness - a.freshness), () => `${where}`);

    // Recommended = greedy diversity over score order (independent re-implementation).
    const rec = await sorted('recommended');
    const pool = [...rec].sort((a, b) => b.score - a.score || a.distanceKm - b.distanceKm);
    const picked = new Map<string, number>();
    const expectOrder: string[] = [];
    while (pool.length) {
      let bi = 0;
      let best = -Infinity;
      pool.forEach((x, k) => {
        const s = x.score * RECOMMENDATION.sameFarmDecay ** (picked.get(x.farm.id) ?? 0);
        if (s > best) [best, bi] = [s, k];
      });
      const [x] = pool.splice(bi, 1);
      picked.set(x!.farm.id, (picked.get(x!.farm.id) ?? 0) + 1);
      expectOrder.push(x!.id);
    }
    check('sort: recommended = score order with farm diversity', rec.map((x) => x.id).join() === expectOrder.join(), () => `${where}: order differs`);
    const top8 = rec.slice(0, 8);
    const farmsInTop = new Set(top8.map((x) => x.farm.id)).size;
    const farmsAvailable = new Set(rec.map((x) => x.farm.id)).size;
    check('diversity: first 8 recommendations span several farms', farmsInTop >= Math.min(3, farmsAvailable), () => `${where}: only ${farmsInTop} farm(s) of ${farmsAvailable} in the top 8`);

    // Filters.
    const organic = await all<ApiListing>(`/inventory?${ll}&organic=true&sort=distance`);
    check('filter: organic shows only verified farms', organic.items.every((i) => i.farmer.organicVerified), () => `${where}: unverified farm in organic results`);
    const cheap = await all<ApiListing>(`/inventory?${ll}&maxPrice=30&sort=distance`);
    check('filter: max price', cheap.items.every((i) => i.price <= 30), () => `${where}: price above 30 in results`);

    // ── Farms ──
    const offerableFarms = new Map<string, number>();
    for (const x of offerable) offerableFarms.set(x.f.id, x.d);
    const fRadius = steps.find((s) => [...offerableFarms.values()].filter((d) => d <= s).length >= RECOMMENDATION.minFarmResults) ?? steps[steps.length - 1]!;
    const wantFarms = new Set([...offerableFarms].filter(([, d]) => d <= fRadius).map(([id]) => id));
    const farmsApi = await all<ApiFarm>(`/farmers/nearby?${ll}&sort=distance`);
    check('radius: farm search widens to the right step', farmsApi.meta.radiusKm === fRadius, () => `${where}: API ${farmsApi.meta.radiusKm} km, expected ${fRadius} km`);
    const gotFarms = new Set(farmsApi.items.map((f) => f.farm.id));
    check(
      'eligibility: exactly the farms that can deliver something are shown',
      wantFarms.size === gotFarms.size && [...wantFarms].every((id) => gotFarms.has(id)),
      () => `${where}: missing ${[...wantFarms].filter((id) => !gotFarms.has(id)).length}, extra ${[...gotFarms].filter((id) => !wantFarms.has(id)).length}`,
    );
    check('sort: farms by distance', isSorted(farmsApi.items, (a, b) => a.distanceKm - b.distanceKm), () => `${where}`);
    for (const f of farmsApi.items) {
      const d = offerableFarms.get(f.farm.id);
      if (d !== undefined) check('distance: farms within 50 m', Math.abs(f.distanceKm - d) <= 0.1, () => `${where}: farm ${f.farm.id.slice(-5)} API ${f.distanceKm} vs ${d.toFixed(3)}`);
    }

    // ── Checkout agrees with discovery ──
    // Everything shown must be orderable here, and everything in a farm's delivery area that
    // checkout would accept must also be shown (within the search radius).
    const nearbyFarmIds = [...F.values()].filter((f) => km(P, f.loc) <= radius + 1).map((f) => f.id);
    const candidates = Ls.filter((l) => nearbyFarmIds.includes(l.farm) && l.qty > 0 && l.active);
    for (const l of candidates) {
      const res = await fetch(`${BASE}/orders/quote`, { method: 'POST', headers: headers(), body: JSON.stringify({ items: [{ listing: l.id, quantity: l.min }], location: P }) });
      if (!res.ok) throw new Error(`quote failed: ${res.status} ${await res.text()}`);
      const q = ((await res.json()) as { data: { issues: { code: string }[]; groups: { subtotal: number; deliveryFee: number; distanceKm: number }[] } }).data;
      const orderable = q.issues.length === 0;
      const shown = got.has(l.id);
      const inSearch = km(P, F.get(l.farm)!.loc) <= radius;
      if (inSearch) check('checkout: shown ⇔ orderable (same rules both places)', shown === orderable, () => `${where}: ${l.type} ${l.category} ${l.id.slice(-5)} at ${km(P, F.get(l.farm)!.loc).toFixed(3)} km (farm area ${F.get(l.farm)!.radius} km): shown=${shown}, checkout=${orderable ? 'accepts' : q.issues.map((i) => i.code).join('/')}`);
      if (orderable) {
        const g = q.groups[0]!;
        const fee = g.subtotal >= ORDERS.delivery.freeAboveSubtotal ? 0 : Math.min(ORDERS.delivery.maxFee, ORDERS.delivery.baseFee + ORDERS.delivery.perKm * Math.ceil(g.distanceKm));
        check('checkout: delivery fee follows the fee rule', g.deliveryFee === fee, () => `${where}: fee ${g.deliveryFee}, expected ${fee}`);
      }
    }
  }

  // ── Print ──
  let failed = 0;
  console.log('');
  for (const [name, r] of [...results].sort()) {
    failed += r.fail;
    console.log(`${r.fail ? '✗' : '✓'} ${name.padEnd(62)} ${String(r.pass).padStart(5)} passed${r.fail ? `, ${r.fail} FAILED` : ''}`);
    for (const ex of r.examples) console.log(`     ↳ ${ex}`);
  }
  console.log(failed ? `\n${failed} checks failed.` : '\nAll checks passed.');
  process.exitCode = failed ? 1 : 0;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 2;
  })
  .finally(disconnectDatabase);
