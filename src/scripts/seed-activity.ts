/**
 * Demo marketplace activity: fictional customers around Raipur and a few weeks of orders,
 * so the shop, order history and farmer dashboards look like a live app.
 *
 *   npm run seed:activity            # refresh demo farms, then recreate demo customers + orders
 *   npm run seed:activity -- --reset # remove demo customers and their orders only
 *
 * Every order goes through the real order service (quote → place → farmer transitions), so
 * stock, reservations, payments and delivery records stay consistent. Timestamps are then
 * shifted into the past for completed orders. All COD (Razorpay is optional in dev).
 *
 * About half the orders are carried by demo delivery partners (open jobs on the board,
 * assigned, on the way, and delivered history), the rest by the farmers themselves.
 *
 * Accounts use @demo.khetse.test and DEMO_PASSWORD, like seed:demo. Dev only.
 */
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { Types } from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../config/db';
import { env } from '../config/env';
import { User } from '../models/User';
import { Address } from '../models/Address';
import { Inventory } from '../models/Inventory';
import { Order } from '../models/Order';
import { Payment } from '../models/Payment';
import { Delivery } from '../models/Delivery';
import { Session } from '../models/Session';
import { DeliveryPartner } from '../models/DeliveryPartner';
import { Farmer } from '../models/Farmer';
import { acceptJob, deliver, ensurePartnerForUser, pickUp, requestPartner } from '../services/delivery.service';
import { toPoint } from '../models/common';
import { placeOrder, quote, transitionGroup } from '../services/order/order.service';
import { findReservationDrift, fixReservationDrift } from '../services/order/reservation-audit.service';
import type { GroupStatus } from '../models/Order';
import { logger } from '../utils/logger';

const DOMAIN = 'demo.khetse.test';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Real Raipur localities, fictional people.
const CUSTOMERS = [
  { key: 'priya', name: 'Priya Agrawal', phone: '9000000201', area: 'Shankar Nagar', line1: '14, Lane 3, Shankar Nagar', pincode: '492007', lng: 81.6611, lat: 21.2493 },
  { key: 'rahul', name: 'Rahul Verma', phone: '9000000202', area: 'Telibandha', line1: 'B-22, Marine Drive Road, Telibandha', pincode: '492006', lng: 81.667, lat: 21.2378 },
  { key: 'neha', name: 'Neha Tiwari', phone: '9000000203', area: 'Pandri', line1: '7, Cloth Market Road, Pandri', pincode: '492004', lng: 81.6448, lat: 21.2563 },
  { key: 'amit', name: 'Amit Choudhary', phone: '9000000204', area: 'Devendra Nagar', line1: '31, Sector 2, Devendra Nagar', pincode: '492004', lng: 81.656, lat: 21.2585 },
  { key: 'sunita', name: 'Sunita Patel', phone: '9000000205', area: 'Civil Lines', line1: '5, Civil Lines', pincode: '492001', lng: 81.6447, lat: 21.2462 },
  { key: 'vikas', name: 'Vikas Dewangan', phone: '9000000206', area: 'Tatibandh', line1: '112, Ring Road 2, Tatibandh', pincode: '492099', lng: 81.587, lat: 21.256 },
  // Bhilai–Durg
  { key: 'arjun', name: 'Arjun Mishra', phone: '9000000207', area: 'Sector 6, Bhilai', line1: 'Qr 14B, Street 21, Sector 6', pincode: '490006', lng: 81.3509, lat: 21.2092 },
  { key: 'pooja', name: 'Pooja Sinha', phone: '9000000208', area: 'Padmanabhpur, Durg', line1: '22, Padmanabhpur Colony', pincode: '491001', lng: 81.2960, lat: 21.1960 },
  { key: 'karan', name: 'Karan Joshi', phone: '9000000209', area: 'Kutelabhata, near IIT Bhilai', line1: 'House 7, Kutelabhata', pincode: '490020', lng: 81.3183, lat: 21.2446 },
];

