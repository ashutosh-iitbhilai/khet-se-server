import type { Request, Response } from 'express';
import * as addressService from '../services/address.service';
import * as orderService from '../services/order/order.service';
import * as paymentService from '../services/payments/payment.service';
import { checkout } from '../services/order/checkout.service';
import { ApiError } from '../utils/ApiError';
import { IDEMPOTENCY_KEY } from '../validators/order.validator';

// ── Addresses ──
export async function listAddresses(req: Request, res: Response) {
  res.json({ success: true, data: { addresses: await addressService.listMine(req.auth!.userId) } });
}
export async function createAddress(req: Request, res: Response) {
  res.status(201).json({ success: true, data: { address: await addressService.create(req.auth!.userId, req.body) } });
}
export async function updateAddress(req: Request, res: Response) {
  res.json({ success: true, data: { address: await addressService.update(req.auth!.userId, req.params.id, req.body) } });
}
export async function deleteAddress(req: Request, res: Response) {
  await addressService.remove(req.auth!.userId, req.params.id);
  res.status(204).end();
}

// ── Orders ──
export async function quote(req: Request, res: Response) {
  res.json({ success: true, data: await orderService.quote(req.body.items, req.body.location) });
}

export async function place(req: Request, res: Response) {
  const key = req.header('Idempotency-Key') ?? '';
  if (!IDEMPOTENCY_KEY.test(key)) throw ApiError.badRequest('Missing or invalid Idempotency-Key header');
  const result = await checkout(req.auth!.userId, key, req.body);
  res.status(result.replayed ? 200 : 201).json({ success: true, data: result });
}

export async function myOrders(req: Request, res: Response) {
  const { page, limit } = req.query as unknown as { page: number; limit: number };
  const { items, meta } = await orderService.listForCustomer(req.auth!.userId, page, limit);
  res.json({ success: true, data: items, meta });
}

export async function farmerOrders(req: Request, res: Response) {
  const { view, page, limit } = req.query as unknown as { view: 'incoming' | 'active' | 'completed'; page: number; limit: number };
  const { items, meta } = await orderService.listForFarmer(req.auth!.userId, view, page, limit);
  res.json({ success: true, data: items, meta });
}

export async function getOne(req: Request, res: Response) {
  res.json({ success: true, data: { order: await orderService.getForUser(req.params.id, req.auth!) } });
}

export async function updateStatus(req: Request, res: Response) {
  res.json({ success: true, data: { order: await orderService.farmerUpdateStatus(req.auth!.userId, req.params.id, req.body) } });
}

export async function newCode(req: Request, res: Response) {
  const order = await orderService.regenerateHandoverCode(req.auth!.userId, req.params.id, req.params.groupId);
  res.json({ success: true, data: { order } });
}

export async function cancel(req: Request, res: Response) {
  const order = await orderService.customerCancel(req.auth!.userId, req.params.id, req.body.groupId, req.body.reason);
  res.json({ success: true, data: { order } });
}

// ── Payments ──
export async function paymentMethods(_req: Request, res: Response) {
  res.json({ success: true, data: paymentService.availableMethods() });
}

export async function retryPayment(req: Request, res: Response) {
  res.json({ success: true, data: { payment: await paymentService.retryPayment(req.auth!.userId, req.params.id) } });
}

export async function verifyPayment(req: Request, res: Response) {
  const order = await paymentService.verifyCheckout(req.auth!.userId, req.body);
  res.json({ success: true, data: { order: order ? orderService.forCustomer(order) : null } });
}

/** Raw body (Buffer) — mounted with express.raw before the JSON parser. */
export async function razorpayWebhook(req: Request, res: Response) {
  const result = await paymentService.handleWebhook(req.body as Buffer, req.header('X-Razorpay-Signature'));
  res.json({ success: true, data: result });
}
