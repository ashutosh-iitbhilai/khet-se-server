import { describe, expect, it } from 'vitest';
import { allowedFrom, deriveOrderStatus, derivePayment, stockEffect } from './rules';

describe('transitions', () => {
  it('farmer: pending → accepted/rejected only', () => {
    expect(allowedFrom('farmer', 'accepted')).toEqual(['pending']);
    expect(allowedFrom('farmer', 'rejected')).toEqual(['pending']);
  });
  it('farmer can only mark delivered from out_for_delivery', () => {
    expect(allowedFrom('farmer', 'delivered')).toEqual(['out_for_delivery']);
  });
  it('customer can only cancel pending groups', () => {
    expect(allowedFrom('customer', 'cancelled')).toEqual(['pending']);
    expect(allowedFrom('customer', 'accepted')).toEqual([]);
  });
  it('stock effects', () => {
    expect(stockEffect('cancelled')).toBe('release');
    expect(stockEffect('rejected')).toBe('release');
    expect(stockEffect('delivered')).toBe('consume');
    expect(stockEffect('packed')).toBeNull();
  });
});

describe('deriveOrderStatus', () => {
  it('placed while everything is pending', () => expect(deriveOrderStatus(['pending', 'pending'])).toBe('placed'));
  it('in progress once any farm acts', () => expect(deriveOrderStatus(['pending', 'accepted'])).toBe('in_progress'));
  it('completed when all live groups delivered, ignoring rejected ones', () =>
    expect(deriveOrderStatus(['delivered', 'rejected'])).toBe('completed'));
  it('cancelled when nothing is left', () => expect(deriveOrderStatus(['rejected', 'cancelled'])).toBe('cancelled'));
});

describe('derivePayment', () => {
  it('COD becomes paid when every live group is delivered', () => {
    expect(derivePayment('cod', 'cod_pending', [{ status: 'delivered', total: 100 }, { status: 'rejected', total: 50 }])).toEqual({
      paymentStatus: 'paid',
      refundDue: 0,
    });
  });
  it('COD stays pending while a group is on its way', () => {
    expect(derivePayment('cod', 'cod_pending', [{ status: 'delivered', total: 100 }, { status: 'packed', total: 50 }]).paymentStatus).toBe('cod_pending');
  });
  it('paid online order with a rejected farm owes a refund for that farm', () => {
    expect(derivePayment('online', 'paid', [{ status: 'accepted', total: 120 }, { status: 'rejected', total: 80.5 }])).toEqual({
      paymentStatus: 'refund_pending',
      refundDue: 80.5,
    });
  });
  it('unpaid online order with everything cancelled needs no payment', () => {
    expect(derivePayment('online', 'pending', [{ status: 'cancelled', total: 120 }]).paymentStatus).toBe('cancelled');
  });
});
