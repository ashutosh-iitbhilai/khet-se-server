import { Types, type PipelineStage } from 'mongoose';
import { DELIVERY, partnerPayout } from '../config/delivery';
import { Delivery, type DeliveryDocument, type DeliveryStatus } from '../models/Delivery';
import { DeliveryPartner, type DeliveryPartnerDocument, type Vehicle } from '../models/DeliveryPartner';
import { Farm } from '../models/Farm';
import { Order, type OrderDocument } from '../models/Order';
import { User } from '../models/User';
import { toPoint } from '../models/common';
import { ApiError } from '../utils/ApiError';
import { logger } from '../utils/logger';
import { pageMeta, skipFor } from '../utils/pagination';
import { requireFarmer } from './farmer.service';
import { forFarmer, transitionGroup } from './order/order.service';

// ─── Partner profile ────────────────────────────────────────────────────────

/** Every partner account has a profile; created empty at registration. */
export async function ensurePartnerForUser(userId: string | Types.ObjectId) {
  return DeliveryPartner.findOneAndUpdate({ user: userId }, { $setOnInsert: { user: userId } }, { upsert: true, new: true, setDefaultsOnInsert: true });
}

async function requirePartner(userId: string): Promise<DeliveryPartnerDocument> {
  const partner = await DeliveryPartner.findOne({ user: userId });
  if (!partner) throw ApiError.forbidden('This account is not a delivery partner');
  return partner;
}

function profileView(p: DeliveryPartnerDocument) {
  const [lng, lat] = p.baseLocation?.coordinates ?? [];
  return {
    id: String(p._id),
    vehicle: p.vehicle,
    base: p.baseLocation ? { lng, lat, label: p.baseLabel ?? '' } : null,
    serviceRadiusKm: p.serviceRadiusKm,
    isOnline: p.isOnline,
    maxActiveJobs: p.maxActiveJobs,
    ready: Boolean(p.baseLocation),
  };
}

export async function getProfile(userId: string) {
  return profileView(await requirePartner(userId));
}

export interface ProfileInput {
  vehicle?: Vehicle;
  base?: { lng: number; lat: number; label?: string };
  serviceRadiusKm?: number;
  isOnline?: boolean;
}

export async function updateProfile(userId: string, input: ProfileInput) {
  const partner = await requirePartner(userId);
  if (input.vehicle) partner.vehicle = input.vehicle;
  if (input.base) {
    partner.baseLocation = toPoint(input.base.lng, input.base.lat);
    partner.baseLabel = input.base.label;
  }
  if (input.serviceRadiusKm !== undefined) partner.serviceRadiusKm = Math.min(input.serviceRadiusKm, DELIVERY.maxServiceRadiusKm);
  if (input.isOnline !== undefined) {
    if (input.isOnline && !partner.baseLocation) throw ApiError.badRequest('Set your base location before going online', [{ field: 'base', message: 'Required' }]);
    if (input.isOnline && !(await User.exists({ _id: userId, phone: { $type: 'string' } }))) {
      throw ApiError.badRequest('Add your mobile number in account settings before going online. Farmers and customers need to reach you.', [
        { field: 'phone', message: 'Required' },
      ]);
    }
    partner.isOnline = input.isOnline;
  }
  await partner.save();
  return profileView(partner);
}

/** Start of today in India (orders and earnings are counted per Indian calendar day). */
function startOfIndianDay(now = new Date()) {
  const IST = 330 * 60_000;
  const d = new Date(now.getTime() + IST);
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() - IST);
}

export async function overview(userId: string) {
  const partner = await requirePartner(userId);
  const today = startOfIndianDay();
  const weekAgo = new Date(today.getTime() - 6 * 86_400_000);
  const [active, [todayStats], [weekStats], [cash]] = await Promise.all([
    Delivery.countDocuments({ partner: partner._id, status: { $in: ['assigned', 'out_for_delivery'] } }),
    Delivery.aggregate([
      { $match: { partner: partner._id, status: 'delivered', deliveredAt: { $gte: today } } },
      { $group: { _id: null, jobs: { $sum: 1 }, earned: { $sum: '$payout' }, km: { $sum: '$distanceKm' } } },
    ]),
    Delivery.aggregate([
      { $match: { partner: partner._id, status: 'delivered', deliveredAt: { $gte: weekAgo } } },
      { $group: { _id: null, jobs: { $sum: 1 }, earned: { $sum: '$payout' } } },
    ]),
    // Cash collected on COD deliveries today, to be handed over.
    Delivery.aggregate([
      { $match: { partner: partner._id, status: 'delivered', deliveredAt: { $gte: today }, codAmount: { $gt: 0 } } },
      { $group: { _id: null, amount: { $sum: '$codAmount' } } },
    ]),
  ]);
  const open = partner.baseLocation && partner.isOnline ? (await availableJobs(userId, 1, 1)).meta.total : 0;
  return {
    profile: profileView(partner),
    activeJobs: active,
    availableJobs: open,
    today: { jobs: todayStats?.jobs ?? 0, earned: todayStats?.earned ?? 0, km: Math.round((todayStats?.km ?? 0) * 10) / 10 },
    week: { jobs: weekStats?.jobs ?? 0, earned: weekStats?.earned ?? 0 },
    cashInHand: cash?.amount ?? 0,
  };
}

