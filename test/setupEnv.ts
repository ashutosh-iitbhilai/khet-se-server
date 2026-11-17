import { inject } from 'vitest';

/**
 * Runs before each test file is imported: config/env.ts validates process.env at import
 * time, so everything it needs must be set here. Each file gets a fresh database.
 */
const base = new URL(inject('mongoUri'));
base.pathname = `/khetse_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = base.toString();
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-validation-1234';
process.env.CLIENT_ORIGINS = 'http://localhost:3000';
process.env.ROAD_DISTANCE_ENABLED = 'false';
// Online payments are off unless a test file switches them on explicitly.
process.env.RAZORPAY_KEY_ID ??= '';
process.env.RAZORPAY_KEY_SECRET ??= '';
process.env.RAZORPAY_WEBHOOK_SECRET ??= '';