// Delivery partners based around the city.
const PARTNERS = [
  { key: 'ravi', name: 'Ravi Yadav', phone: '9000000301', vehicle: 'bike', label: 'Pandri, Raipur', lng: 81.6448, lat: 21.2563 },
  { key: 'salim', name: 'Salim Khan', phone: '9000000302', vehicle: 'scooter', label: 'Telibandha, Raipur', lng: 81.667, lat: 21.2378 },
  { key: 'deepak', name: 'Deepak Sahu', phone: '9000000303', vehicle: 'bike', label: 'Tatibandh, Raipur', lng: 81.587, lat: 21.256 },
  { key: 'kavita', name: 'Kavita Nishad', phone: '9000000304', vehicle: 'scooter', label: 'Mowa, Raipur', lng: 81.6563, lat: 21.2766 },
  { key: 'imran', name: 'Imran Qureshi', phone: '9000000305', vehicle: 'bike', label: 'Supela, Bhilai', lng: 81.3600, lat: 21.2100 },
] as const;

/**
 * Where each order ends up. Past orders are spread over the last few weeks. `partner` routes
 * the delivery through a delivery partner; with end "accepted" that leaves an open job.
 */
type Plan = { end: GroupStatus; daysAgo: number; note?: string; byCustomer?: boolean; partner?: boolean };
const PLANS: Plan[] = [
  { end: 'delivered', daysAgo: 26 },
  { end: 'delivered', daysAgo: 21, partner: true },
  { end: 'rejected', daysAgo: 18, note: 'Unseasonal rain damaged this harvest, sorry!' },
  { end: 'delivered', daysAgo: 14, partner: true },
  { end: 'cancelled', daysAgo: 11, note: 'Ordered twice by mistake', byCustomer: true },
  { end: 'delivered', daysAgo: 7 },
  { end: 'delivered', daysAgo: 3, partner: true },
  { end: 'out_for_delivery', daysAgo: 0.2, partner: true },
  { end: 'packed', daysAgo: 0.5, partner: true },
  { end: 'accepted', daysAgo: 0.8, partner: true },
  { end: 'delivered', daysAgo: 0.1, partner: true },
  { end: 'pending', daysAgo: 0.05 },
];
const PATH: Partial<Record<GroupStatus, GroupStatus[]>> = {
  accepted: ['accepted'],
  packed: ['accepted', 'packed'],
  out_for_delivery: ['accepted', 'packed', 'out_for_delivery'],
  delivered: ['accepted', 'packed', 'out_for_delivery', 'delivered'],
  rejected: ['rejected'],
};

// Small deterministic PRNG so every run produces the same-looking shop.
let seed = 42;
const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
const pick = <T>(xs: T[], n: number) => [...xs].sort(() => rand() - 0.5).slice(0, n);

async function demoCustomerIds() {
  const users = await User.find({ email: new RegExp(`@${DOMAIN.replace(/\./g, '\\.')}$`), role: { $in: ['customer', 'delivery', 'admin'] } }, '_id');
  return users.map((u) => u._id);
}

async function reset() {
  const ids = await demoCustomerIds();
  const orders = await Order.find({ customer: { $in: ids } }, '_id');
  const orderIds = orders.map((o) => o._id);
  await Promise.all([
    Payment.deleteMany({ order: { $in: orderIds } }),
    Delivery.deleteMany({ order: { $in: orderIds } }),
    Address.deleteMany({ user: { $in: ids } }),
    Session.deleteMany({ user: { $in: ids } }),
    DeliveryPartner.deleteMany({ user: { $in: ids } }),
  ]);
  await Order.deleteMany({ _id: { $in: orderIds } });
  await User.deleteMany({ _id: { $in: ids } });
  // Open orders just deleted were holding stock: put it back.
  const fixed = await fixReservationDrift();
  logger.info(`Demo activity removed: ${ids.length} customers, ${orderIds.length} orders (released stock on ${fixed.fixed} listings)`);
}