// ─── Job views ──────────────────────────────────────────────────────────────

type JobDoc = DeliveryDocument | (Record<string, unknown> & { _id: Types.ObjectId });

/** Loads the farms and orders a page of jobs refers to, in two queries. */
async function context(jobs: JobDoc[]) {
  const d = jobs as unknown as { farm: Types.ObjectId; order: Types.ObjectId }[];
  const [farms, orders] = await Promise.all([
    Farm.find({ _id: { $in: d.map((j) => j.farm) } }, 'name address location').lean(),
    Order.find({ _id: { $in: d.map((j) => j.order) } }, 'orderNumber address groups paymentMethod').lean(),
  ]);
  return { farms: new Map(farms.map((f) => [String(f._id), f])), orders: new Map(orders.map((o) => [String(o._id), o])) };
}

function jobView(
  job: JobDoc,
  ctx: Awaited<ReturnType<typeof context>>,
  opts: { full: boolean; pickupDistanceKm?: number; contacts?: boolean },
) {
  // Phone numbers only while the job is in progress; not on the board, not in history.
  const contacts = opts.full && opts.contacts !== false;
  const j = job as unknown as {
    _id: Types.ObjectId; order: Types.ObjectId; group: Types.ObjectId; farm: Types.ObjectId; status: DeliveryStatus;
    distanceKm: number; payout?: number; codAmount?: number; scheduledFor: Date; requestedAt?: Date; assignedAt?: Date;
    outAt?: Date; deliveredAt?: Date; pickupLocation?: { coordinates: [number, number] }; dropLocation?: { coordinates: [number, number] };
  };
  const farm = ctx.farms.get(String(j.farm));
  const order = ctx.orders.get(String(j.order));
  const group = order?.groups.find((g) => String(g._id) === String(j.group));
  const [plng, plat] = j.pickupLocation?.coordinates ?? farm?.location?.coordinates ?? [0, 0];
  const [dlng, dlat] = j.dropLocation?.coordinates ?? order?.address.location.coordinates ?? [0, 0];

  return {
    id: String(j._id),
    status: j.status,
    orderNumber: order?.orderNumber ?? '',
    payout: j.payout ?? 0,
    codAmount: j.codAmount ?? 0,
    tripKm: j.distanceKm,
    pickupDistanceKm: opts.pickupDistanceKm,
    scheduledFor: j.scheduledFor,
    requestedAt: j.requestedAt,
    assignedAt: j.assignedAt,
    pickedUpAt: j.outAt,
    deliveredAt: j.deliveredAt,
    itemCount: group?.items.length ?? 0,
    items: opts.full ? (group?.items ?? []).map((i: { productName: string; quantity: number; unit: string; packSizeGrams?: number }) => ({ name: i.productName, quantity: i.quantity, unit: i.unit, packSizeGrams: i.packSizeGrams })) : undefined,
    pickup: {
      farmName: farm?.name ?? group?.farmName ?? '',
      area: [farm?.address?.village, farm?.address?.district].filter(Boolean).join(', '),
      location: { lng: plng, lat: plat },
      // Contact details and exact addresses only once the job is yours.
      line1: opts.full ? farm?.address?.line1 : undefined,
      farmerName: opts.full ? group?.farmerName : undefined,
      farmerPhone: contacts ? group?.farmerPhone : undefined,
    },
    drop: {
      area: [order?.address.landmark, order?.address.city, order?.address.pincode].filter(Boolean).join(', '),
      location: opts.full ? { lng: dlng, lat: dlat } : undefined,
      name: opts.full ? order?.address.name : undefined,
      phone: contacts ? order?.address.phone : undefined,
      line1: opts.full ? order?.address.line1 : undefined,
    },
  };
}

