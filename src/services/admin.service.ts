/**
 * Admin console: platform overview, people (customers, farmers, delivery partners), farmer
 * verification, orders and transactions. Every change is written to the audit trail.
 */
import { Types, type FilterQuery } from 'mongoose';
import { AdminAction, type AdminActionType } from '../models/AdminAction';
import { Address } from '../models/Address';
import { Delivery } from '../models/Delivery';
import { DeliveryPartner } from '../models/DeliveryPartner';
import { Farm } from '../models/Farm';
import { Farmer } from '../models/Farmer';
import { Inventory } from '../models/Inventory';
import { Order, type IOrder } from '../models/Order';
import { Payment } from '../models/Payment';
import { User, type UserRole } from '../models/User';
import { invalidateRecommendations } from '../config/cache';
import { ApiError } from '../utils/ApiError';
import { logger } from '../utils/logger';
import { escapeRegex, pageMeta, skipFor } from '../utils/pagination';
import { forCustomer, transitionGroup } from './order/order.service';
import { setUserStatus } from './user.service';

const DAY = 86_400_000;
const oid = (id: string) => new Types.ObjectId(id);

async function audit(adminId: string, action: AdminActionType, target: { type: 'user' | 'farmer' | 'order'; id: Types.ObjectId | string; label: string }, note?: string, details?: Record<string, unknown>) {
  await AdminAction.create({ admin: adminId, action, targetType: target.type, targetId: target.id, targetLabel: target.label, note, details });
  logger.info(`Admin ${adminId}: ${action} ${target.label}${note ? ` — ${note}` : ''}`);
}

/** Refund still owed on an order: what became due minus what was recorded as paid back. */
export const refundOutstanding = (o: Pick<IOrder, 'refundDue' | 'refundsSettled'>) =>
  Math.max(0, Math.round(((o.refundDue ?? 0) - (o.refundsSettled ?? []).reduce((s, r) => s + r.amount, 0)) * 100) / 100);

// ─── Overview ───────────────────────────────────────────────────────────────

