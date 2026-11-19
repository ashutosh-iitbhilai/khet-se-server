import type { Request, Response } from 'express';
import * as admin from '../services/admin.service';

const me = (req: Request) => req.auth!.userId;
type Paged = { page: number; limit: number };

export async function overview(_req: Request, res: Response) {
  res.json({ success: true, data: await admin.overview() });
}
export async function users(req: Request, res: Response) {
  const r = await admin.listUsers(req.query as unknown as admin.UserQuery);
  res.json({ success: true, data: r.items, meta: r.meta });
}
export async function user(req: Request, res: Response) {
  res.json({ success: true, data: { user: await admin.userDetail(req.params.id) } });
}
export async function setStatus(req: Request, res: Response) {
  res.json({ success: true, data: await admin.setStatus(me(req), req.params.id, req.body.status, req.body.reason) });
}
export async function verificationQueue(req: Request, res: Response) {
  const { kind, page, limit } = req.query as unknown as Paged & { kind: 'profile' | 'organic' | 'all' };
  const r = await admin.verificationQueue(kind, page, limit);
  res.json({ success: true, data: r.items, meta: r.meta });
}
export async function decideVerification(req: Request, res: Response) {
  res.json({ success: true, data: await admin.decideVerification(me(req), req.params.id, req.body) });
}
export async function orders(req: Request, res: Response) {
  const r = await admin.listOrders(req.query as unknown as admin.OrderQuery);
  res.json({ success: true, data: r.items, meta: r.meta });
}
export async function order(req: Request, res: Response) {
  res.json({ success: true, data: await admin.orderDetail(req.params.id) });
}
export async function cancelGroup(req: Request, res: Response) {
  res.json({ success: true, data: await admin.cancelGroup(me(req), req.params.id, req.params.groupId, req.body.note) });
}
export async function recordRefund(req: Request, res: Response) {
  res.json({ success: true, data: await admin.recordRefund(me(req), req.params.id, req.body) });
}
export async function payments(req: Request, res: Response) {
  const r = await admin.listPayments(req.query as unknown as { page: number; limit: number });
  res.json({ success: true, data: r.items, meta: { ...r.meta, totals: r.totals } });
}
export async function audit(req: Request, res: Response) {
  const { page, limit } = req.query as unknown as Paged;
  const r = await admin.auditTrail(page, limit);
  res.json({ success: true, data: r.items, meta: r.meta });
}
