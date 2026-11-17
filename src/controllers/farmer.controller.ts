import type { Request, Response } from 'express';
import * as farmerService from '../services/farmer.service';
import * as publicService from '../services/public.service';

export async function getMe(req: Request, res: Response) {
  res.json({ success: true, data: await farmerService.getMyProfile(req.auth!.userId) });
}

export async function getOverview(req: Request, res: Response) {
  res.json({ success: true, data: await farmerService.getOverview(req.auth!.userId) });
}

export async function createProfile(req: Request, res: Response) {
  res.status(201).json({ success: true, data: { farmer: await farmerService.upsertProfile(req.auth!.userId, req.body) } });
}

export async function updateProfile(req: Request, res: Response) {
  res.json({ success: true, data: { farmer: await farmerService.upsertProfile(req.auth!.userId, req.body) } });
}

export async function getPublic(req: Request, res: Response) {
  const { lng, lat } = req.query as { lng?: number; lat?: number };
  const at = lng !== undefined && lat !== undefined ? { lng: Number(lng), lat: Number(lat) } : undefined;
  res.json({ success: true, data: await publicService.farmerProfile(req.params.id, at) });
}