export async function overview() {
  const now = Date.now();
  const today = new Date(now - (now % DAY) - 330 * 60_000); // ~start of the Indian day
  const week = new Date(now - 7 * DAY);
  const month = new Date(now - 30 * DAY);

  const [roles, suspended, profilePending, organicPending, ordersToday, ordersWeek, groupStatus, gmv, cod, refunds, jobs, partnersOnline, recent] = await Promise.all([
    User.aggregate<{ _id: UserRole; n: number }>([{ $group: { _id: '$role', n: { $sum: 1 } } }]),
    User.countDocuments({ status: 'suspended' }),
    Farmer.countDocuments({ profileStatus: 'pending' }),
    Farmer.countDocuments({ 'organicCertification.status': 'pending' }),
    Order.countDocuments({ createdAt: { $gte: today } }),
    Order.countDocuments({ createdAt: { $gte: week } }),
    Order.aggregate<{ _id: string; n: number }>([{ $unwind: '$groups' }, { $group: { _id: '$groups.status', n: { $sum: 1 } } }]),
    // Value of produce delivered in the last 30 days.
    Order.aggregate<{ _id: null; total: number; orders: number }>([
      { $match: { createdAt: { $gte: month } } },
      { $unwind: '$groups' },
      { $match: { 'groups.status': 'delivered' } },
      { $group: { _id: null, total: { $sum: '$groups.total' }, orders: { $addToSet: '$_id' } } },
      { $project: { total: 1, orders: { $size: '$orders' } } },
    ]),
    // Cash still to be collected on open COD groups.
    Order.aggregate<{ _id: null; total: number }>([
      { $match: { paymentMethod: 'cod' } },
      { $unwind: '$groups' },
      { $match: { 'groups.status': { $in: ['pending', 'accepted', 'packed', 'out_for_delivery'] } } },
      { $group: { _id: null, total: { $sum: '$groups.total' } } },
    ]),
    Order.find({ refundDue: { $gt: 0 } }, 'refundDue refundsSettled').lean(),
    Delivery.aggregate<{ _id: string; n: number }>([{ $match: { mode: 'partner' } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    DeliveryPartner.countDocuments({ isOnline: true }),
    Order.find({}, 'orderNumber grandTotal status paymentMethod paymentStatus createdAt address.name').sort({ createdAt: -1 }).limit(8).lean(),
  ]);
  const count = <T extends { _id: string; n: number }>(rows: T[], key: string) => rows.find((r) => r._id === key)?.n ?? 0;
  const refundRows = refunds.map(refundOutstanding).filter((x) => x > 0);

  return {
    users: {
      customers: count(roles, 'customer'),
      farmers: count(roles, 'farmer'),
      partners: count(roles, 'delivery'),
      admins: count(roles, 'admin'),
      suspended,
    },
    verification: { profilesPending: profilePending, organicPending },
    orders: {
      today: ordersToday,
      last7Days: ordersWeek,
      groups: Object.fromEntries(groupStatus.map((g) => [g._id, g.n])),
    },
    money: {
      deliveredLast30Days: gmv[0]?.total ?? 0,
      ordersDeliveredLast30Days: gmv[0]?.orders ?? 0,
      codToCollect: cod[0]?.total ?? 0,
      refundsOutstanding: Math.round(refundRows.reduce((a, b) => a + b, 0) * 100) / 100,
      refundsOutstandingOrders: refundRows.length,
    },
    deliveries: { open: count(jobs, 'requested'), assigned: count(jobs, 'assigned'), onTheWay: count(jobs, 'out_for_delivery'), partnersOnline },
    recentOrders: recent.map((o) => ({ id: String(o._id), orderNumber: o.orderNumber, customer: o.address.name, total: o.grandTotal, status: o.status, paymentMethod: o.paymentMethod, paymentStatus: o.paymentStatus, createdAt: o.createdAt })),
  };
}

// ─── People ─────────────────────────────────────────────────────────────────

export interface UserQuery {
  role?: UserRole;
  status?: 'active' | 'suspended';
  q?: string;
  page: number;
  limit: number;
}

export async function listUsers(q: UserQuery) {
  const filter: FilterQuery<unknown> = {};
  if (q.role) filter.role = q.role;
  if (q.status) filter.status = q.status;
  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q.trim()), 'i');
    const digits = q.q.replace(/\D/g, '');
    filter.$or = [{ name: rx }, { email: rx }, ...(digits.length >= 3 ? [{ phone: new RegExp(escapeRegex(digits.slice(-10))) }] : [])];
  }
  const [users, total] = await Promise.all([
    User.find(filter, 'name email phone role status createdAt lastLoginAt').sort({ createdAt: -1 }).skip(skipFor(q.page, q.limit)).limit(q.limit).lean(),
    User.countDocuments(filter),
  ]);
  // Farmers' verification state, for the list.
  const farmers = await Farmer.find({ user: { $in: users.filter((u) => u.role === 'farmer').map((u) => u._id) } }, 'user profileStatus organicCertification.status').lean();
  const fByUser = new Map(farmers.map((f) => [String(f.user), f]));
  return {
    items: users.map((u) => {
      const f = fByUser.get(String(u._id));
      return {
        id: String(u._id), name: u.name, email: u.email, phone: u.phone, role: u.role, status: u.status, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt,
        farmer: f ? { id: String(f._id), profileStatus: f.profileStatus, organicStatus: f.organicCertification?.status } : undefined,
      };
    }),
    meta: pageMeta(q.page, q.limit, total),
  };
}

