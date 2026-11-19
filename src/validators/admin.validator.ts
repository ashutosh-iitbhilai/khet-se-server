import { z } from 'zod';
import { USER_ROLES } from '../models/User';
import { GROUP_STATUSES, ORDER_STATUSES, PAYMENT_STATUSES } from '../models/Order';
import { booleanQuery, dateInput, idParams, objectId, pagination } from './common';

const note = z.string().trim().max(500);

export const listUsersSchema = z.object({
  query: z.object({ role: z.enum(USER_ROLES).optional(), status: z.enum(['active', 'suspended']).optional(), q: z.string().trim().max(80).optional(), ...pagination }),
});

export const userIdSchema = z.object({ params: idParams });

export const setStatusSchema = z.object({
  params: idParams,
  body: z.object({ status: z.enum(['active', 'suspended']), reason: note.min(3, 'Give a reason (it is kept in the audit trail)') }),
});

export const verificationQueueSchema = z.object({ query: z.object({ kind: z.enum(['profile', 'organic', 'all']).default('all'), ...pagination }) });

export const decideVerificationSchema = z.object({
  params: idParams,
  body: z
    .object({ profile: z.enum(['verified', 'rejected']).optional(), organic: z.enum(['verified', 'rejected']).optional(), note: note.optional() })
    .refine((b) => b.profile || b.organic, 'Choose a decision'),
});

export const listOrdersSchema = z.object({
  query: z.object({
    status: z.enum(ORDER_STATUSES).optional(),
    paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
    paymentMethod: z.enum(['cod', 'online']).optional(),
    refunds: booleanQuery.optional(),
    q: z.string().trim().max(60).optional(),
    from: dateInput.optional(),
    to: dateInput.optional(),
    ...pagination,
  }),
});

export const orderIdSchema = z.object({ params: idParams });

export const cancelGroupSchema = z.object({
  params: z.object({ id: objectId, groupId: objectId }),
  body: z.object({ note: note.min(3, 'Give a reason; the customer and farmer see it') }),
});

export const recordRefundSchema = z.object({
  params: idParams,
  body: z.object({ amount: z.coerce.number().positive().max(1_000_000), reference: z.string().trim().max(100).optional(), note: note.optional() }),
});

export const listPaymentsSchema = z.object({
  query: z.object({ provider: z.enum(['cod', 'razorpay']).optional(), status: z.enum(['created', 'paid', 'failed', 'cancelled']).optional(), ...pagination }),
});

export const auditSchema = z.object({ query: z.object({ ...pagination }) });

export const GROUP_STATUS_VALUES = GROUP_STATUSES;
