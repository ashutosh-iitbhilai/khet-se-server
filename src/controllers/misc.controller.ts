import type { Request, Response } from 'express';
import * as geoService from '../services/geo.service';
import * as uploadService from '../services/upload.service';
import * as userService from '../services/user.service';

export async function geoSearch(req: Request, res: Response) {
  res.json({ success: true, data: { places: await geoService.search(String(req.query.q)) } });
}

export async function geoReverse(req: Request, res: Response) {
  const place = await geoService.reverse(Number(req.query.lat), Number(req.query.lng));
  res.json({ success: true, data: { place } });
}

export async function uploadConfig(_req: Request, res: Response) {
  res.json({ success: true, data: { enabled: uploadService.uploadsEnabled() } });
}

export async function signUpload(req: Request, res: Response) {
  res.json({ success: true, data: uploadService.signUpload(req.body.kind, req.auth!.userId) });
}

export async function updateMe(req: Request, res: Response) {
  res.json({ success: true, data: { user: await userService.updateMe(req.auth!.userId, req.body) } });
}