export async function userDetail(id: string) {
  const user = await User.findById(id, 'name email phone role status createdAt lastLoginAt').lean();
  if (!user) throw ApiError.notFound('User not found');
  const base = { id: String(user._id), name: user.name, email: user.email, phone: user.phone, role: user.role, status: user.status, createdAt: user.createdAt, lastLoginAt: user.lastLoginAt };
  const history = await AdminAction.find({ targetId: { $in: [user._id] } }).sort({ createdAt: -1 }).limit(20).populate<{ admin: { name: string } }>('admin', 'name').lean();
  const actions = history.map((a) => ({ id: String(a._id), action: a.action, note: a.note, by: a.admin?.name, at: a.createdAt }));

  if (user.role === 'customer') {
    const [orders, addresses, stats] = await Promise.all([
      Order.find({ customer: user._id }, 'orderNumber grandTotal status paymentStatus createdAt').sort({ createdAt: -1 }).limit(10).lean(),
      Address.find({ user: user._id }, 'label line1 landmark city pincode').lean(),
      Order.aggregate<{ _id: null; orders: number; spent: number }>([
        { $match: { customer: user._id, status: { $ne: 'cancelled' } } },
        { $group: { _id: null, orders: { $sum: 1 }, spent: { $sum: '$grandTotal' } } },
      ]),
    ]);
    return { ...base, actions, customer: { orders: orders.map((o) => ({ id: String(o._id), ...o, _id: undefined })), addresses, totals: { orders: stats[0]?.orders ?? 0, spent: stats[0]?.spent ?? 0 } } };
  }
  if (user.role === 'farmer') {
    const farmer = await Farmer.findOne({ user: user._id }).lean();
    if (!farmer) return { ...base, actions };
    const [farms, listings, sales] = await Promise.all([
      Farm.find({ farmer: farmer._id }, 'name address location deliveryRadiusKm isActive deliveryAvailable').lean(),
      Inventory.countDocuments({ farmer: farmer._id, isActive: true }),
      Order.aggregate<{ _id: string; n: number; total: number }>([
        { $unwind: '$groups' },
        { $match: { 'groups.farmer': farmer._id } },
        { $group: { _id: '$groups.status', n: { $sum: 1 }, total: { $sum: '$groups.total' } } },
      ]),
    ]);
    return {
      ...base,
      actions: [...actions, ...(await farmerActions(farmer._id))].sort((a, b) => +new Date(b.at) - +new Date(a.at)),
      farmer: {
        id: String(farmer._id), bio: farmer.bio, experienceYears: farmer.experienceYears, practices: farmer.practices,
        profileStatus: farmer.profileStatus, profileReviewNote: farmer.profileReviewNote,
        organicCertification: farmer.organicCertification, ratingAvg: farmer.ratingAvg, ratingCount: farmer.ratingCount,
        farms: farms.map((f) => ({ id: String(f._id), name: f.name, village: f.address?.village, district: f.address?.district, deliveryRadiusKm: f.deliveryRadiusKm, isActive: f.isActive, deliveryAvailable: f.deliveryAvailable, location: { lng: f.location.coordinates[0], lat: f.location.coordinates[1] } })),
        activeListings: listings,
        sales: Object.fromEntries(sales.map((s) => [s._id, { groups: s.n, total: s.total }])),
      },
    };
  }
  if (user.role === 'delivery') {
    const partner = await DeliveryPartner.findOne({ user: user._id }).lean();
    const jobs = partner
      ? await Delivery.aggregate<{ _id: string; n: number; earned: number }>([{ $match: { partner: partner._id } }, { $group: { _id: '$status', n: { $sum: 1 }, earned: { $sum: '$payout' } } }])
      : [];
    return { ...base, actions, partner: partner && { vehicle: partner.vehicle, base: partner.baseLabel, serviceRadiusKm: partner.serviceRadiusKm, isOnline: partner.isOnline, jobs: Object.fromEntries(jobs.map((j) => [j._id, { count: j.n, payout: j.earned }])) } };
  }
  return { ...base, actions };
}

async function farmerActions(farmerId: Types.ObjectId) {
  const rows = await AdminAction.find({ targetType: 'farmer', targetId: farmerId }).sort({ createdAt: -1 }).limit(20).populate<{ admin: { name: string } }>('admin', 'name').lean();
  return rows.map((a) => ({ id: String(a._id), action: a.action, note: a.note, by: a.admin?.name, at: a.createdAt }));
}

