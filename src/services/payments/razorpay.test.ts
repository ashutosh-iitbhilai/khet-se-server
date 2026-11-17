import crypto from 'crypto';
import { describe, expect, it } from 'vitest';
import { verifyCheckoutSignature, verifyWebhookSignature } from './razorpay';

const secret = 'test_secret_123';
const hmac = (data: string | Buffer) => crypto.createHmac('sha256', secret).update(data).digest('hex');

describe('Razorpay signatures', () => {
  it('accepts a valid checkout signature', () => {
    const sig = hmac('order_ABC|pay_XYZ');
    expect(verifyCheckoutSignature('order_ABC', 'pay_XYZ', sig, secret)).toBe(true);
  });
  it('rejects a signature for a different payment', () => {
    const sig = hmac('order_ABC|pay_OTHER');
    expect(verifyCheckoutSignature('order_ABC', 'pay_XYZ', sig, secret)).toBe(false);
  });
  it('rejects garbage and empty secrets', () => {
    expect(verifyCheckoutSignature('order_ABC', 'pay_XYZ', 'not-hex!', secret)).toBe(false);
    expect(verifyCheckoutSignature('order_ABC', 'pay_XYZ', hmac('order_ABC|pay_XYZ'), '')).toBe(false);
  });
  it('verifies webhook bodies byte-for-byte', () => {
    const body = Buffer.from('{"event":"payment.captured"}');
    expect(verifyWebhookSignature(body, hmac(body), secret)).toBe(true);
    expect(verifyWebhookSignature(Buffer.from('{"event":"payment.captured" }'), hmac(body), secret)).toBe(false);
  });
});