/** Moves an order (and its payment/delivery records) back in time by `ms`. */
async function backdate(orderId: Types.ObjectId, ms: number) {
  const o = await Order.findById(orderId).lean();
  if (!o) return;
  const shift = (d?: Date | null) => (d ? new Date(new Date(d).getTime() - ms) : d);
  const start = new Date(o.createdAt).getTime() - ms;
  const groups = o.groups.map((g) => {
    // Space the steps out (up to 5 h apart) without running past "now".
    const gap = Math.min(5 * HOUR, ms / (g.history.length + 1));
    return {
      ...g,
      acceptBy: shift(g.acceptBy),
      scheduledFor: shift(g.scheduledFor),
      history: g.history.map((h: (typeof g.history)[number], i: number) => ({ ...h, at: new Date(start + i * gap) })),
    };
  });
  // The order number carries the placement date (KSyymmdd-XXXXX); keep it in step.
  const d = new Date(start);
  const ymd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const orderNumber = o.orderNumber.replace(/^KS\d{6}/, `KS${ymd}`);
  const lastAt = groups.flatMap((g) => g.history.map((h: { at: Date }) => h.at.getTime())).reduce((a, b) => Math.max(a, b), start);
  await Order.collection.updateOne({ _id: orderId }, { $set: { groups, orderNumber, createdAt: new Date(start), updatedAt: new Date(lastAt) } });
  const at = shift(o.createdAt);
  await Payment.collection.updateMany({ order: orderId }, { $set: { createdAt: at, updatedAt: at } });
  const deliveries = await Delivery.find({ order: orderId }).lean();
  for (const d of deliveries) {
    await Delivery.collection.updateOne(
      { _id: d._id },
      {
        $set: {
          createdAt: shift(d.createdAt),
          scheduledFor: shift(d.scheduledFor),
          requestedAt: shift(d.requestedAt),
          assignedAt: shift(d.assignedAt),
          outAt: shift(d.outAt),
          deliveredAt: shift(d.deliveredAt),
        },
      },
    );
  }
}

