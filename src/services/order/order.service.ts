import crypto from 'crypto';
import type { ClientSession, FilterQuery, Types } from 'mongoose';
import { Order, type GroupStatus, type IOrder, type OrderDocument, type PaymentMethod } from '../../models/Order';
import { Address } from '../../models/Address';
import { Delivery } from '../../models/Delivery';
import { User } from '../../models/User';
import { ORDERS } from '../../config/orders';
import { invalidateRecommendations } from '../../config/cache';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../utils/logger';
import { pageMeta, skipFor } from '../../utils/pagination';
import { withTransaction } from '../../utils/transaction';
import { requireFarmer } from '../farmer.service';
import { recordCod, syncCodRecord } from '../payments/payment.service';
import { buildQuote, publicQuote } from './quote.service';
import { consumeStock, releaseStock, reserveStock, type StockLine } from './stock.service';
import { allowedFrom, deriveOrderStatus, derivePayment, stockEffect, type Actor } from './rules';
import type { PlaceOrderInput, QuoteLine } from '../../validators/order.validator';

// ─── Helpers ────────────────────────────────────────────────────────────────

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion
function orderNumber() {
  const d = new Date();
  const ymd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = Array.from(crypto.randomBytes(5), (b) => ALPHABET[b % ALPHABET.length]).join('');
  return `KS${ymd}-${rand}`;
}

const handoverCode = () => String(crypto.randomInt(0, 10000)).padStart(4, '0');

const linesOf = (items: { inventory: Types.ObjectId; quantity: number; productName: string }[]): StockLine[] =>
  items.map((i) => ({ inventory: i.inventory, quantity: i.quantity, productName: i.productName }));

/** Whole order as the customer sees it (includes handover codes). */
export function forCustomer(o: OrderDocument | (IOrder & { _id: Types.ObjectId })) {
  const doc = 'toJSON' in o ? (o as OrderDocument).toJSON() : o;
  return { ...doc, id: String(o._id) };
}

/** Only the requesting farmer's groups, without handover codes. */
export function forFarmer(o: OrderDocument, farmerId: string) {
  const json = o.toJSON() as unknown as Record<string, unknown> & { groups: Record<string, unknown>[] };
  return {
    id: String(o._id),
    orderNumber: o.orderNumber,
    createdAt: o.createdAt,
    address: json.address,
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    groups: o.groups
      .filter((g) => String(g.farmer) === farmerId)
      .map((g) => {
        const { handoverCode: _code, ...rest } = g.toJSON() as unknown as Record<string, unknown>;
        return { ...rest, id: String(g._id), status: g.status };
      }),
  };
}

// ─── Quote & place ──────────────────────────────────────────────────────────

export async function quote(lines: QuoteLine[], at: { lng: number; lat: number }) {
  return publicQuote(await buildQuote(lines, at));
}

