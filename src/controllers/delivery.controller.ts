import type { Request, Response } from 'express';
import * as delivery from '../services/delivery.service';

const uid = (req: Request) => req.auth!.userId;
type Paged = { page: number; limit: number };

export async function profile(req: Request, res: Response) {
  res.json({ success: true, data: { profile: await delivery.getProfile(uid(req)) } });
}

export async function updateProfile(req: Request, res: Response) {
  res.json({ success: true, data: { profile: await delivery.updateProfile(uid(req), req.body) } });
}

export async function overview(req: Request, res: Response) {
  res.json({ success: true, data: await delivery.overview(uid(req)) });
}

export async function available(req: Request, res: Response) {
  const { page, limit } = req.query as unknown as Paged;
  const { items, meta } = await delivery.availableJobs(uid(req), page, limit);
  res.json({ success: true, data: items, meta });
}

export async function mine(req: Request, res: Response) {
  const { view, page, limit } = req.query as unknown as Paged & { view: 'active' | 'completed' };
  const { items, meta } = await delivery.myJobs(uid(req), view, page, limit);
  res.json({ success: true, data: items, meta });
}

export async function accept(req: Request, res: Response) {
  res.json({ success: true, data: { job: await delivery.acceptJob(uid(req), req.params.id) } });
}

export async function release(req: Request, res: Response) {
  res.json({ success: true, data: await delivery.releaseJob(uid(req), req.params.id) });
}

export async function pickUp(req: Request, res: Response) {
  res.json({ success: true, data: { job: await delivery.pickUp(uid(req), req.params.id) } });
}

export async function deliver(req: Request, res: Response) {
  res.json({ success: true, data: { job: await delivery.deliver(uid(req), req.params.id, req.body.code) } });
}

/** Farmer: hand this order's delivery to a partner, or take it back. */
export async function requestPartner(req: Request, res: Response) {
  res.json({ success: true, data: { order: await delivery.requestPartner(uid(req), req.params.id, req.params.groupId) } });
}

export async function cancelPartnerRequest(req: Request, res: Response) {
  res.json({ success: true, data: { order: await delivery.cancelPartnerRequest(uid(req), req.params.id, req.params.groupId) } });
}