export async function setStatus(adminId: string, userId: string, status: 'active' | 'suspended', reason: string) {
  if (adminId === userId) throw ApiError.badRequest('You cannot change your own account status');
  const user = await User.findById(userId, 'name role status');
  if (!user) throw ApiError.notFound('User not found');
  if (user.role === 'admin') throw ApiError.forbidden('Admin accounts are managed outside the console');
  if (user.status === status) return { id: userId, status };
  await setUserStatus(userId, status);
  // A suspended farmer's produce leaves the marketplace immediately.
  if (user.role === 'farmer') void invalidateRecommendations();
  await audit(adminId, status === 'suspended' ? 'user.suspended' : 'user.reactivated', { type: 'user', id: user._id, label: `${user.name} (${user.role})` }, reason);
  return { id: userId, status };
}

// ─── Farmer verification ────────────────────────────────────────────────────

export async function verificationQueue(kind: 'profile' | 'organic' | 'all', page: number, limit: number) {
  const filter: FilterQuery<unknown> =
    kind === 'profile' ? { profileStatus: 'pending' } : kind === 'organic' ? { 'organicCertification.status': 'pending' } : { $or: [{ profileStatus: 'pending' }, { 'organicCertification.status': 'pending' }] };
  const [rows, total] = await Promise.all([
    Farmer.find(filter).sort({ updatedAt: 1 }).skip(skipFor(page, limit)).limit(limit).populate<{ user: { _id: Types.ObjectId; name: string; phone?: string; email?: string; createdAt: Date } }>('user', 'name phone email createdAt').lean(),
    Farmer.countDocuments(filter),
  ]);
  const farms = await Farm.find({ farmer: { $in: rows.map((r) => r._id) } }, 'farmer name address deliveryRadiusKm').lean();
  const listings = await Inventory.aggregate<{ _id: Types.ObjectId; n: number }>([{ $match: { farmer: { $in: rows.map((r) => r._id) }, isActive: true } }, { $group: { _id: '$farmer', n: { $sum: 1 } } }]);
  return {
    items: rows.map((f) => ({
      id: String(f._id),
      user: { id: String(f.user._id), name: f.user.name, phone: f.user.phone, email: f.user.email, joined: f.user.createdAt },
      bio: f.bio, experienceYears: f.experienceYears, practices: f.practices,
      profileStatus: f.profileStatus, profileReviewNote: f.profileReviewNote,
      organicCertification: f.organicCertification,
      farms: farms.filter((x) => String(x.farmer) === String(f._id)).map((x) => ({ name: x.name, village: x.address?.village, district: x.address?.district, deliveryRadiusKm: x.deliveryRadiusKm })),
      activeListings: listings.find((l) => String(l._id) === String(f._id))?.n ?? 0,
      waitingSince: f.updatedAt,
    })),
    meta: pageMeta(page, limit, total),
  };
}

export async function decideVerification(
  adminId: string,
  farmerId: string,
  input: { profile?: 'verified' | 'rejected'; organic?: 'verified' | 'rejected'; note?: string },
) {
  const farmer = await Farmer.findById(farmerId).populate<{ user: { name: string } }>('user', 'name');
  if (!farmer) throw ApiError.notFound('Farmer not found');
  if (!input.profile && !input.organic) throw ApiError.badRequest('Choose a decision for the profile or the organic certificate');
  if ((input.profile === 'rejected' || input.organic === 'rejected') && !input.note?.trim()) {
    throw ApiError.badRequest('Tell the farmer why it was rejected', [{ field: 'note', message: 'Required when rejecting' }]);
  }
  if (input.organic && farmer.organicCertification.status === 'unsubmitted') {
    throw ApiError.conflict('This farmer has not submitted an organic certificate');
  }
  const now = new Date();
  const label = `${farmer.user?.name ?? 'Farmer'} (farmer)`;
  if (input.profile) {
    farmer.profileStatus = input.profile;
    farmer.profileReviewNote = input.note;
    farmer.profileReviewedAt = now;
    await audit(adminId, `farmer.profile.${input.profile}`, { type: 'farmer', id: farmer._id, label }, input.note);
  }
  if (input.organic) {
    farmer.organicCertification.status = input.organic;
    farmer.organicCertification.reviewNote = input.note;
    farmer.organicCertification.reviewedAt = now;
    await audit(adminId, `farmer.organic.${input.organic}`, { type: 'farmer', id: farmer._id, label }, input.note, { certificateNumber: farmer.organicCertification.certificateNumber, issuer: farmer.organicCertification.issuer });
  }
  await farmer.save();
  // Organic badges, ranking and visibility depend on these decisions.
  void invalidateRecommendations();
  return { id: String(farmer._id), profileStatus: farmer.profileStatus, organicStatus: farmer.organicCertification.status };
}

