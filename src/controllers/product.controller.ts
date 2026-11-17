import type { Request, Response } from 'express';
import * as productService from '../services/product.service';
import type { ListProductsQuery } from '../validators/product.validator';

export async function list(req: Request, res: Response) {
  const { items, meta } = await productService.list(req.query as unknown as ListProductsQuery, {
    includeInactive: req.auth?.role === 'admin',
  });
  // Catalogue changes rarely — let browsers/CDNs cache briefly.
  if (req.auth?.role !== 'admin') res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  res.json({ success: true, data: items, meta });
}

export async function get(req: Request, res: Response) {
  res.json({ success: true, data: { product: await productService.getByIdOrSlug(req.params.id) } });
}

export async function create(req: Request, res: Response) {
  res.status(201).json({ success: true, data: { product: await productService.create(req.body) } });
}

export async function update(req: Request, res: Response) {
  res.json({ success: true, data: { product: await productService.update(req.params.id, req.body) } });
}

export async function remove(req: Request, res: Response) {
  res.json({ success: true, data: await productService.remove(req.params.id) });
}