export async function placeOrder(customerId: string, idempotencyKey: string, input: PlaceOrderInput) {
  // Replayed request (double tap, network retry): return the order already created.
  const existing = await Order.findOne({ customer: customerId, idempotencyKey });
  if (existing) return { order: existing, replayed: true };

  const [address, customer] = await Promise.all([
    Address.findOne({ _id: input.addressId, user: customerId }),
    User.findById(customerId, 'status'),
  ]);
  if (!address) throw ApiError.notFound('Delivery address not found');
  if (customer?.status !== 'active') throw ApiError.forbidden('Your account cannot place orders');

  const [lng, lat] = address.location.coordinates;
  const q = await buildQuote(input.items, { lng, lat });

  if (q.issues.length || q.groups.length === 0) {
    throw new ApiError(409, 'CART_CHANGED', 'Some items in your cart need attention', publicQuote(q));
  }
  if (Math.abs(q.grandTotal - input.expectedTotal) > 0.009) {
    throw new ApiError(409, 'PRICE_CHANGED', 'Prices or delivery fees changed since you last checked. Please review the new total.', publicQuote(q));
  }

  const paymentMethod: PaymentMethod = input.paymentMethod;
  const doc: Partial<IOrder> = {
    orderNumber: orderNumber(),
    customer: customerId as unknown as Types.ObjectId,
    idempotencyKey,
    address: {
      name: address.name,
      phone: address.phone,
      line1: address.line1,
      landmark: address.landmark,
      city: address.city,
      pincode: address.pincode,
      location: address.location,
    },
    groups: q.groups.map((g) => ({
      farmer: g.farmer,
      farm: g.farm,
      farmName: g.farmName,
      farmerName: g.farmerName,
      farmerPhone: g.farmerPhone,
      items: g.items.map(({ listing: _l, minOrderQty: _m, available: _a, ...item }) => item),
      subtotal: g.subtotal,
      deliveryFee: g.deliveryFee,
      total: g.total,
      distanceKm: g.distanceKm,
      status: 'pending',
      history: [{ status: 'pending', at: new Date(), by: 'customer' }],
      handoverCode: handoverCode(),
      paymentCollected: false,
    })) as unknown as IOrder['groups'],
    itemsTotal: q.itemsTotal,
    deliveryTotal: q.deliveryTotal,
    grandTotal: q.grandTotal,
    paymentMethod,
    paymentStatus: paymentMethod === 'cod' ? 'cod_pending' : 'pending',
    reservationExpiresAt: paymentMethod === 'online' ? new Date(Date.now() + ORDERS.onlinePaymentWindowMinutes * 60_000) : null,
    status: 'placed',
  };
  const stock = q.groups.flatMap((g) => linesOf(g.items));

  try {
    const order = await withTransaction(async (session) => {
      await reserveStock(stock, session);
      try {
        const [created] = await Order.create([doc], { session });
        return created;
      } catch (err) {
        if (!session) await releaseStock(stock, undefined); // compensate on standalone servers
        throw err;
      }
    });
    if (paymentMethod === 'cod') await recordCod(order);
    void invalidateRecommendations();
    logger.info(`Order ${order.orderNumber} placed (${paymentMethod}, ₹${order.grandTotal}, ${order.groups.length} farm(s))`);
    return { order, replayed: false };
  } catch (err) {
    // Two identical requests raced: the loser returns the winner's order.
    if ((err as { code?: number }).code === 11000 && String((err as Error).message).includes('idempotencyKey')) {
      const winner = await Order.findOne({ customer: customerId, idempotencyKey });
      if (winner) return { order: winner, replayed: true };
    }
    throw err;
  }
}

// ─── Reading ────────────────────────────────────────────────────────────────

export async function listForCustomer(customerId: string, page: number, limit: number) {
  const filter = { customer: customerId };
  const [items, total] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip(skipFor(page, limit)).limit(limit),
    Order.countDocuments(filter),
  ]);
  return { items: items.map(forCustomer), meta: pageMeta(page, limit, total) };
}

const FARMER_VIEWS: Record<'incoming' | 'active' | 'completed', GroupStatus[]> = {
  incoming: ['pending'],
  active: ['accepted', 'packed', 'out_for_delivery'],
  completed: ['delivered', 'rejected', 'cancelled'],
};

export async function listForFarmer(userId: string, view: keyof typeof FARMER_VIEWS, page: number, limit: number) {
  const farmer = await requireFarmer(userId);
  const filter: FilterQuery<IOrder> = {
    groups: { $elemMatch: { farmer: farmer._id, status: { $in: FARMER_VIEWS[view] } } },
  };
  // Unpaid online orders stay hidden from farmers until payment succeeds.
  if (view === 'incoming') filter.$or = [{ paymentMethod: 'cod' }, { paymentStatus: { $in: ['paid', 'refund_pending'] } }];

  const [items, total] = await Promise.all([
    Order.find(filter).sort({ createdAt: view === 'completed' ? -1 : 1 }).skip(skipFor(page, limit)).limit(limit),
    Order.countDocuments(filter),
  ]);
  const fid = String(farmer._id);
  return {
    items: items.map((o) => {
      const v = forFarmer(o, fid);
      // Within an order, show only the groups that belong in this view.
      return { ...v, groups: v.groups.filter((g) => FARMER_VIEWS[view].includes(g.status as GroupStatus)) };
    }),
    meta: pageMeta(page, limit, total),
  };
}

