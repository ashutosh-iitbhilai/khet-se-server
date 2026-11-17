import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import { env, isProd } from './config/env';
import apiRoutes from './routes';
import { apiLimiter } from './middleware/rateLimit';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { razorpayWebhookHandler } from './routes/order.routes';

/**
 * Builds the Express app without binding a port, so tests can mount it with Supertest.
 */
export function createApp() {
  const app = express();

  // Respect X-Forwarded-* when running behind a load balancer / reverse proxy.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => {
        // Allow same-origin / server-to-server requests (no Origin header).
        if (!origin || env.CLIENT_ORIGINS.includes(origin)) return cb(null, true);
        cb(new Error(`Origin ${origin} not allowed by CORS`));
      },
      credentials: true,
    }),
  );
  app.use(compression());
  // Webhook signatures are computed over the exact bytes sent, so this route gets the raw body.
  app.post('/api/payments/razorpay/webhook', express.raw({ type: 'application/json', limit: '256kb' }), razorpayWebhookHandler);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser());
  if (env.NODE_ENV !== 'test') app.use(morgan(isProd ? 'combined' : 'dev'));

  app.use('/api', apiLimiter, apiRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
