import mongoose from 'mongoose';
import { env } from './env';
import { logger } from '../utils/logger';

mongoose.set('strictQuery', true);
// Index builds at startup are convenient locally but race with deploys and other instances
// in production; there, `npm run db:indexes` applies index changes once, explicitly.
mongoose.set('autoIndex', env.MONGO_AUTO_INDEX ? env.MONGO_AUTO_INDEX === 'true' : env.NODE_ENV !== 'production');

let transactions = false;

/** True when connected to a replica set or sharded cluster (multi-document transactions available). */
export const transactionsSupported = () => transactions;

export async function connectDatabase(): Promise<void> {
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));

  await mongoose.connect(env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10_000,
    maxPoolSize: 20,
  });

  const hello = (await mongoose.connection.db!.admin().command({ hello: 1 })) as { setName?: string; msg?: string };
  transactions = Boolean(hello.setName) || hello.msg === 'isdbgrid';

  logger.info(`MongoDB connected → ${mongoose.connection.host}/${mongoose.connection.name}`);
  if (!transactions) {
    logger.warn(
      'MongoDB is a standalone server: multi-document transactions are unavailable. Checkout falls back to ' +
        'atomic per-document stock updates with compensation. Use a replica set in production (see README).',
    );
  }
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.connection.close();
}