/** Open jobs whose farm is within the partner's service radius, nearest pickup first. */
export async function availableJobs(userId: string, page: number, limit: number) {
  const partner = await requirePartner(userId);
  if (!partner.baseLocation) return { items: [], meta: pageMeta(page, limit, 0) };

  const pipeline: PipelineStage[] = [
    {
      $geoNear: {
        near: partner.baseLocation,
        key: 'pickupLocation',
        distanceField: 'pickupDistanceM',
        maxDistance: partner.serviceRadiusKm * 1000,
        spherical: true,
        query: { status: 'requested' },
      },
    },
    { $facet: { items: [{ $skip: skipFor(page, limit) }, { $limit: limit }], total: [{ $count: 'n' }] } },
  ];
  const [res] = await Delivery.aggregate<{ items: (JobDoc & { pickupDistanceM: number })[]; total: { n: number }[] }>(pipeline);
  const ctx = await context(res!.items);
  return {
    items: res!.items.map((j) => jobView(j, ctx, { full: false, pickupDistanceKm: Math.round(j.pickupDistanceM / 100) / 10 })),
    meta: pageMeta(page, limit, res!.total[0]?.n ?? 0),
  };
}

const VIEWS: Record<'active' | 'completed', DeliveryStatus[]> = {
  active: ['assigned', 'out_for_delivery'],
  completed: ['delivered', 'cancelled'],
};

export async function myJobs(userId: string, view: 'active' | 'completed', page: number, limit: number) {
  const partner = await requirePartner(userId);
  const filter = { partner: partner._id, status: { $in: VIEWS[view] } };
  const [jobs, total] = await Promise.all([
    Delivery.find(filter)
      .sort(view === 'active' ? { assignedAt: 1 } : { updatedAt: -1 })
      .skip(skipFor(page, limit))
      .limit(limit),
    Delivery.countDocuments(filter),
  ]);
  const ctx = await context(jobs);
  return { items: jobs.map((j) => jobView(j, ctx, { full: true, contacts: view === 'active' })), meta: pageMeta(page, limit, total) };
}

async function jobFor(partner: DeliveryPartnerDocument, jobId: string) {
  const job = await Delivery.findOne({ _id: jobId, partner: partner._id });
  if (!job) throw ApiError.notFound('Delivery not found');
  return job;
}

async function oneJob(job: DeliveryDocument) {
  return jobView(job, await context([job]), { full: true });
}

// ─── Partner actions ────────────────────────────────────────────────────────

/** First partner to accept gets the job; the claim is a single atomic update. */
export async function acceptJob(userId: string, jobId: string) {
  const partner = await requirePartner(userId);
  if (!partner.isOnline) throw ApiError.conflict('Go online to accept deliveries');
  const active = await Delivery.countDocuments({ partner: partner._id, status: { $in: ['assigned', 'out_for_delivery'] } });
  if (active >= partner.maxActiveJobs) {
    throw ApiError.conflict(`You already have ${active} deliveries in progress. Finish one before accepting another.`);
  }

  const job = await Delivery.findOneAndUpdate(
    { _id: jobId, status: 'requested', partner: null },
    { $set: { status: 'assigned', partner: partner._id, assignedAt: new Date() } },
    { new: true },
  );
  if (!job) throw ApiError.conflict('Another partner has already taken this delivery, or it was cancelled');

  const user = await User.findById(userId, 'name phone');
  const courier = { partner: partner._id, name: user?.name ?? 'Delivery partner', phone: user?.phone, vehicle: partner.vehicle };
  const updated = await Order.updateOne(
    { _id: job.order, groups: { $elemMatch: { _id: job.group, status: { $in: ['accepted', 'packed'] } } } },
    { $set: { 'groups.$.courier': courier } },
  );
  if (!updated.modifiedCount) {
    // The farmer cancelled the order between the request and this accept.
    await Delivery.updateOne({ _id: job._id }, { $set: { status: 'cancelled' } });
    throw ApiError.conflict('This order was cancelled by the farmer');
  }
  logger.info(`Delivery ${job._id} accepted by partner ${partner._id}`);
  return oneJob(job);
}