export async function getForUser(orderId: string, user: { userId: string; role: string }) {
  const order = await Order.findById(orderId);
  if (!order) throw ApiError.notFound('Order not found');
  if (user.role === 'admin') return forCustomer(order);
  if (user.role === 'customer' && String(order.customer) === user.userId) return forCustomer(order);
  if (user.role === 'farmer') {
    const farmer = await requireFarmer(user.userId);
    if (order.groups.some((g) => String(g.farmer) === String(farmer._id))) return forFarmer(order, String(farmer._id));
  }
  throw ApiError.notFound('Order not found'); // don't reveal other people's orders exist
}

// ─── Status changes ─────────────────────────────────────────────────────────

interface TransitionOptions {
  actor: Actor;
  farmerId?: Types.ObjectId;
  customerId?: string;
  note?: string;
  code?: string;
  deliveryDate?: Date;
}

/** Re-derives order status and payment status from groups and saves them. */
async function syncDerived(order: OrderDocument, session: ClientSession | undefined) {
  const status = deriveOrderStatus(order.groups.map((g) => g.status));
  const pay = derivePayment(order.paymentMethod, order.paymentStatus, order.groups);
  const $set: Record<string, unknown> = { status, paymentStatus: pay.paymentStatus, refundDue: pay.refundDue };
  if (pay.paymentStatus !== 'pending') $set.reservationExpiresAt = null;
  await Order.updateOne({ _id: order._id }, { $set }, { session });
  order.set($set);
}

/**
 * Moves one group to a new status. The status check and update are a single atomic
 * operation, so two clicks (or a farmer and the expiry job) can never both apply —
 * which also guarantees stock is released or consumed exactly once.
 */
export async function transitionGroup(orderId: string, groupId: string, to: GroupStatus, opts: TransitionOptions) {
  const from = allowedFrom(opts.actor, to);
  if (!from.length) throw ApiError.badRequest(`You can't change an order to "${to}"`);

  const current = await Order.findById(orderId);
  const group = current?.groups.id(groupId);
  if (!current || !group) throw ApiError.notFound('Order not found');
  if (opts.farmerId && String(group.farmer) !== String(opts.farmerId)) throw ApiError.notFound('Order not found');
  if (opts.customerId && String(current.customer) !== opts.customerId) throw ApiError.notFound('Order not found');

  const conflict = (status: GroupStatus) =>
    ApiError.conflict(`This order is already "${status.replace(/_/g, ' ')}" and can't be changed to "${to.replace(/_/g, ' ')}"`);
  // Fast, friendly check; the atomic update below is what actually guarantees it.
  if (!from.includes(group.status)) throw conflict(group.status);

  if (opts.actor === 'farmer' && to === 'accepted' && current.paymentMethod === 'online' && current.paymentStatus === 'pending') {
    throw ApiError.conflict('This order has not been paid yet');
  }
  if (to === 'delivered' && opts.actor === 'farmer') {
    if (!opts.code) throw ApiError.badRequest('Ask the customer for their 4-digit delivery code', [{ field: 'code', message: 'Required' }]);
    if (opts.code !== group.handoverCode) {
      throw ApiError.badRequest('That delivery code is not correct', [{ field: 'code', message: 'Incorrect code' }]);
    }
  }

  const now = new Date();
  const set: Record<string, unknown> = { 'groups.$.status': to };
  if (to === 'accepted') set['groups.$.scheduledFor'] = opts.deliveryDate ?? new Date(now.getTime() + 24 * 3600_000);
  if (to === 'delivered' && current.paymentMethod === 'cod') set['groups.$.paymentCollected'] = true;
  if ((to === 'rejected' || to === 'cancelled') && opts.note) set['groups.$.cancelReason'] = opts.note;

  const updated = await withTransaction(async (session) => {
    const order = await Order.findOneAndUpdate(
      { _id: orderId, groups: { $elemMatch: { _id: groupId, status: { $in: from } } } },
      { $set: set, $push: { 'groups.$.history': { status: to, at: now, by: opts.actor, note: opts.note } } },
      { new: true, session },
    );
    if (!order) {
      throw ApiError.conflict(`This order is already "${group.status.replace(/_/g, ' ')}" and can't be changed to "${to.replace(/_/g, ' ')}"`);
    }
    const g = order.groups.id(groupId)!;

    const effect = stockEffect(to);
    if (effect === 'release') await releaseStock(linesOf(g.items), session);
    if (effect === 'consume') await consumeStock(linesOf(g.items), session);

    await syncDeliveryRecord(order, g, to, session);
    await syncDerived(order, session);
    return order;
  });

  await syncCodRecord(updated);
  if (stockEffect(to) === 'release') void invalidateRecommendations();
  logger.info(`Order ${updated.orderNumber} group ${groupId}: ${group.status} → ${to} (${opts.actor})`);
  return updated;
}

