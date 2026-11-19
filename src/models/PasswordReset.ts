import { Schema, model, type Types } from 'mongoose';

/**
 * One "forgot password" link. Only the SHA-256 of the token is stored, so a database leak
 * does not expose working links. Documents expire on their own (TTL index).
 */
export interface IPasswordReset {
  user: Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  usedAt?: Date;
  ip?: string;
  createdAt: Date;
}

const passwordResetSchema = new Schema<IPasswordReset>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: Date,
    ip: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Remove a day after expiry (kept briefly so "link already used / expired" can be told apart in logs).
passwordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86_400 });

export const PasswordReset = model<IPasswordReset>('PasswordReset', passwordResetSchema);
