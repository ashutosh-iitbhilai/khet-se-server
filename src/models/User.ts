import { Schema, model, type HydratedDocument, type Model } from 'mongoose';
import bcrypt from 'bcryptjs';

export const USER_ROLES = ['customer', 'farmer', 'delivery', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ['active', 'suspended'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export interface IUser {
  name: string;
  /** Optional: accounts can be mobile-only. Unique when present. */
  email?: string;
  phone?: string;
  /** Absent for accounts created with Google until the user sets a password. */
  passwordHash?: string;
  /** Google account id ("sub") once the user signs in with Google. */
  googleId?: string;
  role: UserRole;
  status: UserStatus;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface IUserMethods {
  comparePassword(plain: string): Promise<boolean>;
}

type UserModel = Model<IUser, object, IUserMethods>;
export type UserDocument = HydratedDocument<IUser, IUserMethods>;

const userSchema = new Schema<IUser, UserModel, IUserMethods>(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
    email: {
      type: String,
      lowercase: true,
      trim: true,
      match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    },
    // Indian mobile numbers, stored as 10 digits
    phone: { type: String, trim: true, match: /^[6-9]\d{9}$/ },
    passwordHash: { type: String, select: false },
    googleId: { type: String, select: false },
    role: { type: String, enum: USER_ROLES, default: 'customer', index: true },
    status: { type: String, enum: USER_STATUSES, default: 'active' },
    lastLoginAt: Date,
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        delete ret.passwordHash;
        delete ret.googleId;
        return ret;
      },
    },
  },
);

// Mobile number and email each identify an account and must be unique when present
// (Google accounts may start without a phone; mobile-only accounts have no email).
userSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: 'string' } } });
userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });

userSchema.index({ googleId: 1 }, { unique: true, partialFilterExpression: { googleId: { $type: 'string' } } });

userSchema.methods.comparePassword = function (plain: string) {
  // Google-only accounts have no password until they set one with "forgot password".
  if (!this.passwordHash) return Promise.resolve(false);
  return bcrypt.compare(plain, this.passwordHash);
};

export const User = model<IUser, UserModel>('User', userSchema);
