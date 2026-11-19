import { Schema, model, type Types } from 'mongoose';
import { jsonTransform } from './common';

/**
 * Audit trail: one record per admin action (verification decisions, suspensions, admin
 * cancellations, refunds recorded). Never updated or deleted by the app.
 */
export const ADMIN_ACTIONS = [
  'farmer.profile.verified',
  'farmer.profile.rejected',
  'farmer.organic.verified',
  'farmer.organic.rejected',
  'user.suspended',
  'user.reactivated',
  'order.group.cancelled',
  'order.refund.recorded',
] as const;
export type AdminActionType = (typeof ADMIN_ACTIONS)[number];

export interface IAdminAction {
  admin: Types.ObjectId;
  action: AdminActionType;
  targetType: 'user' | 'farmer' | 'order';
  targetId: Types.ObjectId;
  /** Human-readable target, e.g. "Order KS261119-ABCDE" or "Meena Patel (farmer)". */
  targetLabel: string;
  note?: string;
  details?: Record<string, unknown>;
  createdAt: Date;
}

const adminActionSchema = new Schema<IAdminAction>(
  {
    admin: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    action: { type: String, enum: ADMIN_ACTIONS, required: true },
    targetType: { type: String, enum: ['user', 'farmer', 'order'], required: true },
    targetId: { type: Schema.Types.ObjectId, required: true },
    targetLabel: { type: String, required: true },
    note: { type: String, maxlength: 500 },
    details: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false }, toJSON: jsonTransform },
);

adminActionSchema.index({ createdAt: -1 });
adminActionSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });

export const AdminAction = model<IAdminAction>('AdminAction', adminActionSchema);
