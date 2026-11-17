import mongoose, { type ClientSession } from 'mongoose';
import { transactionsSupported } from '../config/db';

/**
 * Runs `fn` inside a MongoDB transaction when the deployment supports it.
 * On a standalone server `fn` receives `undefined` and must compensate its own partial writes
 * (every write here is a conditional single-document update, so that is always possible).
 *
 * Note: `withTransaction` may retry `fn` on transient errors, so `fn` must only have
 * database side effects.
 */
export async function withTransaction<T>(fn: (session: ClientSession | undefined) => Promise<T>): Promise<T> {
  if (!transactionsSupported()) return fn(undefined);

  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
