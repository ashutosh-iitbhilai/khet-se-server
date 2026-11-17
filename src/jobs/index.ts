/**
 * In-process background jobs. Each job is safe to run on several API instances at once
 * (every state change it makes is an atomic conditional update), so no distributed lock
 * is needed. Move to a queue (BullMQ on Redis) when jobs grow beyond simple sweeps.
 */
import { expireUnpaidOrders } from '../services/order/order.service';
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
