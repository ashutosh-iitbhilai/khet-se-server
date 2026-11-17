import type { Request, Response } from 'express';
import * as farmService from '../services/farm.service';

export async function listMine(req: Request, res: Response) {
  res.json({ success: true, data: { farms: await farmService.listMine(req.auth!.userId) } });
}

export async function create(req: Request, res: Response) {
  res.status(201).json({ success: true, data: { farm: await farmService.create(req.auth!.userId, req.body) } });
}

export async function update(req: Request, res: Response) {
  res.json({ success: true, data: { farm: await farmService.update(req.auth!.userId, req.params.id, req.body) } });
}
