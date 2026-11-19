/**
 * In-process background jobs. Each job is safe to run on several API instances at once
 * (every state change it makes is an atomic conditional update), so no distributed lock
 * is needed. Move to a queue (BullMQ on Redis) when jobs grow beyond simple sweeps.
 */
import { expireUnacceptedGroups, expireUnpaidOrders } from '../services/order/order.service';
import { reconcilePendingPayments } from '../services/payments/payment.service';
import { findReservationDrift } from '../services/order/reservation-audit.service';
import { logger } from '../utils/logger';

interface Job {
  name: string;
  everyMs: number;
  run: () => Promise<unknown>;
}

const JOBS: Job[] = [
  {
    name: 'expire-unpaid-orders',
    everyMs: 60_000,
    run: async () => {
      const r = await expireUnpaidOrders();
      if (r.groupsCancelled) logger.info(`Released stock for ${r.groupsCancelled} unpaid order group(s)`);
      if (r.recovered) logger.warn(`Recovered ${r.recovered} paid order(s) whose payment never reported back`);
    },
  },
  {
    name: 'expire-unaccepted-orders',
    everyMs: 5 * 60_000,
    run: async () => {
      const r = await expireUnacceptedGroups();
      if (r.groupsCancelled) logger.info(`Cancelled ${r.groupsCancelled} order group(s) farmers did not confirm in time`);
    },
  },
  {
    // Report-only: repairs are a deliberate operator action (npm run reservations:check -- --fix).
    name: 'check-reserved-stock',
    everyMs: 60 * 60_000,
    run: async () => {
      const drift = await findReservationDrift();
      if (drift.length) logger.warn(`Reserved stock is out of step with open orders on ${drift.length} listing(s); run reservations:check`, drift.slice(0, 5));
    },
  },
  {
    name: 'reconcile-payments',
    everyMs: 5 * 60_000,
    run: async () => {
      const r = await reconcilePendingPayments();
      if (r.recovered) logger.warn(`Reconciled ${r.recovered} payment(s) that never reported back`);
    },
  },
];

const timers: NodeJS.Timeout[] = [];

export function startJobs() {
  for (const job of JOBS) {
    let running = false;
    const tick = async () => {
      if (running) return; // never overlap a slow run with the next tick
      running = true;
      try {
        await job.run();
      } catch (err) {
        logger.error(`Job ${job.name} failed`, err);
      } finally {
        running = false;
      }
    };
    timers.push(setInterval(tick, job.everyMs).unref());
  }
  logger.info(`Background jobs started: ${JOBS.map((j) => j.name).join(', ')}`);
}

export function stopJobs() {
  timers.splice(0).forEach(clearInterval);
}