async function syncDeliveryRecord(order: OrderDocument, g: OrderDocument['groups'][number], to: GroupStatus, session: ClientSession | undefined) {
  const key = { order: order._id, group: g._id };
  const now = new Date();
  if (to === 'accepted') {
    await Delivery.updateOne(
      key,
      { $setOnInsert: { farmer: g.farmer, farm: g.farm, customer: order.customer, distanceKm: g.distanceKm }, $set: { status: 'scheduled', scheduledFor: g.scheduledFor } },
      { upsert: true, session },
    );
  } else if (to === 'out_for_delivery') {
    await Delivery.updateOne(key, { $set: { status: 'out_for_delivery', outAt: now } }, { session });
  } else if (to === 'delivered') {
    await Delivery.updateOne(key, { $set: { status: 'delivered', deliveredAt: now } }, { session });
  } else if (to === 'cancelled' || to === 'rejected') {
    await Delivery.updateOne(key, { $set: { status: 'cancelled' } }, { session });
  }
}

export async function farmerUpdateStatus(userId: string, orderId: string, body: { groupId: string; status: GroupStatus; note?: string; code?: string; deliveryDate?: Date }) {
  const farmer = await requireFarmer(userId);
  const order = await transitionGroup(orderId, body.groupId, body.status, {
    actor: 'farmer',
    farmerId: farmer._id,
    note: body.note,
    code: body.code,
    deliveryDate: body.deliveryDate,
  });
  return forFarmer(order, String(farmer._id));
}

/** Customer cancels one pending group, or every pending group when no groupId is given. */
export async function customerCancel(userId: string, orderId: string, groupId?: string, reason?: string) {
  const order = await Order.findOne({ _id: orderId, customer: userId });
  if (!order) throw ApiError.notFound('Order not found');
  const targets = groupId ? [groupId] : order.groups.filter((g) => g.status === 'pending').map((g) => String(g._id));
  if (!targets.length) throw ApiError.conflict('Farmers have already accepted this order, so it can no longer be cancelled here.');

  let latest: OrderDocument = order;
  for (const gid of targets) {
    latest = await transitionGroup(orderId, gid, 'cancelled', { actor: 'customer', customerId: userId, note: reason ?? 'Cancelled by customer' });
  }
  return forCustomer(latest);
}

/** Background job: cancel unpaid online orders whose reservation window has passed. */
export async function expireUnpaidOrders(now = new Date()) {
  const expired = await Order.find({ paymentStatus: 'pending', reservationExpiresAt: { $lte: now } }).limit(100);
  let cancelled = 0;
  for (const o of expired) {
    for (const g of o.groups.filter((x) => x.status === 'pending')) {
      try {
        await transitionGroup(String(o._id), String(g._id), 'cancelled', { actor: 'system', note: 'Payment not completed in time' });
        cancelled++;
      } catch (err) {
        // Another worker or a late payment got there first — that's fine.
        if (!(err instanceof ApiError && err.statusCode === 409)) logger.warn(`Expiry failed for ${o.orderNumber}`, err);
      }
    }
  }
  return { orders: expired.length, groupsCancelled: cancelled };
}

export async function pendingCountForFarmer(farmerId: Types.ObjectId) {
  return Order.countDocuments({
    groups: { $elemMatch: { farmer: farmerId, status: 'pending' } },
    $or: [{ paymentMethod: 'cod' }, { paymentStatus: { $in: ['paid', 'refund_pending'] } }],
  });
}
