import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { env } from '../config/env';
import { PasswordReset } from '../models/PasswordReset';
import { User } from '../models/User';
import { ApiError } from '../utils/ApiError';
import { logger } from '../utils/logger';
import { layout, sendEmail } from './email.service';
import { endAllSessions } from './session.service';

const BCRYPT_ROUNDS = 12;
/** One email per account per minute, however often the form is submitted. */
const RESEND_COOLDOWN_MS = 60_000;

const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/**
 * Starts a password reset. Always resolves the same way whether or not the email belongs to
 * an account, so the endpoint can't be used to discover who is registered. The email is sent
 * in the background so the response time doesn't reveal it either.
 */
export async function requestReset(who: { email: string } | { phone: string }, meta: { ip?: string } = {}): Promise<void> {
  const user = await User.findOne({ ...who, status: 'active' }, '_id name email');
  // Mobile-only accounts have no email to send to (SMS reset is not set up yet).
  if (!user?.email) return;

  const recent = await PasswordReset.exists({ user: user._id, usedAt: null, createdAt: { $gt: new Date(Date.now() - RESEND_COOLDOWN_MS) } });
  if (recent) return;

  // Only the newest link works.
  await PasswordReset.deleteMany({ user: user._id, usedAt: null });

  const token = crypto.randomBytes(32).toString('base64url');
  await PasswordReset.create({
    user: user._id,
    tokenHash: hash(token),
    expiresAt: new Date(Date.now() + env.PASSWORD_RESET_TTL_MINUTES * 60_000),
    ip: meta.ip,
  });

  const url = `${env.WEB_URL}/reset-password?token=${encodeURIComponent(token)}`;
  const minutes = env.PASSWORD_RESET_TTL_MINUTES;
  const mail = {
    to: user.email,
    subject: 'Reset your Khet Se password',
    text: `Namaste ${user.name},\n\nSomeone (hopefully you) asked to reset the password for your Khet Se account.\nOpen this link within ${minutes} minutes to choose a new password:\n\n${url}\n\nIf you didn't ask for this, ignore this email. Your password won't change.`,
    html: layout({
      heading: 'Reset your password',
      paragraphs: [`Namaste ${user.name},`, 'Someone (hopefully you) asked to reset the password for your Khet Se account.'],
      button: { label: 'Choose a new password', url },
      footer: `This link works once and expires in ${minutes} minutes. If you didn't ask for it, ignore this email. Your password won't change.`,
    }),
  };
  const send = sendEmail(mail).catch((err) => logger.error(`Password reset email to user ${user._id} failed`, err));
  // Tests await delivery; real requests don't wait (timing would reveal that the account exists).
  if (env.NODE_ENV === 'test') await send;
}

/**
 * Sets a new password from a reset link. The link is single-use (claimed atomically), and every
 * existing session is ended so anyone signed in with the old password is logged out.
 */
export async function resetPassword(token: string, password: string): Promise<void> {
  const now = new Date();
  const reset = await PasswordReset.findOneAndUpdate(
    { tokenHash: hash(token), usedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
    { new: true },
  );
  if (!reset) throw new ApiError(400, 'INVALID_RESET_TOKEN', 'This reset link is invalid, already used or expired. Please request a new one.');

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = await User.findByIdAndUpdate(reset.user, { $set: { passwordHash } });
  if (!user) throw new ApiError(400, 'INVALID_RESET_TOKEN', 'This reset link is invalid, already used or expired. Please request a new one.');

  await PasswordReset.deleteMany({ user: reset.user, usedAt: null });
  const ended = await endAllSessions(reset.user, 'password_reset');
  logger.info(`Password reset for user ${reset.user} (${ended} sessions ended)`);
}
