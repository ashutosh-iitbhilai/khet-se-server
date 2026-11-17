/**
 * Pure order rules — which status changes are allowed, and how the order-level status and
 * payment status follow from its groups. No I/O, so they are unit-tested directly.
 */
import type { GroupStatus, OrderStatus, PaymentMethod, PaymentStatus } from '../../models/Order';

export type Actor = 'customer' | 'farmer' | 'system' | 'admin';

/** Allowed transitions: target status → statuses it may come from, per actor. */
export const TRANSITIONS: Record<Actor, Partial<Record<GroupStatus, GroupStatus[]>>> = {
  farmer: {
    accepted: ['pending'],
    rejected: ['pending'],
    packed: ['accepted'],
    out_for_delivery: ['accepted', 'packed'],
    delivered: ['out_for_delivery'],
    cancelled: ['accepted', 'packed'],
  },
  // Customers can cancel only before the farmer has accepted.
  customer: { cancelled: ['pending'] },
  system: { cancelled: ['pending'] },
  admin: {
    cancelled: ['pending', 'accepted', 'packed', 'out_for_delivery'],
  },
};

export function allowedFrom(actor: Actor, to: GroupStatus): GroupStatus[] {
  return TRANSITIONS[actor][to] ?? [];
}

/** Stock side effect of moving a group into `to`. */
export function stockEffect(to: GroupStatus): 'release' | 'consume' | null {
  if (to === 'rejected' || to === 'cancelled') return 'release';
  if (to === 'delivered') return 'consume';
  return null;
}

const CLOSED_NEGATIVE: GroupStatus[] = ['rejected', 'cancelled'];

export function deriveOrderStatus(statuses: GroupStatus[]): OrderStatus {
  const live = statuses.filter((s) => !CLOSED_NEGATIVE.includes(s));
  if (live.length === 0) return 'cancelled';
  if (live.every((s) => s === 'delivered')) return 'completed';
  if (live.some((s) => s !== 'pending')) return 'in_progress';
  return 'placed';
}

/**
 * Payment status after a change.
 *  - COD: paid once every live group is delivered (cash collected), cancelled if nothing left.
 *  - Online, already paid: any cancelled/rejected groups become a refund due.
 *  - Online, unpaid: cancelled if nothing left, otherwise still pending.
 */
export function derivePayment(
  method: PaymentMethod,
  current: PaymentStatus,
  groups: { status: GroupStatus; total: number }[],
): { paymentStatus: PaymentStatus; refundDue: number } {
  const live = groups.filter((g) => !CLOSED_NEGATIVE.includes(g.status));
  const cancelledTotal = groups.filter((g) => CLOSED_NEGATIVE.includes(g.status)).reduce((s, g) => s + g.total, 0);

  if (method === 'cod') {
    if (live.length === 0) return { paymentStatus: 'cancelled', refundDue: 0 };
    return { paymentStatus: live.every((g) => g.status === 'delivered') ? 'paid' : 'cod_pending', refundDue: 0 };
  }
  if (current === 'paid' || current === 'refund_pending') {
    const refundDue = Math.round(cancelledTotal * 100) / 100;
    return { paymentStatus: refundDue > 0 ? 'refund_pending' : 'paid', refundDue };
  }
  if (live.length === 0) return { paymentStatus: 'cancelled', refundDue: 0 };
  return { paymentStatus: current, refundDue: 0 };
}