async function seedActivity() {
  const listings = await Inventory.find({ isActive: true, quantityAvailable: { $gte: 5 } }, '_id minOrderQty').lean();
  if (listings.length < 5) throw new Error('No demo listings found — run `npm run seed:demo` first');

  const password = process.env.DEMO_PASSWORD || crypto.randomBytes(24).toString('hex');
  const passwordHash = await bcrypt.hash(password, 10);
  let placed = 0;
  const tally: Record<string, number> = {};

  // Demo admin for the admin console (/admin): mobile 9000000001.
  await User.findOneAndUpdate(
    { email: `admin@${DOMAIN}` },
    { $set: { name: 'Khet Se Admin', phone: '9000000001', role: 'admin', status: 'active', passwordHash } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  const partnerUsers: string[] = [];
  for (const p of PARTNERS) {
    const user = await User.findOneAndUpdate(
      { email: `${p.key}@${DOMAIN}` },
      { $set: { name: p.name, phone: p.phone, role: 'delivery', status: 'active', passwordHash } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    await ensurePartnerForUser(user._id);
    await DeliveryPartner.updateOne(
      { user: user._id },
      { $set: { vehicle: p.vehicle, baseLocation: toPoint(p.lng, p.lat), baseLabel: p.label, serviceRadiusKm: 25, isOnline: true, maxActiveJobs: 5 } },
    );
    partnerUsers.push(String(user._id));
  }
  let nextPartner = 0;
  const farmerUser = new Map<string, string>();
  const farmerUserOf = async (farmerId: unknown) => {
    const key = String(farmerId);
    if (!farmerUser.has(key)) farmerUser.set(key, String((await Farmer.findById(key, 'user'))!.user));
    return farmerUser.get(key)!;
  };
  /** Gives the job to the next partner with room, round-robin. */
  const assign = async (jobId: string) => {
    let last: Error | undefined;
    for (let tries = 0; tries < partnerUsers.length; tries++) {
      const partner = partnerUsers[nextPartner++ % partnerUsers.length]!;
      try {
        await acceptJob(partner, jobId);
        return partner;
      } catch (err) {
        last = err as Error; // full: try the next partner
      }
    }
    throw new Error(`No demo partner could take the job: ${last?.message}`);
  };

  for (const [ci, c] of CUSTOMERS.entries()) {
    const user = await User.findOneAndUpdate(
      { email: `${c.key}@${DOMAIN}` },
      { $set: { name: c.name, phone: c.phone, role: 'customer', status: 'active', passwordHash } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    const address = await Address.create({
      user: user._id,
      label: 'home',
      name: c.name,
      phone: c.phone,
      line1: c.line1,
      landmark: c.area,
      city: 'Raipur',
      pincode: c.pincode,
      location: toPoint(c.lng, c.lat),
      isDefault: true,
    });
    const at = { lng: c.lng, lat: c.lat };

    // Rotate through the plans so each customer has history plus something in progress.
    const plans = PLANS.filter((_, i) => (i + ci) % 2 === 0 || i >= 7).slice(0, 8);
    for (const plan of plans) {
      // Pick 1–4 listings this address can be delivered to, quantity 1–2 each.
      const candidates = pick(listings, 8).map((l) => ({ listing: String(l._id), quantity: Math.max(l.minOrderQty ?? 1, 1 + Math.floor(rand() * 2)) }));
      const check = await quote(candidates, at);
      const bad = new Set(check.issues.map((i) => i.listing));
      const items = candidates.filter((l) => !bad.has(l.listing)).slice(0, 1 + Math.floor(rand() * 4));
      if (!items.length) continue;
      const q = await quote(items, at);
      if (q.issues.length) continue;

      const { order } = await placeOrder(String(user._id), crypto.randomUUID(), {
        items,
        addressId: String(address._id),
        paymentMethod: 'cod',
        expectedTotal: q.grandTotal,
      });

      for (const [gi, g] of order.groups.entries()) {
        const gid = String(g._id);
        if (plan.end === 'cancelled') {
          await transitionGroup(String(order._id), gid, 'cancelled', { actor: 'customer', customerId: String(user._id), note: plan.note });
          continue;
        }
        // In multi-farm orders only the first farm uses a partner; the others deliver themselves.
        if (plan.partner && gi === 0 && PATH[plan.end]?.includes('accepted')) {
          // Farmer accepts (and packs), then hands the delivery to a partner.
          await transitionGroup(String(order._id), gid, 'accepted', { actor: 'farmer', deliveryDate: new Date(Date.now() + (plan.end === 'accepted' ? DAY : 0)) });
          if (plan.end !== 'accepted') await transitionGroup(String(order._id), gid, 'packed', { actor: 'farmer' });
          await requestPartner(await farmerUserOf(g.farmer), String(order._id), gid);
          if (plan.end === 'accepted') continue; // left open on the job board
          const job = (await Delivery.findOne({ order: order._id, group: g._id }))!;
          const partner = await assign(String(job._id));
          if (plan.end === 'packed') continue; // assigned, waiting for pickup
          await pickUp(partner, String(job._id));
          if (plan.end === 'delivered') await deliver(partner, String(job._id), g.handoverCode);
          continue;
        }
        for (const step of PATH[plan.end] ?? []) {
          await transitionGroup(String(order._id), gid, step, {
            actor: 'farmer',
            note: step === 'rejected' ? plan.note : undefined,
            code: step === 'delivered' ? g.handoverCode : undefined,
            deliveryDate: step === 'accepted' ? new Date(Date.now() + (plan.end === 'accepted' ? DAY : 0)) : undefined,
          });
        }
      }
      await backdate(order._id, plan.daysAgo * DAY); // today's orders move back just a few hours
      placed++;
      const key = `${plan.end}${plan.partner ? ' (partner)' : ''}`;
      tally[key] = (tally[key] ?? 0) + 1;
    }
  }

  const drift = await findReservationDrift();
  logger.info(`Demo activity ready: ${CUSTOMERS.length} customers, ${placed} orders ${JSON.stringify(tally)}`);
  logger.info(drift.length ? `⚠ Reserved stock drift on ${drift.length} listings` : 'Reserved stock matches open orders');
  if (process.env.DEMO_PASSWORD) {
    logger.info(`Demo customers log in as <name>@${DOMAIN} (${CUSTOMERS.map((c) => c.key).join(', ')}) with DEMO_PASSWORD`);
    logger.info(`Demo delivery partners: ${PARTNERS.map((p) => `${p.key}@${DOMAIN}`).join(', ')}`);
    logger.info(`Demo admin: mobile 9000000001 (admin@${DOMAIN}), console at /admin`);
  }
}

async function main() {
  if (env.NODE_ENV === 'production') throw new Error('seed:activity is for development only');
  await connectDatabase();
  await reset();
  if (!process.argv.includes('--reset')) await seedActivity();
}

main()
  .catch((err) => {
    logger.error('Activity seed failed', err);
    process.exitCode = 1;
  })
  .finally(disconnectDatabase);
