import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

/**
 * All environment variables are validated once at boot.
 * The process exits early with a readable message if anything is missing.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  CLIENT_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),

  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  // Build indexes automatically when the app starts. Defaults to on in development/test and
  // off in production, where `npm run db:indexes` applies index changes as a deploy step.
  MONGO_AUTO_INDEX: z.enum(['true', 'false']).optional(),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  // Short-lived access token (sent with every request) + long-lived, revocable refresh token.
  ACCESS_TOKEN_TTL: z.string().regex(/^\d+[smhd]$/, 'Use a duration like 15m or 1h').default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** @deprecated Replaced by ACCESS_TOKEN_TTL + refresh sessions; ignored if set. */
  JWT_EXPIRES_IN: z.string().optional(),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  REDIS_URL: z.string().optional().default(''),
  // Hosts farmers' photo links may point at (comma-separated). Uploads go to Cloudinary.
  ALLOWED_IMAGE_HOSTS: z
    .string()
    .default('res.cloudinary.com,images.unsplash.com,upload.wikimedia.org')
    .transform((v) => v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)),
  CLOUDINARY_CLOUD_NAME: z.string().optional().default(''),
  CLOUDINARY_API_KEY: z.string().optional().default(''),
  CLOUDINARY_API_SECRET: z.string().optional().default(''),
  OSRM_URL: z.string().url().default('https://router.project-osrm.org'),
  // Hours a farmer has to accept a new order before it is cancelled and its stock released.
  FARMER_ACCEPT_HOURS: z.coerce.number().min(1).max(168).default(24),
  // Online payments (Razorpay). Leave empty to offer cash on delivery only.
  RAZORPAY_KEY_ID: z.string().optional().default(''),
  RAZORPAY_KEY_SECRET: z.string().optional().default(''),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional().default(''),
  // Road distance via OSRM for the top results. Off by default: the public OSRM demo
  // server is for light use only — point OSRM_URL at your own instance before enabling.
  ROAD_DISTANCE_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  REC_DEFAULT_RADIUS_KM: z.coerce.number().min(1).max(50).default(8),
  REC_MAX_RADIUS_KM: z.coerce.number().min(1).max(100).default(25),
  NOMINATIM_URL: z.string().url().default('https://nominatim.openstreetmap.org'),
  // Nominatim's usage policy requires an identifying User-Agent for your deployment.
  NOMINATIM_USER_AGENT: z.string().min(3).default('KhetSe/0.1 (development)'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('❌ Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    // eslint-disable-next-line no-console
    console.error(`   • ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;

if (env.JWT_EXPIRES_IN) {
  // eslint-disable-next-line no-console
  console.warn('⚠️  JWT_EXPIRES_IN is no longer used. Sessions now use ACCESS_TOKEN_TTL (default 15m) and REFRESH_TOKEN_TTL_DAYS (default 30).');
}
export const isProd = env.NODE_ENV === 'production';