// ─── Orders & transactions ──────────────────────────────────────────────────

export interface OrderQuery {
  status?: string;
  paymentStatus?: string;
  paymentMethod?: 'cod' | 'online';
  refunds?: boolean;
  q?: string;
  from?: Date;
  to?: Date;
  page: number;
  limit: number;
}

export async function listOrders(q: OrderQuery) {
  const filter: FilterQuery<IOrder> = {};
  if (q.status) filter.status = q.status;
  if (q.paymentStatus) filter.paymentStatus = q.paymentStatus;
  if (q.paymentMethod) filter.paymentMethod = q.paymentMethod;
  if (q.refunds) filter.refundDue = { $gt: 0 };
  if (q.from || q.to) filter.createdAt = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  if (q.q) {
    const s = q.q.trim();
    const digits = s.replace(/\D/g, '');
    filter.$or = [
      { orderNumber: new RegExp(escapeRegex(s.toUpperCase())) },
      { 'address.name': new RegExp(escapeRegex(s), 'i') },
      ...(digits.length >= 4 ? [{ 'address.phone': new RegExp(escapeRegex(digits.slice(-10))) }] : []),
    ];
  }
  const [rows, total] = await Promise.all([
    Order.find(filter, 'orderNumber customer address.name address.phone address.city groups.farmName groups.status groups.total groups.deliveryMode grandTotal status paymentMethod paymentStatus refundDue refundsSettled createdAt')
      .sort({ createdAt: -1 })
      .skip(skipFor(q.page, q.limit))
      .limit(q.limit)
      .lean(),
    Order.countDocuments(filter),
  ]);
  return {
    items: rows.map((o) => ({
      id: String(o._id), orderNumber: o.orderNumber, customer: { id: String(o.customer), name: o.address.name, phone: o.address.phone, city: o.address.city },
      farms: o.groups.map((g) => ({ name: g.farmName, status: g.status, total: g.total, deliveryMode: g.deliveryMode })),
      total: o.grandTotal, status: o.status, paymentMethod: o.paymentMethod, paymentStatus: o.paymentStatus,
      refundOutstanding: refundOutstanding(o), createdAt: o.createdAt,
    })),
    meta: pageMeta(q.page, q.limit, total),
  };
}

export async function orderDetail(id: string) {
  const order = await Order.findById(id);
  if (!order) throw ApiError.notFound('Order not found');
  const [customer, payments, deliveries, actions] = await Promise.all([
    User.findById(order.customer, 'name phone email status').lean(),
    Payment.find({ order: order._id }).sort({ createdAt: 1 }).lean(),
    Delivery.find({ order: order._id }).populate<{ partner: { user: { name: string; phone?: string } } | null }>({ path: 'partner', select: 'user vehicle', populate: { path: 'user', select: 'name phone' } }).lean(),
    AdminAction.find({ targetType: 'order', targetId: order._id }).sort({ createdAt: -1 }).populate<{ admin: { name: string } }>('admin', 'name').lean(),
  ]);
  return {
    // Admins see everything the customer sees, including delivery codes (for support calls).
    order: forCustomer(order),
    refundOutstanding: refundOutstanding(order),
    refundsSettled: order.refundsSettled ?? [],
    customer: customer && { id: String(customer._id), name: customer.name, phone: customer.phone, email: customer.email, status: customer.status },
    payments: payments.map((p) => ({ id: String(p._id), provider: p.provider, amount: p.amount, status: p.status, providerPaymentId: p.providerPaymentId, paidAt: p.paidAt, createdAt: p.createdAt })),
    deliveries: deliveries.map((d) => ({ group: String(d.group), mode: d.mode, status: d.status, partner: d.partner?.user?.name, partnerPhone: d.partner?.user?.phone, payout: d.payout, codAmount: d.codAmount, deliveredAt: d.deliveredAt })),
    actions: actions.map((a) => ({ id: String(a._id), action: a.action, note: a.note, by: a.admin?.name, at: a.createdAt, details: a.details })),
  };
}

