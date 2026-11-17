import { env } from './config/env';
import { connectDatabase, disconnectDatabase } from './config/db';
import { createApp } from './app';
import { initCache } from './config/cache';
import { startJobs, stopJobs } from './jobs';
import { logger } from './utils/logger';

async function bootstrap() {
  await connectDatabase();
  initCache();

  startJobs();
  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`Khet Se API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  });

  // Graceful shutdown so in-flight requests finish during deploys / scaling events.
  const shutdown = (signal: string) => {
    logger.info(`${signal} received — shutting down`);
    stopJobs();
    server.close(async () => {
      await disconnectDatabase();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  logger.error('Failed to start server', err);
  process.exit(1);
});