/** Hands an accepted job back to the board, before pickup. */
export async function releaseJob(userId: string, jobId: string) {
  const partner = await requirePartner(userId);
  const job = await Delivery.findOneAndUpdate(
    { _id: jobId, partner: partner._id, status: 'assigned' },
    { $set: { status: 'requested', partner: null }, $unset: { assignedAt: 1 } },
    { new: true },
  );
  if (!job) throw ApiError.conflict('Only deliveries you have not picked up yet can be given back');
  await Order.updateOne({ _id: job.order, 'groups._id': job.group }, { $unset: { 'groups.$.courier': 1 } });
  return { released: true };
}

export async function pickUp(userId: string, jobId: string) {
  const partner = await requirePartner(userId);
  const job = await jobFor(partner, jobId);
  if (job.status !== 'assigned') throw ApiError.conflict('This delivery is not waiting for pickup');
  await transitionGroup(String(job.order), String(job.group), 'out_for_delivery', { actor: 'delivery', partnerId: partner._id });
  return oneJob((await Delivery.findById(job._id))!);
}

export async function deliver(userId: string, jobId: string, code: string) {
  const partner = await requirePartner(userId);
  const job = await jobFor(partner, jobId);
  if (job.status !== 'out_for_delivery') throw ApiError.conflict('Pick up this delivery before marking it delivered');
  await transitionGroup(String(job.order), String(job.group), 'delivered', { actor: 'delivery', partnerId: partner._id, code });
  return oneJob((await Delivery.findById(job._id))!);
}

// ─── Farmer actions ─────────────────────────────────────────────────────────

async function farmerGroup(userId: string, orderId: string, groupId: string) {
  const farmer = await requireFarmer(userId);
  const order = await Order.findById(orderId);
  const group = order?.groups.id(groupId);
  if (!order || !group || String(group.farmer) !== String(farmer._id)) throw ApiError.notFound('Order not found');
  return { farmer, order, group };
}

/** The farmer asks Khet Se for a delivery partner instead of delivering themself. */
export async function requestPartner(userId: string, orderId: string, groupId: string) {
  const { farmer, order, group } = await farmerGroup(userId, orderId, groupId);
  if (!['accepted', 'packed'].includes(group.status)) throw ApiError.conflict('Accept the order before requesting a delivery partner');
  if (group.deliveryMode === 'partner') throw ApiError.conflict('A delivery partner has already been requested');

  const farm = await Farm.findById(group.farm, 'location');
  if (!farm) throw ApiError.notFound('Farm not found');

  const job = await Delivery.findOneAndUpdate(
    { order: order._id, group: group._id, status: 'scheduled' },
    {
      $set: {
        mode: 'partner',
        status: 'requested',
        partner: null,
        requestedAt: new Date(),
        pickupLocation: farm.location,
        dropLocation: order.address.location,
        payout: partnerPayout(group.distanceKm),
        codAmount: order.paymentMethod === 'cod' && !group.paymentCollected ? group.total : 0,
      },
    },
    { new: true },
  );
  if (!job) throw ApiError.conflict('This delivery can no longer be handed to a partner');

  const updated = await Order.findOneAndUpdate(
    { _id: order._id, groups: { $elemMatch: { _id: group._id, status: { $in: ['accepted', 'packed'] } } } },
    { $set: { 'groups.$.deliveryMode': 'partner' } },
    { new: true },
  );
  if (!updated) {
    await Delivery.updateOne({ _id: job._id }, { $set: { status: 'cancelled' } });
    throw ApiError.conflict('This order was cancelled');
  }
  logger.info(`Order ${order.orderNumber}: farmer requested a delivery partner (₹${job.payout} payout)`);
  return forFarmer(updated as OrderDocument, String(farmer._id));
}

/** Withdraws the request while no partner has accepted it; the farmer delivers it again. */
export async function cancelPartnerRequest(userId: string, orderId: string, groupId: string) {
  const { farmer, order, group } = await farmerGroup(userId, orderId, groupId);
  const job = await Delivery.findOneAndUpdate(
    { order: order._id, group: group._id, status: 'requested', partner: null },
    { $set: { mode: 'self', status: 'scheduled' }, $unset: { requestedAt: 1, payout: 1, codAmount: 1 } },
  );
  if (!job) throw ApiError.conflict('A partner has already accepted this delivery. Call them to change plans.');
  const updated = await Order.findOneAndUpdate(
    { _id: order._id, 'groups._id': group._id },
    { $set: { 'groups.$.deliveryMode': 'self' } },
    { new: true },
  );
  return forFarmer(updated as OrderDocument, String(farmer._id));
}
