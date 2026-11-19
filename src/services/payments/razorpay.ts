/**
 * Minimal Razorpay integration over its REST API (no SDK needed).
 * Docs: https://razorpay.com/docs/payments/server-integration/nodejs/
 */
import crypto from 'crypto';
import { env } from '../../config/env';
import { ApiError } from '../../utils/ApiError';

export const razorpayEnabled = () => Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);

export interface RazorpayOrder {
  id: string;
  amount: number; // paise
  currency: string;
  status: string;
}

const API = 'https://api.razorpay.com/v1';
const authHeader = () => `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64')}`;

export interface RazorpayPayment {
  id: string;
  order_id: string;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  amount: number; // paise
}

/**
 * All payment attempts made against a Razorpay order. Used to reconcile orders whose
 * browser callback and webhook never arrived. Throws if Razorpay can't be reached.
 */
export async function fetchOrderPayments(razorpayOrderId: string): Promise<RazorpayPayment[]> {
  const res = await fetch(`${API}/orders/${encodeURIComponent(razorpayOrderId)}/payments`, {
    headers: { Authorization: authHeader() },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  const json = res ? await res.json().catch(() => null) : null;
  if (!res?.ok || !Array.isArray(json?.items)) {
    throw new ApiError(502, 'PAYMENT_PROVIDER_ERROR', 'Could not check payment status with Razorpay');
  }
  return json.items as RazorpayPayment[];
}

export async function createRazorpayOrder(amountInr: number, receipt: string, notes: Record<string, string>): Promise<RazorpayOrder> {
  const res = await fetch(`${API}/orders`, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: Math.round(amountInr * 100), currency: 'INR', receipt, notes }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);

  const json = res ? await res.json().catch(() => null) : null;
  if (!res?.ok || !json?.id) {
    throw new ApiError(502, 'PAYMENT_PROVIDER_ERROR', 'Online payment is unavailable right now. Please try again or choose cash on delivery.');
  }
  return json as RazorpayOrder;
}

/** Constant-time comparison of two hex HMACs. */
function safeEqualHex(a: string, b: string) {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
}

/** Signature returned to the browser after checkout: HMAC_SHA256(order_id + "|" + payment_id, key_secret). */
export function verifyCheckoutSignature(orderId: string, paymentId: string, signature: string, secret = env.RAZORPAY_KEY_SECRET) {
  if (!secret || !/^[a-f0-9]+$/i.test(signature)) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
  return safeEqualHex(expected, signature);
}

/** Webhook signature: HMAC_SHA256(raw request body, webhook_secret) in X-Razorpay-Signature. */
export function verifyWebhookSignature(rawBody: Buffer, signature: string, secret = env.RAZORPAY_WEBHOOK_SECRET) {
  if (!secret || !/^[a-f0-9]+$/i.test(signature)) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqualHex(expected, signature);
}
