import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

/**
 * A login session backing a refresh token. Only a SHA-256 hash of the token secret is
 * stored. Each refresh replaces the session with a new one in the same `family`; if a
 * replaced token is ever presented again (outside a short grace window), the whole family
 * is revoked — the signature of a stolen refresh token.
 */
export interface ISession {
  user: Types.ObjectId;
  family: Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  revokedAt?: Date;
  revokedReason?: 'logout' | 'logout_all' | 'rotated' | 'reuse_detected' | 'suspended';
  replacedBy?: Types.ObjectId;
  userAgent?: string;
  ip?: string;
  lastUsedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type SessionDocument = HydratedDocument<ISession>;

const sessionSchema = new Schema<ISession>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    family: { type: Schema.Types.ObjectId, required: true },
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: Date,
    revokedReason: { type: String, enum: ['logout', 'logout_all', 'rotated', 'reuse_detected', 'suspended'] },
    replacedBy: { type: Schema.Types.ObjectId },
    userAgent: { type: String, maxlength: 300 },
    ip: { type: String, maxlength: 64 },
    lastUsedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);

// MongoDB removes sessions once they have expired.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
sessionSchema.index({ user: 1, revokedAt: 1 });
sessionSchema.index({ family: 1 });

export const Session = model<ISession>('Session', sessionSchema);