export async function cancelGroup(adminId: string, orderId: string, groupId: string, note: string) {
  const order = await transitionGroup(orderId, groupId, 'cancelled', { actor: 'admin', note: `Cancelled by Khet Se support: ${note}` });
  const g = order.groups.id(groupId)!;
  await audit(adminId, 'order.group.cancelled', { type: 'order', id: order._id, label: `Order ${order.orderNumber}` }, note, { farm: g.farmName, total: g.total });
  return orderDetail(orderId);
}

export async function recordRefund(adminId: string, orderId: string, input: { amount: number; reference?: string; note?: string }) {
  const order = await Order.findById(orderId);
  if (!order) throw ApiError.notFound('Order not found');
  const outstanding = refundOutstanding(order);
  if (outstanding <= 0) throw ApiError.conflict('Nothing is owed on this order');
  if (input.amount > outstanding + 0.001) throw ApiError.badRequest(`Only ₹${outstanding} is owed on this order`, [{ field: 'amount', message: `At most ₹${outstanding}` }]);
  const entry = { amount: input.amount, reference: input.reference, note: input.note, at: new Date(), by: oid(adminId) };
  // Atomic append: two admins recording the same refund can't both push past what is owed.
  const updated = await Order.findOneAndUpdate({ _id: order._id, __v: order.__v }, { $push: { refundsSettled: entry }, $inc: { __v: 1 } }, { new: true });
  if (!updated) throw ApiError.conflict('This order changed while you were recording the refund. Reload and try again.');
  await audit(adminId, 'order.refund.recorded', { type: 'order', id: order._id, label: `Order ${order.orderNumber}` }, input.note, { amount: input.amount, reference: input.reference });
  return orderDetail(orderId);
}

export async function listPayments(q: { provider?: 'cod' | 'razorpay'; status?: string; page: number; limit: number }) {
  const filter: FilterQuery<unknown> = {};
  if (q.provider) filter.provider = q.provider;
  if (q.status) filter.status = q.status;
  const [rows, total, sums] = await Promise.all([
    Payment.find(filter).sort({ createdAt: -1 }).skip(skipFor(q.page, q.limit)).limit(q.limit).populate<{ order: { orderNumber: string; address: { name: string } } | null }>('order', 'orderNumber address.name').lean(),
    Payment.countDocuments(filter),
    Payment.aggregate<{ _id: { provider: string; status: string }; total: number; n: number }>([{ $group: { _id: { provider: '$provider', status: '$status' }, total: { $sum: '$amount' }, n: { $sum: 1 } } }]),
  ]);
  return {
    items: rows.map((p) => ({ id: String(p._id), orderId: String((p.order as unknown as { _id: Types.ObjectId } | null)?._id ?? ''), orderNumber: p.order?.orderNumber, customer: p.order?.address?.name, provider: p.provider, amount: p.amount, status: p.status, providerPaymentId: p.providerPaymentId, paidAt: p.paidAt, createdAt: p.createdAt })),
    totals: sums.map((s) => ({ provider: s._id.provider, status: s._id.status, amount: s.total, count: s.n })),
    meta: pageMeta(q.page, q.limit, total),
  };
}

export async function auditTrail(page: number, limit: number) {
  const [rows, total] = await Promise.all([
    AdminAction.find().sort({ createdAt: -1 }).skip(skipFor(page, limit)).limit(limit).populate<{ admin: { name: string } }>('admin', 'name').lean(),
    AdminAction.countDocuments(),
  ]);
  return { items: rows.map((a) => ({ id: String(a._id), action: a.action, target: a.targetLabel, targetType: a.targetType, targetId: String(a.targetId), note: a.note, details: a.details, by: a.admin?.name, at: a.createdAt })), meta: pageMeta(page, limit, total) };
}
