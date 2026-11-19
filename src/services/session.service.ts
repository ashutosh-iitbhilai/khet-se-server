import crypto from 'crypto';
import { Types } from 'mongoose';
import { Session } from '../models/Session';
import { User, type UserDocument } from '../models/User';
import { env } from '../config/env';
import { ApiError } from '../utils/ApiError';
import { logger } from '../utils/logger';
import { signToken } from '../utils/jwt';

/**
 * Refresh token format: "<sessionId>.<secret>". The id finds the session; the secret is
 * compared (constant-time) against the stored SHA-256 hash.
 */
const hash = (secret: string) => crypto.createHash('sha256').update(secret).digest('hex');

/** A refresh that races another refresh of the same token (two tabs) within this window is allowed. */
const ROTATION_GRACE_MS = 30_000;

export interface SessionMeta {
  userAgent?: string;
  ip?: string;
}

export interface IssuedTokens {
  user: UserDocument;
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
}

async function createSession(user: UserDocument, family: Types.ObjectId, meta: SessionMeta): Promise<IssuedTokens> {
  const secret = crypto.randomBytes(32).toString('base64url');
  const refreshExpiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  const session = await Session.create({
    user: user._id,
    family,
    tokenHash: hash(secret),
    expiresAt: refreshExpiresAt,
    userAgent: meta.userAgent?.slice(0, 300),
    ip: meta.ip?.slice(0, 64),
  });
  return {
    user,
    accessToken: signToken({ sub: user.id, role: user.role, sid: session.id }),
    refreshToken: `${session.id}.${secret}`,
    refreshExpiresAt,
  };
}

/** Starts a new session family (login / registration). */
export function startSession(user: UserDocument, meta: SessionMeta) {
  return createSession(user, new Types.ObjectId(), meta);
}

function parse(token: string | undefined): { id: string; secret: string } | null {
  const [id, secret, extra] = (token ?? '').split('.');
  if (!id || !secret || extra !== undefined || !Types.ObjectId.isValid(id)) return null;
  return { id, secret };
}

function secretMatches(secret: string, tokenHash: string) {
  const a = Buffer.from(hash(secret), 'hex');
  const b = Buffer.from(tokenHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const invalid = () => new ApiError(401, 'SESSION_INVALID', 'Your session has ended. Please log in again.');

/**
 * Exchanges a refresh token for a new access token + refresh token (rotation).
 * Re-checks that the account is still active, so suspension takes effect at the next refresh.
 */
export async function rotate(token: string | undefined, meta: SessionMeta): Promise<IssuedTokens> {
  const parsed = parse(token);
  if (!parsed) throw invalid();
  const session = await Session.findById(parsed.id);
  if (!session || !secretMatches(parsed.secret, session.tokenHash) || session.expiresAt <= new Date()) throw invalid();

  if (session.revokedAt) {
    const raced = session.revokedReason === 'rotated' && Date.now() - session.revokedAt.getTime() < ROTATION_GRACE_MS;
    if (!raced) {
      // A token that was already exchanged is being replayed: assume it was stolen.
      if (session.revokedReason === 'rotated') {
        await Session.updateMany({ family: session.family, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: 'reuse_detected' } });
        logger.warn(`Refresh token reuse detected — revoked session family ${String(session.family)} for user ${String(session.user)}`);
      }
      throw invalid();
    }
  }

  const user = await User.findById(session.user);
  if (!user || user.status !== 'active') {
    await Session.updateMany({ user: session.user, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: 'suspended' } });
    throw new ApiError(401, 'ACCOUNT_SUSPENDED', 'This account has been suspended. Please contact support.');
  }

  const next = await createSession(user, session.family, meta);
  // Retire the old session only if nobody else did first (atomic), keeping the chain linear.
  await Session.updateOne(
    { _id: session._id, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: 'rotated', replacedBy: new Types.ObjectId(next.refreshToken.split('.')[0]), lastUsedAt: new Date() } },
  );
  return next;
}

/** Ends the session behind a refresh token (logout). Unknown or invalid tokens are ignored. */
export async function endSession(token: string | undefined) {
  const parsed = parse(token);
  if (!parsed) return;
  const session = await Session.findById(parsed.id);
  if (session && secretMatches(parsed.secret, session.tokenHash)) {
    await Session.updateMany({ family: session.family, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: 'logout' } });
  }
}

/** Signs a user out everywhere (all devices). Access tokens already issued expire within ACCESS_TOKEN_TTL. */
export async function endAllSessions(userId: string | Types.ObjectId, reason: 'logout_all' | 'suspended' | 'password_reset' = 'logout_all') {
  const res = await Session.updateMany({ user: userId, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: reason } });
  return res.modifiedCount;
}
