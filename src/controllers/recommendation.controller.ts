import type { Request, Response } from 'express';
import * as rec from '../services/recommendation/recommendation.service';
import * as publicService from '../services/public.service';
import type { NearbyFarmersQuery, NearbyListingsQuery } from '../validators/recommendation.validator';

/** GET /farmers/nearby — farm discovery with filters and a choice of sort. */
export async function nearbyFarmers(req: Request, res: Response) {
  const { items, meta } = await rec.nearbyFarms(req.query as unknown as NearbyFarmersQuery);
  res.json({ success: true, data: items, meta });
}

/** GET /recommendations/farmers — always ranked by the weighted recommendation score. */
export async function recommendedFarmers(req: Request, res: Response) {
  const q = { ...(req.query as unknown as NearbyFarmersQuery), sort: 'recommended' as const };
  const { items, meta } = await rec.nearbyFarms(q);
  res.json({ success: true, data: items, meta });
}

/** GET /inventory — marketplace listings near a location. */
export async function nearbyListings(req: Request, res: Response) {
  const { items, meta } = await rec.nearbyListings(req.query as unknown as NearbyListingsQuery);
  res.json({ success: true, data: items, meta });
}

/** GET /recommendations/products — listings ranked by the weighted recommendation score. */
export async function recommendedProducts(req: Request, res: Response) {
  const q = { ...(req.query as unknown as NearbyListingsQuery), sort: 'recommended' as const };
  const { items, meta } = await rec.nearbyListings(q);
  res.json({ success: true, data: items, meta });
}

/** GET /inventory/:id — public listing detail. */
export async function listingDetail(req: Request, res: Response) {
  const { lng, lat } = req.query as { lng?: number; lat?: number };
  const at = lng !== undefined && lat !== undefined ? { lng: Number(lng), lat: Number(lat) } : undefined;
  res.json({ success: true, data: { item: await publicService.listingDetail(req.params.id, at) } });
}
