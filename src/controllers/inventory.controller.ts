import type { Request, Response } from 'express';
import * as inventoryService from '../services/inventory.service';
import type { ListMyInventoryQuery } from '../validators/inventory.validator';

export async function listMine(req: Request, res: Response) {
  const { items, meta } = await inventoryService.listMine(req.auth!.userId, req.query as unknown as ListMyInventoryQuery);
  res.json({ success: true, data: items, meta });
}

export async function getMine(req: Request, res: Response) {
  res.json({ success: true, data: { item: await inventoryService.getMine(req.auth!.userId, req.params.id) } });
}

export async function create(req: Request, res: Response) {
  res.status(201).json({ success: true, data: { item: await inventoryService.create(req.auth!.userId, req.body) } });
}

export async function update(req: Request, res: Response) {
  res.json({ success: true, data: { item: await inventoryService.update(req.auth!.userId, req.params.id, req.body) } });
}

export async function adjustStock(req: Request, res: Response) {
  const item = await inventoryService.adjustStock(req.auth!.userId, req.params.id, req.body.mode, req.body.quantity);
  res.json({ success: true, data: { item } });
}

export async function remove(req: Request, res: Response) {
  await inventoryService.remove(req.auth!.userId, req.params.id);
  res.status(204).end();
}
